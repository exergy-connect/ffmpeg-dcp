'use strict';

/**
 * xFrame social transcoder worker.
 * Uses the custom single-threaded dcp-transcode WASM API.
 *
 * Canonical artifacts are checked in once at xframe/ffmpeg-wasm/.
 * This worker may run from xframe/ or from the staged xframe/output/ tree
 * (GitHub Pages); resolve the directory accordingly.
 */
function wasmDirUrl() {
  const path = String(self.location.pathname || '');
  // .../xframe/output/ffmpeg-worker.js → ../ffmpeg-wasm/
  // .../xframe/ffmpeg-worker.js        → ./ffmpeg-wasm/
  const relative = /\/output\//.test(path) ? '../ffmpeg-wasm/' : './ffmpeg-wasm/';
  return new URL(relative, self.location.href).href;
}

const WASM_DIR = wasmDirUrl();
importScripts(new URL('dcp-transcode-glue.js', WASM_DIR).href);

let modulePromise = null;
let lastFfmpegErr = [];
let activeWasmProgress = null;

function getModule() {
  if (!modulePromise) {
    modulePromise = createFfmpegModule({
      instantiateWasm(imports, successCallback) {
        fetch(new URL('dcp-transcode.wasm', WASM_DIR).href)
          .then((response) => {
            if (!response.ok) throw new Error(`WASM fetch failed: HTTP ${response.status}`);
            return response.arrayBuffer();
          })
          .then((bytes) => WebAssembly.instantiate(bytes, imports))
          .then((result) => successCallback(result.instance, result.module));
        return {};
      },
      print: (text) => console.log('[ffmpeg]', text),
      printErr: (text) => {
        console.warn('[ffmpeg]', text);
        lastFfmpegErr.push(String(text));
        if (lastFfmpegErr.length > 40) lastFfmpegErr.shift();
      },
      onTranscodeProgress: (ratio, processedFrames, totalFrames) => {
        if (!activeWasmProgress) return;
        activeWasmProgress({
          phase: 'transcode',
          ratio: ratio >= 0 ? ratio : null,
          processedFrames,
          totalFrames: totalFrames > 0 ? totalFrames : null,
        });
      },
    });
  }
  return modulePromise;
}

function requireSuccess(code, operation) {
  if (code >= 0) return;
  const detail = lastFfmpegErr.slice(-8).join(' | ');
  // WASI maps EINVAL to 28 ("Invalid argument"); the WebM muxer also uses that
  // for H.264/AAC — only attach the WebM hint when the muxer actually said so.
  let hint = '';
  if (/Only VP8 or VP9/i.test(detail) && /webm/i.test(detail)) {
    hint = ' WebM muxing only allows VP8/VP9 (+ Opus/Vorbis). Drop a .webm recording or a .mp4 — this path should not slice MP4 into WebM.';
  }
  throw new Error(
    `${operation} failed with code ${code}.${hint}` +
    (detail ? ` (${detail})` : ''),
  );
}

