import {
  DEFAULT_POLL_BACKOFF_MS,
  DEFAULT_RUNNER_VERSION,
  LONG_POLL_TIMEOUT_MS,
  MAX_POLL_BACKOFF_MS,
} from "../constants.js";
import {
  fetchWithTimeout,
  isTerminalPollError,
  readResponseError,
} from "../http.js";
import { decodeJitConfig, parseRunnerIdentity } from "./jit-config.js";
import { fetchRunnerOAuthToken } from "./auth.js";
import { decryptSessionKey, decodeMessageBody } from "./crypto.js";
import { acquireJob } from "./run-service.js";
import { parseAcquiredJobMetadata } from "./job.js";

/**
 * @typedef {object} BrokerSession
 * @property {string} sessionId
 * @property {string} brokerUrl
 * @property {Buffer|null} sessionKey
 * @property {string} accessToken
 * @property {import("./jit-config.js").RunnerIdentity} identity
 * @property {string} runnerVersion
 */

/**
 * @typedef {object} JobReference
 * @property {number} messageId
 * @property {string} messageType
 * @property {string} runnerRequestId
 * @property {string} runServiceUrl
 * @property {string} billingOwnerId
 */

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {typeof fetch} fetchImpl
 */
async function brokerFetch(url, init, fetchImpl) {
  return fetchWithTimeout(url, init, fetchImpl, LONG_POLL_TIMEOUT_MS);
}

/**
 * @param {import("./jit-config.js").RunnerIdentity} identity
 * @param {string} accessToken
 * @param {string} runnerVersion
 * @param {typeof fetch} fetchImpl
 */
export async function createBrokerSession(
  identity,
  accessToken,
  runnerVersion = DEFAULT_RUNNER_VERSION,
  fetchImpl = fetch
) {
  const response = await brokerFetch(
    `${identity.brokerUrl}/session`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ownerName: identity.agentName,
        agent: {
          id: identity.agentId,
          name: identity.agentName,
          version: runnerVersion,
        },
        useFipsEncryption: false,
      }),
    },
    fetchImpl
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Broker CreateSession failed (${response.status}): ${responseText}`
    );
  }

  const parsed = JSON.parse(responseText);
  const sessionId = parsed.sessionId ?? parsed.SessionId;
  if (!sessionId) {
    throw new Error("Broker CreateSession response missing sessionId");
  }

  const encryptionKeyValue =
    parsed.encryptionKey?.value ??
    parsed.encryptionKey?.Value ??
    parsed.EncryptionKey?.value ??
    parsed.EncryptionKey?.Value;

  let sessionKey = null;
  if (encryptionKeyValue) {
    const encryptedKey = Buffer.isBuffer(encryptionKeyValue)
      ? encryptionKeyValue
      : Buffer.from(encryptionKeyValue, "base64");
    sessionKey = decryptSessionKey(encryptedKey, identity.privateKey);
  }

  return {
    sessionId: String(sessionId),
    brokerUrl: String(
      parsed.brokerURL ?? parsed.BrokerURL ?? identity.brokerUrl
    ).replace(/\/$/, ""),
    sessionKey,
    accessToken,
    identity,
    runnerVersion,
  };
}

/**
 * @param {string} bodyText
 * @returns {Omit<JobReference, "messageId" | "messageType">}
 */
export function parseJobReferenceBody(bodyText) {
  const parsed = JSON.parse(bodyText);
  const runnerRequestId = String(parsed.runner_request_id ?? "");
  const runServiceUrl = String(parsed.run_service_url ?? "");
  const billingOwnerId = String(parsed.billing_owner_id ?? "");
  if (!runnerRequestId || !runServiceUrl) {
    throw new Error("Job reference body missing runner_request_id or run_service_url");
  }
  return { runnerRequestId, runServiceUrl, billingOwnerId };
}

/**
 * @param {BrokerSession} session
 * @param {JobReference} jobReference
 * @param {typeof fetch} fetchImpl
 */
export async function acknowledgeJobRequest(
  session,
  jobReference,
  fetchImpl = fetch
) {
  const params = new URLSearchParams({
    sessionId: session.sessionId,
    runnerVersion: session.runnerVersion,
    status: "online",
    disableUpdate: "true",
  });
  const response = await fetchImpl(
    `${session.brokerUrl}/acknowledge?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runnerRequestId: jobReference.runnerRequestId,
      }),
    }
  );

  if (response.ok || response.status === 204) {
    return;
  }

  throw await readResponseError(response, "Broker Acknowledge failed");
}

