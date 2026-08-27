import { buildRunServiceUrl, getRunnerOs, readResponseError } from "../http.js";
import { mapConclusion, pickField } from "../util.js";
import {
  extractJobAuthToken,
  extractJobServiceUrl,
} from "./job.js";

/**
 * @typedef {object} AcquiredJob
 * @property {string} planId
 * @property {string} jobAuthToken
 * @property {string} jobServiceUrl
 * @property {Record<string, unknown>} payload
 */

/**
 * @typedef {object} JobStepResult
 * @property {string} external_id
 * @property {number} number
 * @property {string} name
 * @property {string} status
 * @property {string} conclusion
 * @property {string} started_at
 * @property {string} completed_at
 * @property {unknown[]} annotations
 */

/**
 * @param {import("./broker.js").BrokerSession} session
 * @param {import("./broker.js").JobReference} jobReference
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<AcquiredJob>}
 */
export async function acquireJob(session, jobReference, fetchImpl = fetch) {
  const runServiceUrl = buildRunServiceUrl(jobReference.runServiceUrl);
  const response = await fetchImpl(`${runServiceUrl}/acquirejob`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jobMessageId: jobReference.runnerRequestId,
      runnerOS: getRunnerOs(),
      billingOwnerId: jobReference.billingOwnerId,
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Run service AcquireJob failed (${response.status}): ${responseText}`
    );
  }

  const payload = JSON.parse(responseText);
  const planId =
    response.headers.get("x-plan-id") ??
    String(
      pickField(
        /** @type {Record<string, unknown>} */ (payload.plan ?? payload.Plan ?? {}),
        ["planId", "PlanId"]
      )
    );
  const jobAuthToken = extractJobAuthToken(payload);

  return {
    planId,
    jobAuthToken,
    jobServiceUrl: extractJobServiceUrl(payload),
    payload,
  };
}

/**
 * @param {string} runServiceUrl
 * @param {object} request
 * @param {string} request.planId
 * @param {string} request.jobId
 * @param {string} request.authToken
 * @param {typeof fetch} fetchImpl
 */
export async function renewJob(
  runServiceUrl,
  { planId, jobId, authToken },
  fetchImpl = fetch
) {
  const baseUrl = buildRunServiceUrl(runServiceUrl);
  const response = await fetchImpl(`${baseUrl}/renewjob`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      planId,
      jobId,
    }),
  });

  if (response.ok || response.status === 204) {
    return;
  }

  throw await readResponseError(response, "Run service RenewJob failed");
}

/**
 * @param {string} jobServiceUrl
 * @param {object} request
 * @param {string} request.planId
 * @param {string} request.jobId
 * @param {"succeeded" | "failed"} request.conclusion
 * @param {string} request.authToken
 * @param {JobStepResult[]} [request.stepResults]
 * @param {Record<string, string>} [request.outputs]
 * @param {string} [request.billingOwnerId]
 * @param {typeof fetch} fetchImpl
 */
export async function completeJob(
  jobServiceUrl,
  {
    planId,
    jobId,
    conclusion,
    authToken,
    stepResults = [],
    outputs = {},
    billingOwnerId = "",
  },
  fetchImpl = fetch
) {
  const baseUrl = buildRunServiceUrl(jobServiceUrl);
  /** @type {Record<string, unknown>} */
  const payload = {
    planId,
    jobId,
    conclusion: mapConclusion(conclusion),
    outputs,
    annotations: [],
  };
  if (stepResults.length > 0) {
    payload.stepResults = stepResults;
  }
  if (billingOwnerId) {
    payload.billingOwnerId = billingOwnerId;
  }

  const response = await fetchImpl(`${baseUrl}/completejob`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 204 || response.ok) {
    return;
  }

  const body = await response.text();
  throw new Error(
    `CompleteJob failed (${response.status}) at ${baseUrl}/completejob: ${body}\nPayload: ${JSON.stringify(payload)}`
  );
}
