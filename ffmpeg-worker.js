'use strict';

// Runs in a dedicated Web Worker so a long Module.ccall (one
// uninterruptible synchronous block - no yielding mid-call) never
// freezes the main thread's UI.
//
// importScripts() puts dcp-transcode-glue.js's createFfmpegModule into
// this worker's own global scope, the same way a <script> tag would put
// it on `window` - and since this really is a WorkerGlobalScope, the
// glue's own environment detection just works, no shim needed.
importScripts('./ffmpeg-wasm/dcp-transcode-glue.js');

let modulePromise = null;
function getModule() {
  if (!modulePromise) {
    modulePromise = createFfmpegModule({
      instantiateWasm(imports, successCallback) {
        fetch('./ffmpeg-wasm/dcp-transcode.wasm')
          .then((r) => r.arrayBuffer())
          .then((bytes) => WebAssembly.instantiate(bytes, imports))
          .then((result) => successCallback(result.instance));
      },
      print: (text) => console.log('[wasm worker]', text),
      // console.warn not console.error: ffmpeg's stderr mixes real errors
      // with expected diagnostics (e.g. OpenH264's "N frames skipped");
      // genuine failures surface separately via thrown errors/ccall codes.
      printErr: (text) => console.warn('[wasm worker]', text),
    });
  }
  return modulePromise;
}

// Local race only - runs the same transcode_segment() call as the fleet's
// workFunction (see dispatchJob in app.js), but in this tab's own worker.
async function transcodeSegment(chunkBytes, params = {}) {
  const Module = await getModule();
  const { width = 0, height = 0, bitrateKbps = 0, encoder = 'libopenh264', normalizeLoudness = 0 } = params;
  const inPath = `/chunk-in-${Math.random().toString(36).slice(2)}.ts`;
  const outPath = `/chunk-out-${Math.random().toString(36).slice(2)}.ts`;

  Module.FS.writeFile(inPath, chunkBytes);
  const ret = Module.ccall(
    'transcode_segment', 'number',
    ['string', 'string', 'number', 'number', 'number', 'string', 'number'],
    [inPath, outPath, width, height, bitrateKbps, encoder, normalizeLoudness ? 1 : 0],
  );
  if (ret !== 0) {
    Module.FS.unlink(inPath);
    throw new Error(`transcode_segment() failed with code ${ret}`);
  }
  const outBytes = Module.FS.readFile(outPath);
  Module.FS.unlink(inPath);
  Module.FS.unlink(outPath);
  return outBytes;
}

// Slicing + demo-clip generation, moved here from app.js (main thread).
async function sliceVideo(inputBytes, targetChunkFrames) {
  const Module = await getModule();
  const inPath = '/slicer-in.mp4';
  const prefix = '/slicer-chunk-';

  Module.FS.writeFile(inPath, inputBytes);
  const chunkCount = Module.ccall(
    'slice', 'number',
    ['string', 'string', 'number'],
    [inPath, prefix, targetChunkFrames],
  );
  Module.FS.unlink(inPath);
  if (chunkCount < 0) throw new Error(`slice() failed with code ${chunkCount}`);

  const fps = Module.ccall('get_source_fps', 'number', [], []);
  const chunks = [];
  const durations = [];
  for (let i = 0; i < chunkCount; i++) {
    const path = `${prefix}${String(i).padStart(3, '0')}.ts`;
    chunks.push(Module.FS.readFile(path));
    Module.FS.unlink(path);
    const frameCount = Module.ccall('get_chunk_frame_count', 'number', ['number'], [i]);
    durations.push(fps > 0 ? frameCount / fps : 0);
  }
  return { chunks, durations, fps };
}

const handlers = { transcodeSegment, sliceVideo };

// Minimal request/response RPC over postMessage - see the RPC client at
// the top of app.js for the main-thread side. No Transferable/zero-copy:
// callers reuse the same Uint8Array across multiple calls, which a
// transfer would detach after the first.
self.onmessage = async ({ data: { id, fn, args } }) => {
  try {
    // Trailing arg to every handler; ignored by any that don't declare it.
    const progress = (info) => self.postMessage({ id, progress: info });
    const result = await handlers[fn](...args, progress);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
