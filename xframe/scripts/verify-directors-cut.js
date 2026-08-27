'use strict';

/**
 * Pure-logic smoke checks for director’s-cut helpers (no DOM / WASM).
 * Mirrors normalize / duration / full-program / chunk-mapping rules in dcp-transcoding.js.
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

function buildChunkTimeline(durations, sourceDurationSec) {
  const sourceDuration = Number(sourceDurationSec);
  const raw = (durations || []).map((d) => Math.max(0, Number(d) || 0));
  if (!raw.length) {
    const end = sourceDuration > 0 ? sourceDuration : 0;
    return { starts: [0], ends: [end], durations: [end] };
  }
  if (raw.length === 1 && !(raw[0] > 0) && sourceDuration > 0) {
    return { starts: [0], ends: [sourceDuration], durations: [sourceDuration] };
  }
  const starts = [];
  let t = 0;
  for (let i = 0; i < raw.length; i++) {
    starts.push(t);
    t += raw[i];
  }
  const ends = raw.map((d, i) => starts[i] + d);
  const sum = ends.length ? ends[ends.length - 1] : 0;
  if (sourceDuration > 0 && sum > 0 && Math.abs(sum - sourceDuration) > 0.25) {
    ends[ends.length - 1] = Math.max(starts[starts.length - 1] + 0.05, sourceDuration);
  } else if (sourceDuration > 0 && !(sum > 0)) {
    const each = sourceDuration / raw.length;
    for (let i = 0; i < raw.length; i++) {
      starts[i] = i * each;
      ends[i] = (i + 1) * each;
    }
  }
  return {
    starts,
    ends,
    durations: ends.map((end, i) => Math.max(0, end - starts[i])),
  };
}

function mapDirectorsCutToProgram(slices, durations, sourceDurationSec) {
  const timeline = buildChunkTimeline(durations, sourceDurationSec);
  const chunkCount = timeline.starts.length;
  if (!slices || !slices.length) {
    return timeline.starts.map((_, chunkIndex) => ({
      programIndex: chunkIndex,
      chunkIndex,
      trimStartSec: 0,
      trimEndSec: timeline.durations[chunkIndex],
      needsTrim: false,
      durationSec: timeline.durations[chunkIndex],
    }));
  }
  const segments = [];
  let programIndex = 0;
  for (const slice of slices) {
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const chunkStart = timeline.starts[chunkIndex];
      const chunkEnd = timeline.ends[chunkIndex];
      const overlapStart = Math.max(slice.start, chunkStart);
      const overlapEnd = Math.min(slice.end, chunkEnd);
      if (!(overlapEnd - overlapStart >= 0.05)) continue;
      const needsTrim =
        overlapStart - chunkStart > 0.05 || chunkEnd - overlapEnd > 0.05;
      segments.push({
        programIndex,
        chunkIndex,
        trimStartSec: overlapStart - chunkStart,
        trimEndSec: overlapEnd - chunkStart,
        needsTrim,
        durationSec: overlapEnd - overlapStart,
      });
      programIndex += 1;
    }
  }
  return segments;
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

// 3s chunks over a 12s source: [0,3)[3,6)[6,9)[9,12)
const chunkDurations = [3, 3, 3, 3];
const fullPieces = mapDirectorsCutToProgram(null, chunkDurations, 12);
assert(fullPieces.length === 4, 'full program keeps every chunk');
assert(fullPieces.every((p) => !p.needsTrim), 'full program needs no trim');

const midCut = mapDirectorsCutToProgram([{ start: 4, end: 8 }], chunkDurations, 12);
assert(midCut.length === 2, 'mid cut spans two chunks');
assert(midCut[0].chunkIndex === 1 && midCut[0].needsTrim, 'first piece trims start of chunk 1');
assert(Math.abs(midCut[0].trimStartSec - 1) < 1e-9, 'trim start is chunk-relative');
assert(Math.abs(midCut[0].trimEndSec - 3) < 1e-9, 'trim end is chunk-relative at chunk length');
assert(midCut[1].chunkIndex === 2 && midCut[1].needsTrim, 'second piece trims end of chunk 2');
assert(Math.abs(midCut[1].trimStartSec - 0) < 1e-9 && Math.abs(midCut[1].trimEndSec - 2) < 1e-9, 'second trim range relative');

const skipMiddle = mapDirectorsCutToProgram(
  [{ start: 0, end: 2.5 }, { start: 9.5, end: 12 }],
  chunkDurations,
  12,
);
assert(skipMiddle.length === 2, 'skipped middle chunks never become pieces');
assert(skipMiddle[0].chunkIndex === 0 && skipMiddle[1].chunkIndex === 3, 'only edge chunks');
assert(skipMiddle[0].needsTrim && skipMiddle[1].needsTrim, 'edge pieces trim');
assert(Math.abs(skipMiddle[0].trimStartSec - 0) < 1e-9 && Math.abs(skipMiddle[0].trimEndSec - 2.5) < 1e-9, 'first edge relative');
assert(Math.abs(skipMiddle[1].trimStartSec - 0.5) < 1e-9 && Math.abs(skipMiddle[1].trimEndSec - 3) < 1e-9, 'last edge relative');

const interiorOnly = mapDirectorsCutToProgram([{ start: 3, end: 6 }], chunkDurations, 12);
assert(interiorOnly.length === 1, 'exact chunk overlap is one piece');
assert(interiorOnly[0].chunkIndex === 1 && !interiorOnly[0].needsTrim, 'exact chunk needs no trim');
assert(Math.abs(interiorOnly[0].trimStartSec - 0) < 1e-9 && Math.abs(interiorOnly[0].trimEndSec - 3) < 1e-9, 'full-chunk relative window');

const passthrough = mapDirectorsCutToProgram([{ start: 1, end: 5 }], [0], 10);
assert(passthrough.length === 1, 'zero-duration single chunk uses source length');
assert(passthrough[0].needsTrim, 'passthrough cut still trims');
assert(Math.abs(passthrough[0].trimStartSec - 1) < 1e-9, 'passthrough trim start');
assert(Math.abs(passthrough[0].trimEndSec - 5) < 1e-9, 'passthrough trim end');

console.log('verify-directors-cut: OK');
