'use strict';

/**
 * Pure-logic smoke checks for director’s-cut helpers (no DOM / WASM).
 * Mirrors the normalize / duration / full-program rules in dcp-transcoding.js.
 */

function normalizeSlices(rawSlices, durationSec) {
  const duration = Number(durationSec);
  if (!(duration > 0)) return [];
  const cleaned = [];
  for (const raw of rawSlices || []) {
    let start = Number(raw?.start);
    let end = Number(raw?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, Math.min(duration, start));
    end = Math.max(0, Math.min(duration, end));
    if (end - start < 0.05) continue;
    cleaned.push({ start, end });
  }
  return cleaned;
}

function defaultFullSlice(durationSec) {
  const duration = Number(durationSec);
  if (!(duration > 0)) return [];
  return [{ start: 0, end: duration }];
}

function isFullProgram(slices, durationSec) {
  const normalized = normalizeSlices(slices, durationSec);
  if (normalized.length !== 1) return false;
  return normalized[0].start <= 0.001 && Math.abs(normalized[0].end - durationSec) <= 0.05;
}

function programDuration(slices) {
  return (slices || []).reduce((sum, slice) => sum + Math.max(0, slice.end - slice.start), 0);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const duration = 20;
const full = defaultFullSlice(duration);
assert(isFullProgram(full, duration), 'default program is full');
assert(Math.abs(programDuration(full) - 20) < 1e-9, 'full duration');

const cut = normalizeSlices([{ start: 1, end: 4 }, { start: 10, end: 15.5 }], duration);
assert(cut.length === 2, 'keeps ordered slices');
assert(cut[0].start === 1 && cut[0].end === 4, 'first slice intact');
assert(cut[1].start === 10 && cut[1].end === 15.5, 'second slice intact');
assert(!isFullProgram(cut, duration), 'cut is not full');
assert(Math.abs(programDuration(cut) - 8.5) < 1e-9, 'programmed duration sums slices');

const clamped = normalizeSlices([{ start: -2, end: 3 }, { start: 18, end: 99 }, { start: 5, end: 5.01 }], duration);
assert(clamped.length === 2, 'drops tiny slice and clamps bounds');
assert(clamped[0].start === 0 && clamped[0].end === 3, 'clamps start');
assert(clamped[1].start === 18 && clamped[1].end === 20, 'clamps end');

const vertical = normalizeSlices(cut, 12);
assert(vertical.length === 2, 'same timeline applies to shorter vertical');
assert(vertical[1].end === 12, 'vertical end clamps to its duration');
assert(Math.abs(programDuration(vertical) - 5) < 1e-9, 'vertical programmed duration');

const storageKey = (fileName) => `xframe-social:directorsCut:${fileName}`;
assert(storageKey('demo.mp4') === 'xframe-social:directorsCut:demo.mp4', 'storage key is per filename');

console.log('verify-directors-cut: OK');
