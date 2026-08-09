'use strict';
// Compares all four encoders (libopenh264, libx264, libsvtav1, libx265) at
// matching settings: same input, same rendition, same target bitrate
// (and separately, each encoder's own real-CRF-equivalent quality mode)
// - output size is a rough quality/efficiency proxy at fixed bitrate,
// not a full VMAF/SSIM comparison.
const { transcodeSlice, generateTestClip } = require('../ffmpeg-wasm/ffmpeg-wrapper');
const fs = require('fs');

const ENCODERS = ['libopenh264', 'libx264', 'libsvtav1', 'libx265'];

async function runComparison(label, inputBytes) {
  console.log(`\n${label}: input = ${inputBytes.length} bytes`);
  const rendition = { width: 320, height: 240 };
  for (const bitrateKbps of [0, 400]) {
    for (const encoder of ENCODERS) {
      const t0 = Date.now();
      const out = await transcodeSlice(inputBytes, { ...rendition, bitrateKbps, encoder });
      const ms = Date.now() - t0;
      const mode = bitrateKbps > 0 ? `${bitrateKbps}kbps ABR` : 'quality mode (default)';
      console.log(`  ${encoder.padEnd(12)} ${mode.padEnd(24)} -> ${String(out.length).padStart(6)} bytes  (${ms}ms)`);
    }
  }
}

(async () => {
  // Warm-up call so per-encoder timings below don't get skewed by one-time
  // WASM module instantiation cost (getModule() caches the instance -
  // whichever encoder runs first would otherwise look artificially slow).
  await transcodeSlice(fs.readFileSync(__dirname + '/test-input.mp4'), { bitrateKbps: 0, encoder: 'libopenh264' });

  // A real chunk-sized clip (~10s, matching hls-transcode-job.js's target
  // chunk length) - rate control (and SVT-AV1's mini-GOP=16 lookahead
  // structure) isn't representative on a too-short clip.
  const chunkSizedClip = await generateTestClip(100, 20); // 10s @ 10fps, 2s GOPs
  await runComparison('Chunk-sized clip (100 frames, ~10s)', chunkSizedClip);

  console.log('\nOK');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
