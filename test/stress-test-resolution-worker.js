'use strict';
// Runs ONE resolution in its own fresh process (invoked by
// stress-test-resolution.js via child_process.spawnSync, not required
// directly) - same reasoning as stress-test-worker.js: wasm's
// ALLOW_MEMORY_GROWTH heap only grows within a process, so testing
// multiple sizes in one process would make later (bigger) sizes fail
// earlier than they really would on their own.
//
// Frame count is fixed and small (see NUM_FRAMES below) - this is
// testing resolution's effect on per-frame decode/scale/encode buffer
// size, not duration's effect on total chunk count (stress-test.js
// already covers that axis). generate_test_input() now takes width/
// height directly (previously hardcoded to 320x240 - parameterized
// specifically to make this test possible).
const { transcodeSegment, sliceVideo, generateTestClip } = require('../ffmpeg-wasm/ffmpeg-wrapper');

const NUM_FRAMES = 30; // 3s @ 10fps - long enough to be meaningful, short enough that duration isn't the variable under test
const GOP_SIZE = 10;

async function main() {
  const width = Number(process.argv[2]);
  const height = Number(process.argv[3]);

  const result = { width, height };

  let t0 = Date.now();
  const clip = await generateTestClip(NUM_FRAMES, GOP_SIZE, width, height);
  result.generateMs = Date.now() - t0;
  result.clipBytes = clip.length;

  t0 = Date.now();
  const { chunks } = await sliceVideo(clip, 90);
  result.sliceMs = Date.now() - t0;
  result.chunkCount = chunks.length;

  // Downscale to a real ABR rendition size (320x240) - this is the
  // realistic case (large source, small delivery renditions), and
  // exercises libswscale at the actual resolution gap being tested,
  // not just the decoder.
  t0 = Date.now();
  const out = await transcodeSegment(chunks[0], { width: 320, height: 240, bitrateKbps: 500 });
  result.transcodeMs = Date.now() - t0;
  result.outputBytes = out.length;

  result.memoryUsage = process.memoryUsage();
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message || String(err) }));
  process.exit(1);
});
