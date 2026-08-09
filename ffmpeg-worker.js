'use strict';

// Runs inside a dedicated Web Worker - this is where the actual wasm
// encode work happens now, not on the main thread. A single Module.ccall
// (especially reencode_for_chunking(), a full decode+re-encode of the
// whole input) is one uninterruptible synchronous block from JS's
// perspective - there's no way to yield mid-call on the main thread, so
// anything longer than a couple seconds reads as a frozen tab (and long
// enough triggers the browser's own "Page Unresponsive" warning).
// Confirmed live. A Worker has its own real thread, unlike the DCP
// sandbox this glue was originally built for - moving the work here
// means the main thread (and the page's own UI/progress bars/timers)
// never blocks on it at all, regardless of how long an encode takes.
//
// importScripts() runs the given script in this same worker global
// scope (unlike a page <script> tag's `window`, but the same idea) - so
// dcp-transcode-glue.js's top-level `var createFfmpegModule = (()=>{...})()`
// becomes accessible here the same way it becomes `window.createFfmpegModule`
// on the main thread. One difference from the main-thread version: a
// real Worker has a genuine `WorkerGlobalScope`, so the glue's own
// environment detection resolves to ENVIRONMENT_IS_WORKER natively -
// no shim needed here at all.
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
      // console.warn, not console.error: ffmpeg's own stderr carries every
      // internal log severity (info/warning/error) through one conduit,
      // with no per-line distinction available here - "N frames skipped"
      // (OpenH264's own rate-control diagnostic, expected with
      // allow_skip_frames enabled) is entirely normal, but console.error
      // renders in red with a stack trace in devtools regardless of the
      // message's actual severity, reading as "broken" when nothing is.
      // Genuine failures in this codebase are surfaced independently via
      // thrown exceptions/rejected promises (ccall return codes ->
      // `throw new Error(...)` in every wrapper function) - never only
      // via stderr text - so this stream is supplementary diagnostic
      // output, not the signal to watch for problems.
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

// Scrubbing-preview sprite sheet: samples maxThumbnails frames evenly
// spaced across the whole source (not per-chunk - this runs once against
// the original upload, same as reencodeForChunking() below), returns
// each as standalone JPEG bytes for the caller to composite into a
// sprite sheet + WebVTT map (canvas compositing is simpler done in JS
// than in C - see generate_thumbnails()'s own doc comment for why the
// wasm side only extracts individual frames, not the sprite sheet
// itself).
async function generateThumbnails(inputBytes, maxThumbnails, thumbWidth, thumbHeight) {
  const Module = await getModule();
  const inPath = '/thumbs-in.mp4';
  const prefix = '/thumb-';

  Module.FS.writeFile(inPath, inputBytes);
  const written = Module.ccall(
    'generate_thumbnails', 'number',
    ['string', 'string', 'number', 'number', 'number'],
    [inPath, prefix, maxThumbnails, thumbWidth, thumbHeight],
  );
  Module.FS.unlink(inPath);
  if (written < 0) throw new Error(`generate_thumbnails() failed with code ${written}`);

  const thumbnails = [];
  for (let i = 0; i < written; i++) {
    const path = `${prefix}${String(i).padStart(3, '0')}.jpg`;
    thumbnails.push(Module.FS.readFile(path));
    Module.FS.unlink(path);
  }
  return thumbnails;
}

async function reencodeForChunking(inputBytes, gopSize, outWidth = 0, outHeight = 0) {
  const Module = await getModule();
  const inPath = '/regop-in.mp4';
  const outPath = '/regop-out.mp4';

  Module.FS.writeFile(inPath, inputBytes);
  const ret = Module.ccall(
    'reencode_for_chunking', 'number',
    ['string', 'string', 'number', 'number', 'number'],
    [inPath, outPath, gopSize, outWidth, outHeight],
  );
  if (ret !== 0) {
    Module.FS.unlink(inPath);
    throw new Error(`reencode_for_chunking() failed with code ${ret}`);
  }
  const outBytes = Module.FS.readFile(outPath);
  Module.FS.unlink(inPath);
  Module.FS.unlink(outPath);
  return outBytes;
}

// A chunk this many times over target_chunk_frames is considered
// "oversized" and worth paying a re-encode for; below that, the native
// keyframe's chunk is just accepted as close enough. Arbitrary but
// reasonable - a real knob if this ever needs tuning, not a load-bearing
// constant.
const OVERSIZE_FACTOR = 2;

