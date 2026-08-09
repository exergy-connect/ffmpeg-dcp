'use strict';

// Requireable via job.requires(['./ffmpeg-wrapper']) - wasm-bytes.js and
// dcp-transcode-glue.js are transitive dependencies and ship without
// being listed explicitly (see the basic guide's transitive-crawl note).
//
// dcp-transcode-glue.js is real Emscripten MODULARIZE glue, not a
// hand-written wrapper - this program needs full libc/MEMFS/C++ runtime,
// not standalone wasm. Built with -sENVIRONMENT=web,worker: excluding
// "node" removes require('node:fs')/require('node:crypto') from the
// glue's dead Node branch, which otherwise breaks DCP's webpack-based
// job.requires() bundler even though that code never runs in the sandbox
// (see the how-to doc).
//
// This build's environment check is `!!globalThis.WorkerGlobalScope` (a
// real Worker constructor), not importScripts-based - whether the sandbox
// defines that constructor natively is unconfirmed, so a truthy stand-in
// is set here before requiring the glue. instantiateWasm below is what
// actually controls wasm loading either way; this only needs environment
// detection to land on ENVIRONMENT_IS_WORKER.
if (typeof globalThis.WorkerGlobalScope === 'undefined') {
  globalThis.WorkerGlobalScope = function WorkerGlobalScope() {};
}
// The sandbox already provides `self.location`; plain Node (used both by
// this module's own local test scripts and by any client-side/pre-dispatch
// tooling that reuses this same wrapper, e.g. the slicer) does not.
if (typeof globalThis.self === 'undefined') {
  globalThis.self = { location: { href: 'node://local' } };
}

const createFfmpegModule = require('./dcp-transcode-glue');
const wasmBase64 = require('./wasm-bytes');

let modulePromise = null;

function getModule() {
  if (!modulePromise) {
    // Module["wasmBinary"] is never read by this glue - instantiateWasm
    // is the actual override hook for supplying the bytes directly.
    const wasmBytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));
    modulePromise = createFfmpegModule({
      instantiateWasm(imports, successCallback) {
        WebAssembly.instantiate(wasmBytes, imports).then((result) => {
          successCallback(result.instance);
        });
      },
      // Explicit rather than relying on Emscripten's default - dcp-transcode.c's
      // fprintf(stderr, ...) needs somewhere to actually go.
      print: (text) => console.log(text),
      printErr: (text) => console.error(text),
    });
  }
  return modulePromise;
}

/**
 * Transcodes a video slice.
 * @param {Uint8Array} sliceBytes - input video bytes (e.g. an MPEG-TS/MP4 chunk)
 * @param {{width?: number, height?: number, bitrateKbps?: number, encoder?: string}} params
 *   width/height: output rendition size (0/omitted = keep source size)
 *   bitrateKbps: target bitrate (0/omitted = quality mode - see the how-to
 *     doc's bake-off section for what that means per encoder)
 *   encoder: 'libopenh264' (default), 'libx264', or 'libsvtav1'
 * @returns {Promise<Uint8Array>} transcoded output bytes (MP4)
 */
async function transcodeSlice(sliceBytes, params = {}) {
  const Module = await getModule();
  const { width = 0, height = 0, bitrateKbps = 0, encoder = 'libopenh264' } = params;

  const inPath = '/slice-in.mp4';
  const outPath = '/slice-out.mp4';

  Module.FS.writeFile(inPath, sliceBytes);

  const ret = Module.ccall(
    'transcode', 'number',
    ['string', 'string', 'number', 'number', 'number', 'string'],
    [inPath, outPath, width, height, bitrateKbps, encoder],
  );
  if (ret !== 0) {
    Module.FS.unlink(inPath);
    throw new Error(`transcode() failed with code ${ret}`);
  }

  const outBytes = Module.FS.readFile(outPath);
  Module.FS.unlink(inPath);
  Module.FS.unlink(outPath);
  return outBytes;
}

/**
 * Transcodes one MPEG-TS chunk (from sliceVideo() below) to an HLS-ready
 * MPEG-TS segment at the requested rendition. Same shape as
 * transcodeSlice, different container - this is the function the DCP
 * work function actually calls per (chunk, rendition) unit.
 * @param {Uint8Array} chunkBytes
 * @param {{width?: number, height?: number, bitrateKbps?: number, encoder?: string}} params
 * @returns {Promise<Uint8Array>}
 */
