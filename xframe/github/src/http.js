import { stripBom } from "./util.js";

/**
 * @param {string} encoded
 */
export function decodeBase64Json(encoded) {
  const text = stripBom(Buffer.from(encoded, "base64")).toString("utf8");
  return JSON.parse(text);
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
 * @param {string} runServiceUrl
 */
export function buildRunServiceUrl(runServiceUrl) {
  return runServiceUrl.replace(/\/$/, "");
}

/**
 * @returns {string}
 */
export function getRunnerOs() {
  if (process.platform === "win32") {
    return "Windows";
  }
  if (process.platform === "darwin") {
    return "macOS";
  }
  return "Linux";
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {typeof fetch} fetchImpl
 */
export async function fetchWithTimeout(url, init, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
 * @param {Response} response
 */
export async function readResponseError(response, label) {
  const body = await response.text();
  return new Error(`${label} (${response.status}): ${body}`);
}

/**
 * @param {Error} error
 */
export function isTerminalPollError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return (
    message.includes("unauthorized") ||
    message.includes("Unexpected broker message type") ||
    message.includes("Job reference body missing") ||
    message.includes("Polling aborted")
  );
}
