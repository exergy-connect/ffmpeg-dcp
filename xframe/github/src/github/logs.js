import { buildRunServiceUrl, readResponseError } from "../http.js";
import { isUuid } from "../util.js";
import {
  countGithubLogLines,
  formatGithubLogLines,
} from "./executor.js";
import {
  extractPipelinesLogUrl,
  getResultsEndpoint,
} from "./job.js";

/**
 * @typedef {import("./executor.js").StepLogCapture} StepLogCapture
 */

/**
 * @param {object} params
 * @param {typeof fetch} fetchImpl
 * @param {string} params.logsUrl
 * @param {string} params.logText
 * @param {boolean} [params.sealOnAppend]
 */
async function uploadAppendBlob(params, fetchImpl) {
  const createResponse = await fetchImpl(params.logsUrl, {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "AppendBlob",
      "Content-Length": "0",
    },
  });
  if (!createResponse.ok && createResponse.status !== 409) {
    throw await readResponseError(createResponse, "Create append blob failed");
  }

  const formatted = formatGithubLogLines(params.logText);
  if (formatted.length > 0) {
    const appendUrl = params.sealOnAppend
      ? `${params.logsUrl}&comp=appendblock&seal=true`
      : `${params.logsUrl}&comp=appendblock`;
    const appendHeaders = {
      "Content-Length": String(Buffer.byteLength(formatted)),
    };
    if (params.sealOnAppend) {
      appendHeaders["x-ms-blob-sealed"] = "true";
    }
    const appendResponse = await fetchImpl(appendUrl, {
      method: "PUT",
      headers: appendHeaders,
      body: formatted,
    });
    if (!appendResponse.ok) {
      throw await readResponseError(appendResponse, "Append log block failed");
    }
    return countGithubLogLines(params.logText);
  }

  if (!params.sealOnAppend) {
    const sealResponse = await fetchImpl(`${params.logsUrl}&comp=seal`, {
      method: "PUT",
      headers: {
        "Content-Length": "0",
      },
    });
    if (!sealResponse.ok) {
      throw await readResponseError(sealResponse, "Seal log blob failed");
    }
  }

  return 0;
}

/**
 * @param {object} params
 * @param {string} params.resultsUrl
 * @param {string} params.planId
 * @param {string} params.jobId
 * @param {string} params.stepId
 * @param {string} params.authToken
 * @param {string} params.logText
 * @param {typeof fetch} [params.fetchImpl]
 */
async function uploadModernStepLogs(params) {
  const fetchImpl = params.fetchImpl ?? fetch;
  const baseUrl = buildRunServiceUrl(params.resultsUrl);
  const signedResponse = await fetchImpl(
    `${baseUrl}/twirp/results.services.receiver.Receiver/GetStepLogsSignedBlobURL`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow_run_backend_id: params.planId,
        workflow_job_run_backend_id: params.jobId,
        step_backend_id: params.stepId,
      }),
    }
  );
  if (!signedResponse.ok) {
    throw await readResponseError(
      signedResponse,
      "GetStepLogsSignedBlobURL failed"
    );
  }
  const signedPayload = await signedResponse.json();
  const logsUrl = String(signedPayload.logs_url ?? signedPayload.logsUrl ?? "");
  if (!logsUrl) {
    throw new Error("GetStepLogsSignedBlobURL returned no logs_url");
  }

  const lineCount = await uploadAppendBlob(
    { logsUrl, logText: params.logText },
    fetchImpl
  );

  const metadataResponse = await fetchImpl(
    `${baseUrl}/twirp/results.services.receiver.Receiver/CreateStepLogsMetadata`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow_run_backend_id: params.planId,
        workflow_job_run_backend_id: params.jobId,
        step_backend_id: params.stepId,
        uploaded_at: new Date().toISOString(),
        line_count: lineCount,
      }),
    }
  );
  if (!metadataResponse.ok) {
    throw await readResponseError(
      metadataResponse,
      "CreateStepLogsMetadata failed"
    );
  }

  const sealResponse = await fetchImpl(`${logsUrl}&comp=seal`, {
    method: "PUT",
    headers: {
      "Content-Length": "0",
    },
  });
  if (!sealResponse.ok) {
    throw await readResponseError(sealResponse, "Seal step log blob failed");
  }
}

/**
 * @param {object} params
 * @param {string} params.resultsUrl
 * @param {string} params.planId
 * @param {string} params.jobId
 * @param {string} params.authToken
 * @param {string} params.logText
 * @param {typeof fetch} [params.fetchImpl]
 */
