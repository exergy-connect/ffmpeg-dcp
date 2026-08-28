import { LI_FEED_FORMAT } from './constants.js';

function sniffExt(bytes) {
  if (bytes?.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45) return 'webm';
  if (bytes?.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74) return 'mp4';
  return 'webm';
}

/**
 * Download source video and transcode to LinkedIn feed MP4 (li_feed).
 * @param {string} videoUrl
 * @param {object} options
 * @param {Function} options.createFfmpegModule
 * @param {object} [options.format]
 * @param {Function} [options.progress]
 * @param {Function} [options.log]
 */
export async function transcodeVideoFromUrl(videoUrl, options = {}) {
  const log = options.log ?? console.log;
  const progress = options.progress ?? (() => {});
  const fmt = { ...LI_FEED_FORMAT, ...(options.format || {}) };

  log(`Fetching source video: ${videoUrl}`);
  progress(0.05);
  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`Failed to download video (${response.status}): ${videoUrl}`);
  const inputBytes = new Uint8Array(await response.arrayBuffer());
  log(`Downloaded ${inputBytes.length} bytes`);

  if (!options.createFfmpegModule) {
    throw new Error('createFfmpegModule is required (require ffmpeg-dcp-social-v2/ffmpeg-wasm.js)');
  }

  progress(0.1);
  const Module = await options.createFfmpegModule();
  if (typeof Module.onRuntimeInitialized === 'function') {
    await new Promise((resolve) => {
      Module.onRuntimeInitialized = resolve;
    });
  }

  const inExt = sniffExt(inputBytes);
  const inPath = `/gh-in.${inExt}`;
  const tsPath = '/gh-out.ts';
  const mp4Path = '/gh-out.mp4';
  Module.FS.writeFile(inPath, inputBytes);

  const gop = (fmt.gopSeconds || 2) * (fmt.maxFps || 30);
  progress(0.2);
  log(`Transcoding to ${fmt.width}x${fmt.height} (${fmt.signature})`);
  const code = Module.ccall(
    'transcode_social_segment',
    'number',
    ['string', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'string'],
    [
      inPath,
      tsPath,
      fmt.width,
      fmt.height,
      fmt.bitrateKbps,
      fmt.audioBitrateKbps,
      gop,
      fmt.frameMode ?? 1,
      'libopenh264',
    ],
  );
  if (code < 0) throw new Error(`transcode_social_segment failed (${code})`);

  progress(0.85);
  const remuxCode = Module.ccall('remux_to_mp4', 'number', ['string', 'string'], [tsPath, mp4Path]);
  try { Module.FS.unlink(tsPath); } catch (_) { /* ignore */ }
  try { Module.FS.unlink(inPath); } catch (_) { /* ignore */ }
  if (remuxCode < 0) throw new Error(`remux_to_mp4 failed (${remuxCode})`);

  const mp4Bytes = Module.FS.readFile(mp4Path);
  try { Module.FS.unlink(mp4Path); } catch (_) { /* ignore */ }
  progress(0.95);
  log(`Transcoded MP4: ${mp4Bytes.length} bytes`);
  return mp4Bytes;
}
