import { asObject } from "../util.js";

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function unwrapContextNode(value) {
  if (value == null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(unwrapContextNode);
  }

  const node = /** @type {Record<string, unknown>} */ (value);
  if ("t" in node || "type" in node) {
    const tokenType = node.t ?? node.type;
    if (tokenType === 0) {
      return node.s ?? node.lit ?? node.str ?? "";
    }
    if (tokenType === 1) {
      return (node.a ?? node.seq ?? []).map(unwrapContextNode);
    }
    if (tokenType === 2) {
      const entries = /** @type {Array<Record<string, unknown>>} */ (
        node.d ?? node.dict ?? node.map ?? []
      );
      const mapped = {};
      for (const entry of entries) {
        const key = unwrapContextNode(entry.k ?? entry.Key ?? entry.key);
        mapped[String(key)] = unwrapContextNode(
          entry.v ?? entry.Value ?? entry.value
        );
      }
      return mapped;
    }
    if (tokenType === 3) {
      if ("expr" in node) {
        return `\${{ ${String(node.expr)} }}`;
      }
      return node.b ?? node.bool ?? false;
    }
    if (tokenType === 5) {
      return node.b ?? node.bool ?? false;
    }
    if (tokenType === 4 || tokenType === 6) {
      return node.n ?? node.num ?? 0;
    }
  }

  const unwrapped = {};
  for (const [key, nested] of Object.entries(node)) {
    unwrapped[key] = unwrapContextNode(nested);
  }
  return unwrapped;
}

/**
 * @param {Record<string, unknown>} acquired
 */
export function getGithubContext(acquired) {
  const contextData = unwrapContextNode(
    acquired.contextData ?? acquired.ContextData ?? {}
  );
  if (!contextData || typeof contextData !== "object" || Array.isArray(contextData)) {
    return {};
  }
  const github = /** @type {Record<string, unknown>} */ (
    contextData.github ?? contextData.GitHub ?? {}
  );
  return github && typeof github === "object" && !Array.isArray(github)
    ? github
    : {};
}

/**
 * @param {Record<string, unknown>} acquired
 */
export function getContextData(acquired) {
  const contextData = unwrapContextNode(
    acquired.contextData ?? acquired.ContextData ?? {}
  );
  return asObject(contextData);
}

/**
 * @param {Record<string, unknown>} contextData
 * @param {string} path
 */
export function resolveContextPath(contextData, path) {
  const parts = path.trim().split(".").filter(Boolean);
  let current = /** @type {unknown} */ (contextData);

  for (const part of parts) {
    if (current == null || typeof current !== "object" || Array.isArray(current)) {
      return "";
    }
    const record = /** @type {Record<string, unknown>} */ (current);
    if (Object.prototype.hasOwnProperty.call(record, part)) {
      current = record[part];
      continue;
    }
    const match = Object.keys(record).find(
      (key) => key.toLowerCase() === part.toLowerCase()
    );
    if (!match) {
      return "";
    }
    current = record[match];
  }

  const resolved = unwrapContextNode(current);
  if (resolved == null || typeof resolved === "object") {
    return "";
  }
  return String(resolved);
}

/**
 * @param {string} expression
 * @param {Record<string, unknown>} contextData
 */
export function evaluateSimpleExpression(expression, contextData) {
  const trimmed = expression.trim();
  if (!trimmed) {
    return "";
  }
  if (/\(\s*\)/.test(trimmed)) {
    return "";
  }
  return resolveContextPath(contextData, trimmed);
}

/**
 * @param {unknown} rawValue
 * @param {Record<string, unknown>} contextData
 */
export function resolveEnvironmentValue(rawValue, contextData) {
  if (rawValue != null && typeof rawValue === "object" && !Array.isArray(rawValue)) {
    const node = /** @type {Record<string, unknown>} */ (rawValue);
    const tokenType = node.t ?? node.type;
    if (tokenType === 3 && "expr" in node) {
      return evaluateSimpleExpression(String(node.expr), contextData);
    }
  }

  let value = unwrapContextNode(rawValue);
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    value =
      readVariableValue(/** @type {Record<string, unknown>} */ (value)) ||
      String(value);
  }

  const text = String(value ?? "");
  const wrapped = text.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
  if (wrapped) {
    return evaluateSimpleExpression(wrapped[1], contextData);
  }
  return text;
}

/**
 * @param {unknown} raw
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeVariables(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (raw && typeof raw === "object") {
    return Object.entries(/** @type {Record<string, unknown>} */ (raw)).map(
      ([name, value]) => {
        if (value && typeof value === "object") {
          return {
            name,
            ...(/** @type {Record<string, unknown>} */ (value)),
          };
        }
        return { name, value };
      }
    );
  }
  return [];
}

/**
 * @param {Record<string, unknown>} variable
 */
export function readVariableValue(variable) {
  if (variable.value != null) {
    return String(variable.value);
  }
  if (variable.Value != null) {
    return String(variable.Value);
  }
  return "";
}

/**
 * @param {Record<string, unknown>} variable
 */
export function isSecretVariable(variable) {
  return (
    variable.isSecret === true ||
    variable.IsSecret === true ||
    variable.secret === true ||
    variable.Secret === true
  );
}

/**
 * @param {unknown} rawVariables
 * @param {string} name
 */
export function getVariableString(rawVariables, name) {
  const target = name.toLowerCase();
  for (const variable of normalizeVariables(rawVariables)) {
    if (String(variable.name ?? "").toLowerCase() === target) {
      return String(variable.value ?? "");
    }
  }
  return "";
}

/**
 * @param {unknown} raw
 * @param {Record<string, unknown>} contextData
 * @returns {Record<string, string>}
 */
export function parseEnvironmentVariableLayers(raw, contextData) {
  const env = {};
  const unwrapped = unwrapContextNode(raw ?? []);
  const layers = Array.isArray(unwrapped) ? unwrapped : [unwrapped];

  for (const layer of layers) {
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) {
      continue;
    }
    for (const [key, rawValue] of Object.entries(
      /** @type {Record<string, unknown>} */ (layer)
    )) {
      env[String(key)] = resolveEnvironmentValue(rawValue, contextData);
    }
  }

  return env;
}

const GITHUB_ENV_ALLOWLIST = new Set([
  "action_path",
  "action_ref",
  "action_repository",
  "action",
  "actor",
  "actor_id",
  "api_url",
  "artifacts",
  "artifacts_list",
  "base_ref",
  "env",
  "event_name",
  "event_path",
  "graphql_url",
  "head_ref",
  "job",
  "output",
  "path",
  "ref_name",
  "ref_protected",
  "ref_type",
  "ref",
  "repository",
  "repository_id",
  "repository_owner",
  "repository_owner_id",
  "retention_days",
  "run_attempt",
  "run_id",
  "run_number",
  "server_url",
  "sha",
  "state",
  "step_summary",
  "triggering_actor",
  "workflow",
  "workflow_ref",
  "workflow_sha",
  "workspace",
]);

/**
 * @param {Record<string, unknown>} github
 * @returns {Record<string, string>}
 */
export function githubContextToEnv(github) {
  const env = {};
  for (const [key, rawValue] of Object.entries(github)) {
    if (!GITHUB_ENV_ALLOWLIST.has(String(key).toLowerCase())) {
      continue;
    }
    const value = unwrapContextNode(rawValue);
    if (value == null) {
      continue;
    }
    if (typeof value === "boolean") {
      env[`GITHUB_${String(key).toUpperCase()}`] = String(value);
      continue;
    }
    env[`GITHUB_${String(key).toUpperCase()}`] = String(value);
  }
  return env;
}
