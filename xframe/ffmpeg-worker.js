'use strict';

/**
 * xFrame social transcoder worker.
 * Uses the custom single-threaded dcp-transcode WASM API.
 * Paths resolve relative to this worker script (xframe/).
 */
importScripts('./ffmpeg-wasm/dcp-transcode-glue.js');

let modulePromise = null;
let lastFfmpegErr = [];

function getModule() {
  if (!modulePromise) {
    modulePromise = createFfmpegModule({
      instantiateWasm(imports, successCallback) {
        fetch('./ffmpeg-wasm/dcp-transcode.wasm')
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
    });
  }
  return modulePromise;
}

function requireSuccess(code, operation) {
  if (code >= 0) return;
  const detail = lastFfmpegErr.slice(-8).join(' | ');
  // WASI maps EINVAL to 28 ("Invalid argument"); WebM mux rejects H.264/AAC etc.
  let hint = '';
  if (code === -28 || /Only VP8 or VP9|webm/i.test(detail)) {
    hint = ' WebM output only allows VP8/VP9 (+ Opus/Vorbis). Use an in-page recording or a MediaRecorder .webm — not MP4/H.264.';
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

async function sliceVideo(inputBytes, targetChunkFrames) {
  const Module = await getModule();
  lastFfmpegErr = [];
  const useWebm = isEbmlContainer(inputBytes);
  const inPath = useWebm ? '/in.webm' : '/in.mp4';
  const outPrefix = '/chunk_';
  const ext = useWebm ? 'webm' : 'ts';
  const fn = useWebm ? 'slice_webm' : 'slice';

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
    const path = `${outPrefix}${String(i).padStart(3, '0')}.${ext}`;
    const bytes = Module.FS.readFile(path);
    chunks.push(bytes);
    const frames = Module.ccall('get_chunk_frame_count', 'number', ['number'], [i]);
    durations.push(saneFps > 0 && frames >= 0 ? frames / saneFps : 0);
    Module.FS.unlink(path);
  }
  Module.FS.unlink(inPath);
  return { chunks, durations, fps: saneFps, container: ext, slicer: fn };
}

async function remuxToMp4(tsBytes) {
  const Module = await getModule();
  lastFfmpegErr = [];
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

async function transcodeSocialSegment(chunkBytes, params = {}) {
  const Module = await getModule();
  lastFfmpegErr = [];
  const {
    width = 1280, height = 720, bitrateKbps = 6000, audioBitrateKbps = 160,
    gop = 60, frameMode = 1,
  } = params;
  const inExt = isEbmlContainer(chunkBytes) ? 'webm' : 'ts';
  const inPath = `/seg-in-${Math.random().toString(36).slice(2)}.${inExt}`;
  const outPath = `/seg-out-${Math.random().toString(36).slice(2)}.ts`;
  Module.FS.writeFile(inPath, chunkBytes);
  const code = Module.ccall(
    'transcode_social_segment', 'number',
    ['string', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'string'],
    [inPath, outPath, width, height, bitrateKbps, audioBitrateKbps, gop, frameMode, 'libopenh264'],
  );
  requireSuccess(code, 'transcode_social_segment');
  const out = Module.FS.readFile(outPath);
  Module.FS.unlink(inPath);
  Module.FS.unlink(outPath);
  return out;
}

const handlers = { sliceVideo, remuxToMp4, transcodeSocialSegment };

self.onmessage = async ({ data: { id, fn, args } }) => {
  try {
    const progress = (info) => self.postMessage({ id, progress: info });
    const result = await handlers[fn](...(args || []), progress);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