async function transcodeSegment(chunkBytes, params = {}) {
  const Module = await getModule();
  const { width = 0, height = 0, bitrateKbps = 0, encoder = 'libopenh264' } = params;

  const inPath = '/chunk-in.ts';
  const outPath = '/chunk-out.ts';

  Module.FS.writeFile(inPath, chunkBytes);
  const ret = Module.ccall(
    'transcode_segment', 'number',
    ['string', 'string', 'number', 'number', 'number', 'string'],
    [inPath, outPath, width, height, bitrateKbps, encoder],
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

/**
 * Client-side (local, pre-dispatch) helper: re-encodes a video at its
 * own resolution/quality, forcing a keyframe every gopSize frames. Real
 * cost - a full decode+re-encode pass, not free - but sliceVideo() below
 * can only ever cut at keyframes the input ALREADY has, so on sources
 * with a longer native keyframe interval than gopSize (very common with
 * real-world video - a 2-6s GOP is typical), sliceVideo()'s
 * targetChunkFrames has no effect below that interval no matter how low
 * it's set. Call this first, then sliceVideo() on ITS output with the
 * same target, when you need chunk size to actually be small and
 * predictable rather than whatever the source's own GOP happens to be.
 * @param {Uint8Array} inputBytes
 * @param {number} gopSize - keyframe interval, in frames, to force
 * @param {number} [outWidth=0] - cap output resolution (0 = keep
 *   source) - since this is an intermediate re-encoded again per
 *   rendition anyway, capping at the largest rendition you actually
 *   need saves real encode time with no quality loss (measured: ~32s
 *   at source resolution vs. much less capped at 320x240, on a 12s/
 *   3.4MB real test clip)
 * @param {number} [outHeight=0]
 * @returns {Promise<Uint8Array>}
 */
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

/**
 * Client-side (local, pre-dispatch) helper: splits a video into
 * closed-GOP MPEG-TS chunks via stream copy. If the input has an audio
 * track, it's split at the same chunk boundaries and stream-copied
 * alongside the video in every chunk (chunk boundaries themselves are
 * still video-keyframe-driven only).
 * @param {Uint8Array} inputBytes
 * @param {number} targetChunkFrames - chunk boundaries land on the first
 *   keyframe at or after this many frames since the chunk started, so
 *   actual chunk length varies with source GOP placement - see
 *   reencodeForChunking() above if you need a hard guarantee instead
 * @returns {Promise<{chunks: Uint8Array[], durations: number[], fps: number}>}
 *   durations[i] (seconds) is frame-count-based, for HLS #EXTINF tags
 */
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

/**
 * Client-side (local, pre-dispatch) helper: samples up to maxThumbnails
 * frames evenly spaced across the whole input's duration, each scaled to
 * thumbWidth x thumbHeight, for a scrubbing-preview sprite sheet. Runs
 * once against the original upload (like reencodeForChunking above), not
 * per-chunk. See generate_thumbnails() in dcp-transcode.c for why this
 * only extracts individual JPEG frames rather than composing the sprite
 * sheet itself (canvas compositing is simpler done in JS).
 * @param {Uint8Array} inputBytes
 * @param {number} maxThumbnails
 * @param {number} thumbWidth
 * @param {number} thumbHeight
 * @returns {Promise<Uint8Array[]>} one standalone JPEG per thumbnail
 */
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

/**
 * Client-side (local) test-only helper: generates a synthetic H.264/MP4
 * clip. Not part of the work-function API.
 * @param {number} numFrames
 * @param {number} gopSize - keyframe interval, in frames
 * @returns {Promise<Uint8Array>}
 */
async function generateTestClip(numFrames, gopSize) {
  const Module = await getModule();
  const path = '/gen-test.mp4';
  const ret = Module.ccall(
    'generate_test_input', 'number',
    ['string', 'number', 'number'],
    [path, numFrames, gopSize],
  );
  if (ret !== 0) throw new Error(`generate_test_input() failed with code ${ret}`);
  const bytes = Module.FS.readFile(path);
  Module.FS.unlink(path);
  return bytes;
}

module.exports = { transcodeSlice, transcodeSegment, sliceVideo, reencodeForChunking, generateTestClip, generateThumbnails };