async function uploadModernJobLogs(params) {
  const fetchImpl = params.fetchImpl ?? fetch;
  const baseUrl = buildRunServiceUrl(params.resultsUrl);
  const signedResponse = await fetchImpl(
    `${baseUrl}/twirp/results.services.receiver.Receiver/GetJobLogsSignedBlobURL`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow_run_backend_id: params.planId,
        workflow_job_run_backend_id: params.jobId,
      }),
    }
  );
  if (!signedResponse.ok) {
    throw await readResponseError(
      signedResponse,
      "GetJobLogsSignedBlobURL failed"
    );
  }
  const signedPayload = await signedResponse.json();
  const logsUrl = String(signedPayload.logs_url ?? signedPayload.logsUrl ?? "");
  if (!logsUrl) {
    throw new Error("GetJobLogsSignedBlobURL returned no logs_url");
  }

  const lineCount = await uploadAppendBlob(
    { logsUrl, logText: params.logText, sealOnAppend: true },
    fetchImpl
  );

  const metadataResponse = await fetchImpl(
    `${baseUrl}/twirp/results.services.receiver.Receiver/CreateJobLogsMetadata`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow_run_backend_id: params.planId,
        workflow_job_run_backend_id: params.jobId,
        uploaded_at: new Date().toISOString(),
        line_count: lineCount,
      }),
    }
  );
  if (!metadataResponse.ok) {
    throw await readResponseError(
      metadataResponse,
      "CreateJobLogsMetadata failed"
    );
  }

  if (lineCount === 0) {
    await fetchImpl(`${logsUrl}&comp=seal`, {
      method: "PUT",
      headers: {
        "Content-Length": "0",
      },
    });
  }
}

/**
 * @param {object} params
 * @param {string} params.pipelinesUrl
 * @param {string} params.planId
 * @param {string} params.stepName
 * @param {string} params.authToken
 * @param {string} params.logText
 * @param {typeof fetch} [params.fetchImpl]
 */
async function uploadLegacyStepLogs(params) {
  const fetchImpl = params.fetchImpl ?? fetch;
  const baseUrl = buildRunServiceUrl(params.pipelinesUrl);
  const createResponse = await fetchImpl(
    `${baseUrl}/_apis/pipelines/workflows/${params.planId}/logs`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: `logs/${params.stepName}`,
      }),
    }
  );
  if (!createResponse.ok) {
    throw await readResponseError(createResponse, "Create legacy log failed");
  }
  const createPayload = await createResponse.json();
  const logId = createPayload.id ?? createPayload.Id;
  const formatted = formatGithubLogLines(params.logText);
  const uploadResponse = await fetchImpl(
    `${baseUrl}/_apis/pipelines/workflows/${params.planId}/logs/${logId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.authToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: formatted,
    }
  );
  if (!uploadResponse.ok) {
    throw await readResponseError(uploadResponse, "Upload legacy log failed");
  }
}

/**
 * @param {StepLogCapture[]} stepLogs
 */
export function buildCombinedJobLogText(stepLogs) {
  return stepLogs
    .map(
      (entry) =>
        `##[group]${entry.step.displayName}\n${entry.output}${entry.output.endsWith("\n") ? "" : "\n"}##[endgroup]\n`
    )
    .join("\n");
}

/**
 * @param {object} params
 * @param {Record<string, unknown>} params.acquired
 * @param {string} params.planId
 * @param {string} params.jobId
 * @param {string} params.authToken
 * @param {StepLogCapture[]} params.stepLogs
 * @param {typeof fetch} [params.fetchImpl]
 */
export async function uploadAcquiredJobLogs(params) {
  const fetchImpl = params.fetchImpl ?? fetch;
  const resultsUrl = getResultsEndpoint(params.acquired);
  const pipelinesUrl = extractPipelinesLogUrl(params.acquired);

  for (const entry of params.stepLogs) {
    if (!isUuid(entry.step.id) || !entry.output) {
      continue;
    }
    if (resultsUrl) {
      await uploadModernStepLogs({
        resultsUrl,
        planId: params.planId,
        jobId: params.jobId,
        stepId: entry.step.id,
        authToken: params.authToken,
        logText: entry.output,
        fetchImpl,
      });
      continue;
    }
    if (pipelinesUrl) {
      await uploadLegacyStepLogs({
        pipelinesUrl,
        planId: params.planId,
        stepName: entry.step.displayName,
        authToken: params.authToken,
        logText: entry.output,
        fetchImpl,
      });
    }
  }

  const combinedLog = buildCombinedJobLogText(params.stepLogs);
  if (resultsUrl && combinedLog) {
    await uploadModernJobLogs({
      resultsUrl,
      planId: params.planId,
      jobId: params.jobId,
      authToken: params.authToken,
      logText: combinedLog,
      fetchImpl,
    });
  }
}
