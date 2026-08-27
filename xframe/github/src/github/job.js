import { getRunnerOs, buildRunServiceUrl } from "../http.js";
import {
  asObject,
  firstNonEmpty,
  isUuid,
  pickField,
} from "../util.js";
import {
  getContextData,
  getGithubContext,
  getVariableString,
  githubContextToEnv,
  isSecretVariable,
  normalizeVariables,
  parseEnvironmentVariableLayers,
  readVariableValue,
  unwrapContextNode,
} from "./context.js";

/**
 * @typedef {object} AcquiredJobMetadata
 * @property {string} planId
 * @property {string} jobId
 * @property {string} jobName
 * @property {string} workflowFile
 * @property {string} workflowRef
 * @property {string} repository
 * @property {string[]} secretVariableNames
 */

/**
 * @typedef {object} AcquiredJobStep
 * @property {string} id
 * @property {number} order
 * @property {string} displayName
 * @property {string} [type]
 * @property {"run" | "uses" | "unknown"} kind
 * @property {string} [uses]
 * @property {string} [script]
 */

/**
 * @param {Record<string, unknown>} acquired
 */
export function extractJobAuthToken(acquired) {
  const resources = /** @type {Record<string, unknown>} */ (
    acquired.resources ?? acquired.Resources ?? {}
  );
  const endpoints = /** @type {Array<Record<string, unknown>>} */ (
    resources.endpoints ?? resources.Endpoints ?? []
  );

  for (const endpoint of endpoints) {
    const name = String(endpoint.name ?? endpoint.Name ?? "");
    if (name.toLowerCase() !== "systemvssconnection") {
      continue;
    }
    const authorization = /** @type {Record<string, unknown>} */ (
      endpoint.authorization ?? endpoint.Authorization ?? {}
    );
    const parameters = /** @type {Record<string, unknown>} */ (
      authorization.parameters ?? authorization.Parameters ?? {}
    );
    for (const [key, value] of Object.entries(parameters)) {
      if (key.toLowerCase() === "accesstoken" && value) {
        return String(value);
      }
    }
  }
  return "";
}

/**
 * @param {Record<string, unknown>} acquired
 * @param {string} [fallbackUrl]
 */
export function extractJobServiceUrl(acquired, fallbackUrl = "") {
  const resources = /** @type {Record<string, unknown>} */ (
    acquired.resources ?? acquired.Resources ?? {}
  );
  const endpoints = /** @type {Array<Record<string, unknown>>} */ (
    resources.endpoints ?? resources.Endpoints ?? []
  );

  for (const endpoint of endpoints) {
    const name = String(endpoint.name ?? endpoint.Name ?? "");
    if (name.toLowerCase() !== "systemvssconnection") {
      continue;
    }
    const url = firstNonEmpty(pickField(endpoint, ["url", "Url"]));
    if (url) {
      return buildRunServiceUrl(url);
    }
    const data = asObject(endpoint.data ?? endpoint.Data);
    const fromData = firstNonEmpty(
      pickField(data, ["PipelinesServiceUrl", "pipelinesServiceUrl"]),
      pickField(data, ["pipelines_service_url"])
    );
    if (fromData) {
      return buildRunServiceUrl(fromData);
    }
  }

  return fallbackUrl ? buildRunServiceUrl(fallbackUrl) : "";
}

/** @deprecated Use extractJobServiceUrl */
export function extractPipelinesServiceUrl(acquired) {
  return extractJobServiceUrl(acquired);
}

/**
 * @param {Record<string, unknown>} acquired
 */
