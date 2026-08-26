/**
 * @file github-runner-client.js
 *
 * Minimal dependency-free client for the GitHub Actions broker listener
 * protocol. Supports JIT config decoding, runner OAuth, broker session
 * creation, long-poll message retrieval, and message-body decryption.
 *
 * This prototype intentionally does not call /acquirejob or acknowledge jobs.
 */

import {
  constants,
  createDecipheriv,
  createPrivateKey,
  createSign,
  privateDecrypt,
  randomUUID,
} from "node:crypto";

const DEFAULT_RUNNER_VERSION = "2.336.0";
const LONG_POLL_TIMEOUT_MS = 55_000;
const DEFAULT_POLL_BACKOFF_MS = 1_000;
const MAX_POLL_BACKOFF_MS = 30_000;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * @typedef {object} JitConfigFiles
 * @property {Record<string, unknown>} runner
 * @property {Record<string, unknown>} credentials
 * @property {Record<string, unknown>} rsaParams
 */

/**
 * @typedef {object} RunnerIdentity
 * @property {number} agentId
 * @property {string} agentName
 * @property {string} brokerUrl
 * @property {number} poolId
 * @property {string} clientId
 * @property {string} authorizationUrl
 * @property {import("node:crypto").KeyObject} privateKey
 */

/**
 * @typedef {object} BrokerSession
 * @property {string} sessionId
 * @property {string} brokerUrl
 * @property {Buffer|null} sessionKey
 * @property {string} accessToken
 * @property {RunnerIdentity} identity
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
 * @param {Buffer} data
 */
function stripBom(data) {
  if (
    data.length >= UTF8_BOM.length &&
    data.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
  ) {
    return data.subarray(UTF8_BOM.length);
  }
  return data;
}

/**
 * @param {string} encoded
 */
function decodeBase64Json(encoded) {
  const text = stripBom(Buffer.from(encoded, "base64")).toString("utf8");
  return JSON.parse(text);
}

/**
 * @param {string} encodedJitConfig
 * @returns {JitConfigFiles}
 */
export function decodeJitConfig(encodedJitConfig) {
  const outer = decodeBase64Json(encodedJitConfig);
  const requiredKeys = [".runner", ".credentials", ".credentials_rsaparams"];
  for (const key of requiredKeys) {
    if (typeof outer[key] !== "string") {
      throw new Error(`JIT config missing ${key}`);
    }
  }

  return {
    runner: decodeBase64Json(outer[".runner"]),
    credentials: decodeBase64Json(outer[".credentials"]),
    rsaParams: decodeBase64Json(outer[".credentials_rsaparams"]),
  };
}

/**
 * @param {Record<string, string>} params
 */
function decodeBigInt(fieldName, value) {
  if (!value) {
    throw new Error(`RSA params missing ${fieldName}`);
  }

  let bytes;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    throw new Error(`RSA params field ${fieldName} is not valid base64`);
  }

  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) + BigInt(byte);
  }
  return result;
}

/**
 * @param {bigint} value
 */
function bigIntToBase64Url(value) {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }
  return Buffer.from(hex, "hex").toString("base64url");
}

/**
 * @param {bigint} value
 * @param {bigint} modulus
 */
function modInverse(value, modulus) {
  let oldValue = value;
  let oldModulus = modulus;
  let oldCoefficient = 1n;
  let coefficient = 0n;

  while (oldModulus !== 0n) {
    const quotient = oldValue / oldModulus;
    [oldValue, oldModulus] = [oldModulus, oldValue - quotient * oldModulus];
    [oldCoefficient, coefficient] = [
      coefficient,
      oldCoefficient - quotient * coefficient,
    ];
  }

  if (oldValue > 1n) {
    throw new Error("RSA params are not invertible");
  }
  if (oldCoefficient < 0n) {
    oldCoefficient += modulus;
  }
  return oldCoefficient;
}

/**
 * @param {Record<string, unknown>} params
 * @param {string} name
 */
function getRsaParam(params, name) {
  if (params[name] != null && params[name] !== "") {
    return String(params[name]);
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(params)) {
    if (key.toLowerCase() === target && value != null && value !== "") {
      return String(value);
    }
  }
  return "";
}

/**
 * @param {Record<string, unknown>} rsaParams
 */
export function reconstructPrivateKey(rsaParams) {
  const modulus = decodeBigInt("Modulus", getRsaParam(rsaParams, "Modulus"));
  const exponent = decodeBigInt("Exponent", getRsaParam(rsaParams, "Exponent"));
  const privateExponent = decodeBigInt("D", getRsaParam(rsaParams, "D"));
  const primeP = decodeBigInt("P", getRsaParam(rsaParams, "P"));
  const primeQ = decodeBigInt("Q", getRsaParam(rsaParams, "Q"));

  const dpValue = getRsaParam(rsaParams, "DP");
  const dqValue = getRsaParam(rsaParams, "DQ");
  const inverseQValue = getRsaParam(rsaParams, "InverseQ");
  const dp = dpValue
    ? decodeBigInt("DP", dpValue)
    : privateExponent % (primeP - 1n);
  const dq = dqValue
    ? decodeBigInt("DQ", dqValue)
    : privateExponent % (primeQ - 1n);
  const qi = inverseQValue
    ? decodeBigInt("InverseQ", inverseQValue)
    : modInverse(primeQ, primeP);

  return createPrivateKey({
    key: {
      kty: "RSA",
      n: bigIntToBase64Url(modulus),
      e: bigIntToBase64Url(exponent),
      d: bigIntToBase64Url(privateExponent),
      p: bigIntToBase64Url(primeP),
      q: bigIntToBase64Url(primeQ),
      dp: bigIntToBase64Url(dp),
      dq: bigIntToBase64Url(dq),
      qi: bigIntToBase64Url(qi),
    },
    format: "jwk",
  });
}

