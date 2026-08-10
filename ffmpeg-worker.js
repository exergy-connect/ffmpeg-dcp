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

// The only handler here - slicing and demo-clip generation moved to
// app.js (main thread), since the DCP fleet path depends on the chunk
// set they produce and needs to work without this Worker at all.
const handlers = { transcodeSegment };

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