export function extractPipelinesLogUrl(acquired) {
  const resources = /** @type {Record<string, unknown>} */ (
    acquired.resources ?? acquired.Resources ?? {}
  );
  const endpoints = /** @type {Array<Record<string, unknown>>} */ (
    resources.endpoints ?? resources.Endpoints ?? []
  );

  for (const endpoint of endpoints) {
    const name = String(endpoint.name ?? endpoint.Name ?? "");
    if (name.toLowerCase() !== "systemvssconnection") {
      continue;
    }
    const data = asObject(endpoint.data ?? endpoint.Data);
    const fromData = firstNonEmpty(
      pickField(data, ["PipelinesServiceUrl", "pipelinesServiceUrl"]),
      pickField(data, ["pipelines_service_url"])
    );
    if (fromData) {
      return buildRunServiceUrl(fromData);
    }
  }
  return "";
}

/**
 * @param {Record<string, unknown>} acquired
 */
export function getResultsEndpoint(acquired) {
  const rawVariables = acquired.variables ?? acquired.Variables;
  return getVariableString(rawVariables, "system.github.results_endpoint");
}

/**
 * @param {Record<string, unknown>} acquired
 */
export function parsePlanReference(acquired) {
  const plan = asObject(acquired.plan ?? acquired.Plan);
  return {
    planId: firstNonEmpty(
      pickField(acquired, ["planId", "PlanId"]),
      pickField(plan, ["planId", "PlanId"])
    ),
    jobId: firstNonEmpty(
      pickField(acquired, ["jobId", "JobId"]),
      pickField(plan, ["jobId", "JobId"])
    ),
    timelineId: firstNonEmpty(
      pickField(acquired, ["timelineId", "TimelineId"]),
      pickField(plan, ["timelineId", "TimelineId"])
    ),
  };
}

/**
 * @param {import("./broker.js").JobReference} jobReference
 * @param {string} [planId]
 * @returns {AcquiredJobMetadata}
 */
export function parseAcquiredJobMetadata(acquired, jobReference, planId = "") {
  const job = /** @type {Record<string, unknown>} */ (
    acquired.job ?? acquired.Job ?? {}
  );
  const github = getGithubContext(acquired);
  const rawVariables = acquired.variables ?? acquired.Variables;
  const resolvedPlanId = String(
    planId ||
      pickField(acquired, ["planId", "PlanId"]) ||
      pickField(
        /** @type {Record<string, unknown>} */ (acquired.plan ?? acquired.Plan ?? {}),
        ["planId", "PlanId"]
      )
  );

  const variables = normalizeVariables(rawVariables);
  const secretVariableNames = variables
    .filter(isSecretVariable)
    .map((variable) => String(variable.name ?? variable.Name ?? ""))
    .filter(Boolean);

  const jobName = firstNonEmpty(
    pickField(acquired, ["jobDisplayName", "JobDisplayName"]),
    pickField(job, ["displayName", "DisplayName", "name", "Name"]),
    getVariableString(rawVariables, "system.jobDisplayName"),
    pickField(github, ["job", "Job"])
  );
  const workflowFile = firstNonEmpty(
    pickField(github, ["workflow", "Workflow"]),
    pickField(acquired, ["workflow", "Workflow"])
  );
  const workflowRef = firstNonEmpty(
    pickField(github, ["ref", "Ref"]),
    pickField(job, ["workflowRef", "WorkflowRef", "ref", "Ref"])
  );
  const repository = firstNonEmpty(
    pickField(github, ["repository", "Repository"]),
    pickField(job, ["repositoryName", "RepositoryName", "repository", "Repository"])
  );
  const planReference = parsePlanReference(acquired);

  return {
    planId: resolvedPlanId || planReference.planId,
    jobId: planReference.jobId || jobReference.runnerRequestId,
    jobName,
    workflowFile,
    workflowRef,
    repository,
    secretVariableNames,
  };
}

/**
 * @param {Record<string, unknown>} acquired
 * @returns {AcquiredJobStep[]}
 */