/**
 * @param {Record<string, unknown>} object
 * @param {string[]} keys
 */
function pickField(object, keys) {
  for (const key of keys) {
    const value = object[key];
    if (value != null && value !== "") {
      return value;
    }
  }
  return "";
}

/**
 * @param {JitConfigFiles} files
 */
export function parseRunnerIdentity(files) {
  const runner = files.runner;
  const credentials = files.credentials;
  const data = /** @type {Record<string, unknown>} */ (
    credentials.data ?? credentials.Data ?? credentials
  );

  const clientId = String(
    pickField(data, ["clientId", "ClientId"]) ||
      pickField(credentials, ["clientId", "ClientId"])
  );
  const authorizationUrl = String(
    pickField(data, ["authorizationUrl", "AuthorizationUrl"]) ||
      pickField(credentials, ["authorizationUrl", "AuthorizationUrl"])
  );
  if (!clientId || !authorizationUrl) {
    throw new Error("Runner credentials missing clientId or authorizationUrl");
  }

  const brokerUrl = String(
    pickField(runner, ["serverUrlV2", "ServerUrlV2", "serverUrl", "ServerUrl"])
  );
  if (!brokerUrl) {
    throw new Error("Runner config missing serverUrl/serverUrlV2");
  }

  const agentId = Number(
    pickField(runner, ["agentId", "AgentId"]) || 0
  );
  const agentName = String(
    pickField(runner, ["agentName", "AgentName"])
  );
  if (!agentId || !agentName) {
    throw new Error("Runner config missing agentId or agentName");
  }

  return {
    agentId,
    agentName,
    brokerUrl: brokerUrl.replace(/\/$/, ""),
    poolId: Number(runner.poolId ?? 1),
    clientId,
    authorizationUrl,
    privateKey: reconstructPrivateKey(files.rsaParams),
  };
}

/**
 * @param {string} headerB64
 * @param {string} payloadB64
 * @param {import("node:crypto").KeyObject} privateKey
 */
function signJwt(headerB64, payloadB64, privateKey) {
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * @param {RunnerIdentity} identity
 * @param {typeof fetch} fetchImpl
 */
export async function fetchRunnerOAuthToken(identity, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: identity.clientId,
      iss: identity.clientId,
      aud: identity.authorizationUrl,
      nbf: now,
      exp: now + 300,
      jti: randomUUID(),
    })
  ).toString("base64url");

  const assertion = signJwt(header, payload, identity.privateKey);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });

  const response = await fetchImpl(identity.authorizationUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Runner OAuth token exchange failed (${response.status}): ${responseText}`
    );
  }

  const parsed = JSON.parse(responseText);
  if (!parsed.access_token) {
    throw new Error("Runner OAuth token response missing access_token");
  }
  return parsed.access_token;
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {typeof fetch} fetchImpl
 */
async function brokerFetch(url, init, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LONG_POLL_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {RunnerIdentity} identity
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
 * @param {Buffer} encryptedKey
 * @param {import("node:crypto").KeyObject} privateKey
 */
export function decryptSessionKey(encryptedKey, privateKey) {
  return privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    encryptedKey
  );
}

/**
 * @param {Buffer} data
 * @param {number} blockSize
 */
function pkcs7Unpad(data, blockSize) {
  if (data.length === 0) {
    throw new Error("Invalid PKCS#7 padding");
  }
  const padLen = data[data.length - 1];
  if (padLen === 0 || padLen > blockSize || padLen > data.length) {
    throw new Error("Invalid PKCS#7 padding");
  }
  for (let index = data.length - padLen; index < data.length; index += 1) {
    if (data[index] !== padLen) {
      throw new Error("Invalid PKCS#7 padding");
    }
  }
  return data.subarray(0, data.length - padLen);
}

/**
 * @param {string} encryptedBody
 * @param {Buffer} sessionKey
 */
export function decryptMessageBody(encryptedBody, sessionKey) {
  const raw = Buffer.from(encryptedBody, "base64");
  const blockSize = 16;
  if (raw.length < blockSize * 2) {
    throw new Error("Encrypted message body is too short");
  }

  const iv = raw.subarray(0, blockSize);
  const ciphertext = raw.subarray(blockSize);
  if (ciphertext.length % blockSize !== 0) {
    throw new Error("Encrypted message body length is not block-aligned");
  }

  const decipher = createDecipheriv("aes-256-cbc", sessionKey, iv);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return pkcs7Unpad(decrypted, blockSize).toString("utf8");
}

/**
 * @param {string} body
 * @param {Buffer|null} sessionKey
 */
export function decodeMessageBody(body, sessionKey) {
  if (sessionKey) {
    return decryptMessageBody(body, sessionKey);
  }

  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === "string") {
      return parsed;
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * @param {string} runServiceUrl
 */
export function sanitizeRunServiceUrl(runServiceUrl) {
  try {
    const url = new URL(runServiceUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return runServiceUrl.split("?")[0];
  }
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
        const body = await response.text();
        throw new Error(
          `Broker message poll failed (${response.status}): ${body}`
        );
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

  const body = await response.text();
  throw new Error(
    `Broker DeleteSession failed (${response.status}): ${body}`
  );
}

/**
 * @param {string} encodedJitConfig
 * @param {object} [options]
 * @param {string} [options.runnerVersion]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
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
    return { identity, session, jobReference };
  } finally {
    await deleteBrokerSession(session, fetchImpl).catch(() => {});
  }
}

export { DEFAULT_RUNNER_VERSION };
