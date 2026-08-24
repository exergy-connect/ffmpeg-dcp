'use strict';

/**
 * xFrame social transcoder worker.
 * Uses the custom single-threaded dcp-transcode WASM API.
 * Paths resolve relative to this worker script (xframe/).
 */
importScripts('./ffmpeg-wasm/dcp-transcode-glue.js');

let modulePromise = null;

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
      printErr: (text) => console.warn('[ffmpeg]', text),
    });
  }
  return modulePromise;
}

function requireSuccess(code, operation) {
  if (code < 0) throw new Error(`${operation} failed with code ${code}`);
}

async function sliceVideo(inputBytes, targetChunkFrames) {
  const Module = await getModule();
  const inPath = '/in.webm';
  const outPrefix = '/chunk_';
  Module.FS.writeFile(inPath, inputBytes);
  const chunkCount = Module.ccall(
    'slice_webm', 'number',
    ['string', 'string', 'number'],
    [inPath, outPrefix, targetChunkFrames || 90],
  );
  requireSuccess(chunkCount, 'slice_webm');
  if (chunkCount === 0) throw new Error('slice_webm produced no chunks');

  const fps = Module.ccall('get_source_fps', 'number', [], []);
  const chunks = [];
  const durations = [];
  for (let i = 0; i < chunkCount; i++) {
    const path = `${outPrefix}${String(i).padStart(3, '0')}.webm`;
    const bytes = Module.FS.readFile(path);
    chunks.push(bytes);
    const frames = Module.ccall('get_chunk_frame_count', 'number', ['number'], [i]);
    durations.push(fps > 0 && frames >= 0 ? frames / fps : 0);
    Module.FS.unlink(path);
  }
  Module.FS.unlink(inPath);
  return { chunks, durations, fps };
}

async function remuxToMp4(tsBytes) {
  const Module = await getModule();
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
  const {
    width = 1280, height = 720, bitrateKbps = 6000, audioBitrateKbps = 160,
    gop = 60, frameMode = 1,
  } = params;
  const inPath = `/seg-in-${Math.random().toString(36).slice(2)}.webm`;
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