/**
 * @param {BrokerSession} session
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal} [signal]
 */
export async function pollForJobReference(session, fetchImpl = fetch, signal) {
  let consecutiveErrors = 0;
  const runnerOs = process.platform === "darwin" ? "osx" : process.platform;
  const runnerArch = process.arch === "x64" ? "x64" : process.arch;

  while (!signal?.aborted) {
    const params = new URLSearchParams({
      sessionId: session.sessionId,
      status: "online",
      runnerVersion: session.runnerVersion,
      os: runnerOs,
      architecture: runnerArch,
      disableUpdate: "false",
    });

    try {
      const response = await brokerFetch(
        `${session.brokerUrl}/message?${params.toString()}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${session.accessToken}`,
          },
          signal,
        },
        fetchImpl
      );

      if (response.status === 202) {
        consecutiveErrors = 0;
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Broker message poll unauthorized (${response.status}); refresh OAuth token`
        );
      }

      if (!response.ok) {
        throw await readResponseError(response, "Broker message poll failed");
      }

      consecutiveErrors = 0;
      const message = await response.json();
      const messageType = message.messageType ?? message.MessageType;
      const messageId = message.messageId ?? message.MessageId;
      const messageBody = message.body ?? message.Body;

      if (messageType !== "RunnerJobRequest") {
        throw new Error(
          `Unexpected broker message type: ${messageType ?? "unknown"}`
        );
      }

      const decodedBody = decodeMessageBody(messageBody, session.sessionKey);
      const reference = parseJobReferenceBody(decodedBody);
      return {
        messageId: Number(messageId),
        messageType: String(messageType),
        ...reference,
      };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      if (isTerminalPollError(error)) {
        throw error;
      }

      consecutiveErrors += 1;
      const delayMs = Math.min(
        DEFAULT_POLL_BACKOFF_MS * consecutiveErrors,
        MAX_POLL_BACKOFF_MS
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("Polling aborted before a job reference was received");
}

/**
 * @param {BrokerSession} session
 * @param {typeof fetch} fetchImpl
 */
export async function deleteBrokerSession(session, fetchImpl = fetch) {
  const response = await fetchImpl(`${session.brokerUrl}/session`, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${session.accessToken}`,
    },
  });

  if (response.status === 404 || response.status === 204 || response.ok) {
    return;
  }

  throw await readResponseError(response, "Broker DeleteSession failed");
}

/**
 * @param {string} encodedJitConfig
 * @param {object} [options]
 * @param {string} [options.runnerVersion]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.acquire]
 */
export async function connectAndPollForJobReference(
  encodedJitConfig,
  options = {}
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const runnerVersion =
    options.runnerVersion ??
    process.env.GITHUB_RUNNER_VERSION ??
    DEFAULT_RUNNER_VERSION;

  const files = decodeJitConfig(encodedJitConfig);
  const identity = parseRunnerIdentity(files);
  const accessToken = await fetchRunnerOAuthToken(identity, fetchImpl);
  const session = await createBrokerSession(
    identity,
    accessToken,
    runnerVersion,
    fetchImpl
  );

  try {
    const jobReference = await pollForJobReference(
      session,
      fetchImpl,
      options.signal
    );
    const result = { identity, session, jobReference };
    if (options.acquire) {
      result.acquiredJob = await acquireJob(session, jobReference, fetchImpl);
      result.jobMetadata = parseAcquiredJobMetadata(
        result.acquiredJob.payload,
        jobReference,
        result.acquiredJob.planId
      );
    }
    return result;
  } finally {
    await deleteBrokerSession(session, fetchImpl).catch(() => {});
  }
}

export { DEFAULT_RUNNER_VERSION };