export function parseAcquiredJobSteps(acquired) {
  const steps = unwrapContextNode(acquired.steps ?? acquired.Steps ?? []);
  if (!Array.isArray(steps)) {
    return [];
  }

  return steps.map((rawStep, index) => {
    const step = asObject(unwrapContextNode(rawStep));
    const reference = asObject(unwrapContextNode(step.reference ?? step.Reference));
    const inputs = asObject(unwrapContextNode(step.inputs ?? step.Inputs));

    const refType = String(reference.type ?? reference.Type ?? "").toLowerCase();
    const refName = String(reference.name ?? reference.Name ?? "").toLowerCase();
    const script = firstNonEmpty(
      inputs.script,
      inputs.run,
      refType === "script" || refName === "script" ? reference.path : ""
    );
    const uses = firstNonEmpty(
      inputs.uses,
      reference.path,
      reference.image,
      reference.name
    );

    let kind = /** @type {"run" | "uses" | "unknown"} */ ("unknown");
    if (script) {
      kind = "run";
    } else if (uses || refType === "node" || refType === "action") {
      kind = "uses";
    }

    const displayName = firstNonEmpty(
      unwrapContextNode(
        step.displayName ??
          step.DisplayName ??
          step.displayNameToken ??
          step.DisplayNameToken
      ),
      pickField(step, ["name", "Name"]),
      `Step ${index + 1}`
    );
    const stepId = String(
      unwrapContextNode(step.id ?? step.Id ?? step.stepId ?? step.StepId ?? "")
    );

    return {
      id: stepId,
      order: Number(step.order ?? step.Order ?? index + 1),
      displayName: String(displayName),
      type: String(reference.type ?? reference.Type ?? refName ?? kind),
      kind,
      uses: uses || undefined,
      script: script || undefined,
    };
  });
}

/**
 * @param {AcquiredJobStep[]} steps
 * @param {Record<string, unknown>} acquired
 */
export function mergeStepIdsFromTimeline(steps, acquired) {
  const timeline = asObject(unwrapContextNode(acquired.timeline ?? acquired.Timeline));
  const records = unwrapContextNode(
    timeline.records ?? timeline.Records ?? timeline.value ?? []
  );
  if (!Array.isArray(records)) {
    return steps;
  }

  const taskRecords = records
    .map((record) => asObject(unwrapContextNode(record)))
    .filter((record) => {
      const recordType = String(
        record.recordType ?? record.RecordType ?? record.type ?? record.Type ?? "task"
      ).toLowerCase();
      return recordType === "task" || recordType === "job" || recordType === "";
    });

  return steps.map((step, index) => {
    if (isUuid(step.id)) {
      return step;
    }
    for (const candidate of [taskRecords[index], records[index]]) {
      const record = asObject(unwrapContextNode(candidate));
      const id = String(unwrapContextNode(record.id ?? record.Id ?? "") ?? "");
      if (isUuid(id)) {
        return { ...step, id };
      }
    }
    return step;
  });
}

/**
 * @param {Record<string, unknown>} acquired
 * @param {object} [options]
 * @param {string} [options.runnerName]
 * @returns {NodeJS.ProcessEnv}
 */
export function parseAcquiredJobEnvironment(acquired, options = {}) {
  const env = { ...process.env };
  const contextData = getContextData(acquired);

  for (const variable of normalizeVariables(
    acquired.variables ?? acquired.Variables
  )) {
    const name = String(variable.name ?? variable.Name ?? "");
    if (!name || name.includes(".") || isSecretVariable(variable)) {
      continue;
    }
    env[name] = readVariableValue(variable);
  }

  Object.assign(env, githubContextToEnv(getGithubContext(acquired)));
  Object.assign(
    env,
    parseEnvironmentVariableLayers(
      acquired.environmentVariables ?? acquired.EnvironmentVariables,
      contextData
    )
  );

  env.RUNNER_OS = env.RUNNER_OS || getRunnerOs();
  env.RUNNER_ARCH = env.RUNNER_ARCH || process.arch;
  env.RUNNER_NAME = env.RUNNER_NAME || options.runnerName || "jit-runner";
  return env;
}

export { isUuid };
