'use strict';

// Thin RPC client for ffmpeg-worker.js, which does the actual wasm work
// off the main thread (see that file's header comment for why: a single
// Module.ccall - especially a full-source re-encode - is one
// uninterruptible synchronous block, long enough to freeze the tab and
// trigger the browser's own "Page Unresponsive" warning; confirmed
// live). Keeps the exact same window.ffmpegBrowser API this had when it
// ran the wasm module directly on the main thread, so app.js didn't need
// any changes for this move.

const worker = new Worker('./ffmpeg-worker.js');
let nextId = 1;
const pending = new Map();

worker.onmessage = ({ data: { id, result, error, progress } }) => {
  const p = pending.get(id);
  if (!p) return;
  if (progress !== undefined) {
    if (p.onProgress) p.onProgress(progress);
    return; // more messages (progress updates, then the final result) still coming
  }
  pending.delete(id);
  if (error) p.reject(new Error(error));
  else p.resolve(result);
};
worker.onerror = (err) => {
  // A worker-level error (e.g. a script load failure) has no request id
  // to match to a specific pending call - reject everything outstanding
  // rather than leaving those promises hanging forever.
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(new Error(`ffmpeg worker error: ${err.message || err}`));
  }
};

function call(fn, args, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, fn, args });
  });
}

async function transcodeSegment(chunkBytes, params = {}) {
  return call('transcodeSegment', [chunkBytes, params]);
}
async function sliceVideo(inputBytes, targetChunkFrames) {
  return call('sliceVideo', [inputBytes, targetChunkFrames]);
}
async function reencodeForChunking(inputBytes, gopSize, outWidth = 0, outHeight = 0) {
  return call('reencodeForChunking', [inputBytes, gopSize, outWidth, outHeight]);
}
async function sliceVideoAdaptive(inputBytes, targetChunkFrames, outWidth = 0, outHeight = 0, onProgress) {
  return call('sliceVideoAdaptive', [inputBytes, targetChunkFrames, outWidth, outHeight], onProgress);
}
async function generateTestClip(numFrames, gopSize, width = 0, height = 0, extraAudioTrack = 0, hdr = 0) {
  return call('generateTestClip', [numFrames, gopSize, width, height, extraAudioTrack, hdr]);
}
async function generateThumbnails(inputBytes, maxThumbnails, thumbWidth, thumbHeight) {
  return call('generateThumbnails', [inputBytes, maxThumbnails, thumbWidth, thumbHeight]);
}

window.ffmpegBrowser = { transcodeSegment, sliceVideo, reencodeForChunking, sliceVideoAdaptive, generateTestClip, generateThumbnails };
