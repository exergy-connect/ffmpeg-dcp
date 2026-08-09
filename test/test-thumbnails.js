'use strict';
// Exercises generate_thumbnails() directly - both against a synthetic
// clip (fast, deterministic) and test/videoplayback.mp4 (real footage,
// per this project's established pattern of catching bugs synthetic
// clips don't - see test-real-input.js). Writes the resulting JPEGs to
// test/thumbnails-output/ for manual visual inspection (not asserted
// automatically - "does this look like a real scrubbing preview" is a
// human judgment call).
const fs = require('fs').promises;
const { generateThumbnails, generateTestClip } = require('../ffmpeg-wasm/ffmpeg-wrapper');

const THUMB_COUNT = 8;
const THUMB_WIDTH = 120;
const THUMB_HEIGHT = 90;

async function runAndSave(label, inputBytes, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const t0 = Date.now();
  const thumbnails = await generateThumbnails(inputBytes, THUMB_COUNT, THUMB_WIDTH, THUMB_HEIGHT);
  const ms = Date.now() - t0;

  let totalBytes = 0;
  for (let i = 0; i < thumbnails.length; i++) {
    totalBytes += thumbnails[i].length;
    await fs.writeFile(`${outDir}/thumb-${String(i).padStart(3, '0')}.jpg`, thumbnails[i]);
  }
  console.log(`${label}: ${thumbnails.length}/${THUMB_COUNT} thumbnails, ${totalBytes} bytes total, ${ms}ms -> ${outDir}`);
  if (thumbnails.length !== THUMB_COUNT) {
    throw new Error(`expected ${THUMB_COUNT} thumbnails, got ${thumbnails.length}`);
  }
  for (const t of thumbnails) {
    // Baseline JPEG SOI marker - a real sanity check that this is a
    // decodable JPEG, not just "some bytes came back."
    if (t.length < 4 || t[0] !== 0xff || t[1] !== 0xd8) {
      throw new Error('thumbnail is missing the JPEG SOI marker (0xFFD8) - not a valid JPEG');
    }
  }
}

(async () => {
  const syntheticClip = await generateTestClip(150, 20); // 15s @ 10fps, matches other tests' chunk-sized clip
  await runAndSave('Synthetic clip (15s)', syntheticClip, __dirname + '/thumbnails-output/synthetic');

  const realBytes = await fs.readFile(__dirname + '/videoplayback.mp4');
  await runAndSave('videoplayback.mp4 (real footage)', realBytes, __dirname + '/thumbnails-output/real');

  console.log('\nOK');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
