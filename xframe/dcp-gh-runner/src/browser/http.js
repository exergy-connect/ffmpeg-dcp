import { Buffer } from '../shims/buffer.js';
import { UTF8_BOM } from '../constants.js';

export function stripBom(text) {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}

export function decodeBase64Json(encoded) {
  const text = stripBom(Buffer.from(encoded, 'base64').toString('utf8'));
  return JSON.parse(text);
}

export function sanitizeRunServiceUrl(runServiceUrl) {
  try {
    const url = new URL(runServiceUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return runServiceUrl.split('?')[0];
  }
}

export function buildRunServiceUrl(runServiceUrl) {
  return runServiceUrl.replace(/\/$/, '');
}

export function getRunnerOs() {
  return 'Linux';
}

export async function fetchWithTimeout(url, init, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signals = [controller.signal];
    if (init?.signal) signals.push(init.signal);
    const signal = signals.length > 1 && typeof AbortSignal.any === 'function'
      ? AbortSignal.any(signals)
      : controller.signal;
    return await fetchImpl(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

export function isTerminalPollError(error) {
  const message = String(error?.message || error || '');
  return /unauthorized|401|403|Unexpected broker message type/i.test(message);
}

export async function readResponseError(response, label) {
  const body = await response.text();
  return new Error(`${label} (${response.status}): ${body}`);
}
