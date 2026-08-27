import { UTF8_BOM } from "./constants.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} value
 */
export function isUuid(value) {
  return UUID_PATTERN.test(value);
}

/**
 * @param {"succeeded" | "failed" | "Succeeded" | "Failed" | "skipped" | "Skipped"} conclusion
 */
export function mapConclusion(conclusion) {
  const normalized = String(conclusion).toLowerCase();
  if (normalized === "failed") {
    return "failed";
  }
  if (normalized === "skipped") {
    return "skipped";
  }
  return "succeeded";
}

/**
 * @param {Record<string, unknown>} object
 * @param {string[]} keys
 */
export function pickField(object, keys) {
  for (const key of keys) {
    const value = object[key];
    if (value != null && value !== "") {
      return value;
    }
  }
  return "";
}

/**
 * @param {...string} values
 */
export function firstNonEmpty(...values) {
  for (const value of values) {
    if (value != null && String(value) !== "") {
      return String(value);
    }
  }
  return "";
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {Buffer} data
 */
export function stripBom(data) {
  if (
    data.length >= UTF8_BOM.length &&
    data.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
  ) {
    return data.subarray(UTF8_BOM.length);
  }
  return data;
}