/** EBML/WebM/Matroska magic (1A 45 DF A3). */
function isEbmlContainer(bytes) {
  return bytes && bytes.length >= 4 &&
    bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

/** ISO BMFF / MP4 magic (... ftyp). */
function isMp4Container(bytes) {
  if (!bytes || bytes.length < 8) return false;
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

/** MEMFS extension so FFmpeg probes the real container, not MPEG-TS. */
function sniffChunkExt(bytes) {
  if (isEbmlContainer(bytes)) return 'webm';
  if (isMp4Container(bytes)) return 'mp4';
  return 'ts';
}

const TS_PACKET_LEN = 188;
const PTS_MOD = 0x200000000; // 2^33

function readPts33(u8, i) {
  return ((u8[i] >> 1) & 0x07) * 0x40000000
    + u8[i + 1] * 0x400000
    + ((u8[i + 2] >> 1) & 0x7f) * 0x8000
    + u8[i + 3] * 0x80
    + (u8[i + 4] >> 1);
}

function writePts33(u8, i, pts) {
  const prefix = u8[i] >> 4;
  pts = ((pts % PTS_MOD) + PTS_MOD) % PTS_MOD;
  u8[i] = (prefix << 4) | ((Math.floor(pts / 0x40000000) & 0x07) << 1) | 1;
  u8[i + 1] = Math.floor(pts / 0x400000) & 0xff;
  u8[i + 2] = ((Math.floor(pts / 0x8000) & 0x7f) << 1) | 1;
  u8[i + 3] = Math.floor(pts / 0x80) & 0xff;
  u8[i + 4] = ((pts & 0x7f) << 1) | 1;
}

function forEachTsPacketOffset(bytes, fn) {
  let i = 0;
  const n = bytes.length;
  while (i + TS_PACKET_LEN <= n) {
    if (bytes[i] !== 0x47) {
      const next = bytes.indexOf(0x47, i);
      if (next < 0 || next + TS_PACKET_LEN > n) break;
      i = next;
    }
    fn(i);
    i += TS_PACKET_LEN;
  }
}

function tsPid(packet) {
  return ((packet[1] & 0x1f) << 8) | packet[2];
}

/** PES PTS/DTS live in the first packet of a PES (PUSI). */
function visitPesTimestamps(packet, fn) {
  if (packet[0] !== 0x47 || !(packet[1] & 0x40)) return;
  const afc = (packet[3] >> 4) & 0x03;
  let i = 4;
  if (afc & 0x02) i = 5 + packet[4];
  if (!(afc & 0x01) || i + 14 > TS_PACKET_LEN) return;
  if (packet[i] !== 0 || packet[i + 1] !== 0 || packet[i + 2] !== 1) return;
  const streamId = packet[i + 3];
  if (streamId === 0xbe || streamId === 0xbf || streamId < 0xbd) return;
  if ((packet[i + 6] & 0xc0) !== 0x80) return;
  const flags = (packet[i + 7] >> 6) & 0x03;
  if (flags < 2) return;
  const ptsOff = i + 9;
  if (ptsOff + 5 > TS_PACKET_LEN) return;
  fn(ptsOff, 'pts');
  if (flags === 3 && ptsOff + 10 <= TS_PACKET_LEN) fn(ptsOff + 5, 'dts');
}

function ensurePidState(pidState, pid) {
  let st = pidState.get(pid);
  if (!st) {
    st = { cc: 0, lastPts: -1, lastDelta: 0, offset: 0 };
    pidState.set(pid, st);
  }
  return st;
}

/**
 * Each DCP social segment is a standalone MPEG-TS that restarts PTS/DTS at 0
 * and resets continuity counters. Byte-concat then remux_to_mp4 trips
 * "non monotonically increasing dts" and "Packet corrupt". Restitch PES
 * timestamps and CC across segment boundaries before the remux.
 */
function stitchMpegTsSegments(parts) {
  const segs = (parts || []).filter((p) => p && p.length);
  if (segs.length <= 1) return segs[0] || new Uint8Array(0);

  const pidState = new Map();
  const rewritten = segs.map((part) => {
    const firstPts = new Map();
    forEachTsPacketOffset(part, (off) => {
      const packet = part.subarray(off, off + TS_PACKET_LEN);
      const pid = tsPid(packet);
      visitPesTimestamps(packet, (ptsOff, kind) => {
        if (kind === 'pts' && !firstPts.has(pid)) firstPts.set(pid, readPts33(packet, ptsOff));
      });
    });
    for (const [pid, pts] of firstPts) {
      const st = ensurePidState(pidState, pid);
      if (st.lastPts >= 0) {
        const step = st.lastDelta > 0 ? st.lastDelta : 1;
        st.offset = st.lastPts + step - pts;
      }
    }

    const out = new Uint8Array(part);
    forEachTsPacketOffset(out, (off) => {
      const packet = out.subarray(off, off + TS_PACKET_LEN);
      const pid = tsPid(packet);
      const st = ensurePidState(pidState, pid);
      const afc = (packet[3] >> 4) & 0x03;
      if (afc & 0x01) {
        packet[3] = (packet[3] & 0xf0) | (st.cc & 0x0f);
        st.cc = (st.cc + 1) & 0x0f;
      }
      visitPesTimestamps(packet, (ptsOff, kind) => {
        const next = readPts33(packet, ptsOff) + st.offset;
        writePts33(packet, ptsOff, next);
        if (kind === 'pts') {
          if (st.lastPts >= 0) {
            const d = next - st.lastPts;
            if (d > 0) st.lastDelta = d;
          }
          st.lastPts = next;
        }
      });
    });
    return out;
  });

  const total = rewritten.reduce((n, p) => n + p.length, 0);
  const concat = new Uint8Array(total);
  let o = 0;
  for (const p of rewritten) { concat.set(p, o); o += p.length; }
  return concat;
}

async function sliceViaCcall(Module, inputBytes, fn, inExt, outExt, targetChunkFrames) {
  lastFfmpegErr = [];
  const inPath = `/in.${inExt}`;
  const outPrefix = '/chunk_';
  Module.FS.writeFile(inPath, inputBytes);
  const chunkCount = Module.ccall(
    fn, 'number',
    ['string', 'string', 'number'],
    [inPath, outPrefix, targetChunkFrames || 90],
  );
  requireSuccess(chunkCount, fn);
  if (chunkCount === 0) throw new Error(`${fn} produced no chunks`);

  const fps = Module.ccall('get_source_fps', 'number', [], []);
  // MediaRecorder WebM often reports bogus avg_frame_rate (e.g. 1000).
  const saneFps = (Number.isFinite(fps) && fps >= 1 && fps <= 120) ? fps : 30;
  const chunks = [];
  const durations = [];
  for (let i = 0; i < chunkCount; i++) {
    const path = `${outPrefix}${String(i).padStart(3, '0')}.${outExt}`;
    const bytes = Module.FS.readFile(path);
    chunks.push(bytes);
    const frames = Module.ccall('get_chunk_frame_count', 'number', ['number'], [i]);
    durations.push(saneFps > 0 && frames >= 0 ? frames / saneFps : 0);
    Module.FS.unlink(path);
  }
  Module.FS.unlink(inPath);
  return { chunks, durations, fps: saneFps, container: outExt, slicer: fn };
}

async function sliceVideo(inputBytes, targetChunkFrames) {
  const Module = await getModule();
  const kind = sniffChunkExt(inputBytes);

  if (kind === 'webm') {
    return sliceViaCcall(Module, inputBytes, 'slice_webm', 'webm', 'webm', targetChunkFrames);
  }

  if (kind === 'mp4') {
    // MPEG-TS `slice()` muxes VP9 as private data; encode then reports "no video".
    // `slice_mp4` exists after a WASM rebuild; until then keep the MP4 intact.
    if (typeof Module._slice_mp4 === 'function') {
      return sliceViaCcall(Module, inputBytes, 'slice_mp4', 'mp4', 'mp4', targetChunkFrames);
    }
    return {
      chunks: [inputBytes],
      durations: [0],
      fps: 30,
      container: 'mp4',
      slicer: 'passthrough-mp4',
    };
  }

  return sliceViaCcall(Module, inputBytes, 'slice', 'mp4', 'ts', targetChunkFrames);
}

async function remuxToMp4(tsBytesOrParts) {
  const Module = await getModule();
  lastFfmpegErr = [];
  const parts = Array.isArray(tsBytesOrParts) ? tsBytesOrParts : [tsBytesOrParts];
  const tsBytes = stitchMpegTsSegments(parts);
  const inPath = `/remux-in-${Math.random().toString(36).slice(2)}.ts`;
  const outPath = `/remux-out-${Math.random().toString(36).slice(2)}.mp4`;
  Module.FS.writeFile(inPath, tsBytes);
  const code = Module.ccall(
    'remux_to_mp4', 'number',
    ['string', 'string'],
    [inPath, outPath],
  );
  requireSuccess(code, 'remux_to_mp4');
  const out = Module.FS.readFile(outPath);
  Module.FS.unlink(inPath);
  Module.FS.unlink(outPath);
  return out;
}

async function extractTimeRange(inputBytes, startSec, endSec, opts = {}) {
  const Module = await getModule();
  if (typeof Module._extract_time_range !== 'function') {
    throw new Error(
      'extract_time_range is missing from the WASM module. Rebuild xframe/ffmpeg-wasm ' +
      '(docker build via ffmpeg-wasm/build.sh) to enable frame-accurate director’s cuts.',
    );
  }
  lastFfmpegErr = [];
  const inExt = sniffChunkExt(inputBytes);
  const inPath = `/cut-in-${Math.random().toString(36).slice(2)}.${inExt === 'ts' ? 'mp4' : inExt}`;
  const outPath = `/cut-out-${Math.random().toString(36).slice(2)}.ts`;
  Module.FS.writeFile(inPath, inputBytes);
  const code = Module.ccall(
    'extract_time_range', 'number',
    ['string', 'string', 'number', 'number', 'number', 'number'],
    [
      inPath,
      outPath,
      Number(startSec) || 0,
      Number(endSec) || 0,
      opts.videoBitrateKbps || 6000,
      opts.audioBitrateKbps || 160,
    ],
  );
  requireSuccess(code, 'extract_time_range');
  const out = Module.FS.readFile(outPath);
  Module.FS.unlink(inPath);
  Module.FS.unlink(outPath);
  return out;
}

/**
 * Stage an ordered director's-cut program into one H.264/AAC MP4.
 * Full-duration single-slice programs return the original bytes unchanged.
 */
async function stageDirectorsCut(inputBytes, slices, sourceDurationSec, onProgress) {
  const duration = Number(sourceDurationSec);
  const cleaned = (slices || [])
    .map((slice) => ({
      start: Math.max(0, Number(slice.start) || 0),
      end: Math.max(0, Number(slice.end) || 0),
    }))
    .filter((slice) => slice.end - slice.start >= 0.05)
    .map((slice) => {
      if (!(duration > 0)) return slice;
      return {
        start: Math.min(duration, slice.start),
        end: Math.min(duration, slice.end),
      };
    })
    .filter((slice) => slice.end - slice.start >= 0.05);

  if (!cleaned.length) {
    throw new Error('Director’s cut has no valid slices to stage.');
  }

  const isFull = cleaned.length === 1
    && cleaned[0].start <= 0.001
    && (!(duration > 0) || Math.abs(cleaned[0].end - duration) <= 0.05);
  if (isFull) {
    if (onProgress) onProgress({ phase: 'passthrough', index: 0, total: 1 });
    return { bytes: inputBytes, staged: false, sliceCount: 1 };
  }

  const parts = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (onProgress) onProgress({ phase: 'extract', index: i, total: cleaned.length });
    parts.push(await extractTimeRange(inputBytes, cleaned[i].start, cleaned[i].end));
  }
  if (onProgress) onProgress({ phase: 'remux', index: cleaned.length, total: cleaned.length });
  const mp4 = await remuxToMp4(parts);
  return { bytes: mp4, staged: true, sliceCount: cleaned.length };
}

async function transcodeSocialSegment(chunkBytes, params = {}, onProgress) {
  const Module = await getModule();
  lastFfmpegErr = [];
  const {
    width = 1280, height = 720, bitrateKbps = 6000, audioBitrateKbps = 160,
    gop = 60, frameMode = 1,
  } = params;
  const inExt = sniffChunkExt(chunkBytes);
  const inPath = `/seg-in-${Math.random().toString(36).slice(2)}.${inExt}`;
  const outPath = `/seg-out-${Math.random().toString(36).slice(2)}.ts`;
  Module.FS.writeFile(inPath, chunkBytes);
  activeWasmProgress = onProgress || null;
  try {
    const code = Module.ccall(
      'transcode_social_segment', 'number',
      ['string', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'string'],
      [inPath, outPath, width, height, bitrateKbps, audioBitrateKbps, gop, frameMode, 'libopenh264'],
    );
    requireSuccess(code, 'transcode_social_segment');
    return Module.FS.readFile(outPath);
  } finally {
    activeWasmProgress = null;
    try { Module.FS.unlink(inPath); } catch (_) { /* ignore cleanup errors */ }
    try { Module.FS.unlink(outPath); } catch (_) { /* ignore cleanup errors */ }
  }
}

const handlers = { sliceVideo, remuxToMp4, transcodeSocialSegment, stageDirectorsCut, extractTimeRange };

self.onmessage = async ({ data: { id, fn, args } }) => {
  try {
    const progress = (info) => self.postMessage({ id, progress: info });
    const result = await handlers[fn](...(args || []), progress);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