// The actual chunk-size fix: slice() is a cheap stream copy that can
// only ever cut at a keyframe the source already has, so on real-world
// video (commonly a 2-6s+ native keyframe interval) targetChunkFrames
// alone has no effect below that interval no matter how low it's set -
// confirmed live, chunks stayed identical across targets of 30/10/5 on
// one real test file. reencodeForChunking() forces a short GOP via a
// real decode+re-encode, but doing that over the WHOLE input is serial,
// one-machine, one-thread cost that scales with source length and
// doesn't touch the fleet at all - a real concern for "larger and
// larger videos", not just a config tweak away.
//
// This is the hybrid: slice cheaply first, at whatever native keyframes
// the source has (free, instant, most real-world content ends up
// reasonably close to target this way already). Only chunks that come
// out genuinely oversized get individually re-encoded and re-sliced -
// each pays for only ITS OWN size, not the full video's. A source with
// short, regular GOPs pays nothing extra at all; only the outliers cost
// anything.
// progress (optional): called with structured updates so the caller can
// show real feedback instead of one opaque "slicing" message for
// however long the oversized chunks take to work through - on a source
// where most/all chunks turn out oversized (typical for real-world
// video, whose GOPs commonly run longer than a sub-second target), that
// can be the majority of this function's wall-clock time.
async function sliceVideoAdaptive(inputBytes, targetChunkFrames, outWidth = 0, outHeight = 0, progress = () => {}) {
  const initial = await sliceVideo(inputBytes, targetChunkFrames);
  if (initial.fps <= 0) return initial; // no reliable fps - can't judge oversize, don't touch it

  const oversized = initial.durations.map(
    (d, i) => Math.round(d * initial.fps) > targetChunkFrames * OVERSIZE_FACTOR,
  );
  const reencodeTotal = oversized.filter(Boolean).length;
  progress({ phase: 'sliced', nativeChunks: initial.chunks.length, needsReencode: reencodeTotal });

  const chunks = [];
  const durations = [];
  let reencodeDone = 0;
  for (let i = 0; i < initial.chunks.length; i++) {
    if (oversized[i]) {
      reencodeDone++;
      progress({ phase: 'reencoding', current: reencodeDone, total: reencodeTotal });
      const regopped = await reencodeForChunking(initial.chunks[i], targetChunkFrames, outWidth, outHeight);
      const resliced = await sliceVideo(regopped, targetChunkFrames);
      chunks.push(...resliced.chunks);
      durations.push(...resliced.durations);
    } else {
      chunks.push(initial.chunks[i]);
      durations.push(initial.durations[i]);
    }
  }
  return { chunks, durations, fps: initial.fps };
}

async function generateTestClip(numFrames, gopSize, width = 0, height = 0, extraAudioTrack = 0, hdr = 0) {
  const Module = await getModule();
  const path = '/gen-test.mp4';
  const ret = Module.ccall(
    'generate_test_input', 'number',
    ['string', 'number', 'number', 'number', 'number', 'number', 'number'],
    [path, numFrames, gopSize, width, height, extraAudioTrack ? 1 : 0, hdr ? 1 : 0],
  );
  if (ret !== 0) throw new Error(`generate_test_input() failed with code ${ret}`);
  const bytes = Module.FS.readFile(path);
  Module.FS.unlink(path);
  return bytes;
}

const handlers = { transcodeSegment, sliceVideo, reencodeForChunking, sliceVideoAdaptive, generateTestClip, generateThumbnails };

// Minimal request/response RPC over postMessage - see ffmpeg-browser.js
// for the main-thread side. No Transferable/zero-copy handling: several
// call sites on the main thread reuse the same Uint8Array across
// multiple calls (e.g. one chunk transcoded once per rendition in the
// local race loop), and a transferred ArrayBuffer is detached
// (unusable) on the sending side afterward - correctness over a copy-
// avoidance optimization that would need per-call-site bookkeeping to
// use safely.
self.onmessage = async ({ data: { id, fn, args } }) => {
  try {
    // Passed as a trailing arg to every handler, not just
    // sliceVideoAdaptive (the only one that currently calls it) - extra
    // args are silently ignored by functions that don't declare a
    // matching parameter, so this doesn't need per-handler wiring.
    const progress = (info) => self.postMessage({ id, progress: info });
    const result = await handlers[fn](...args, progress);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
