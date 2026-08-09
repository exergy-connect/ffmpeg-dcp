'use strict';
// Runs ONE escalation size in its own fresh process (invoked by
// stress-test.js via child_process.spawnSync, not required directly) so
// that wasm's ALLOW_MEMORY_GROWTH heap - which only grows, never shrinks
// within a process - doesn't carry over between sizes and produce a
// falsely-early failure reading for a later, larger size.
//
// generate_test_input() hardcodes 320x240/10fps (see dcp-transcode.c) -
// not parameterized - so frame count (duration) is the only axis this
// can escalate without a full wasm rebuild. That's also the axis that
// actually matters for "what if someone uploads a very long video":
// resolution affects per-frame cost, but chunk/unit count (and total
// MEMFS-resident bytes) scales with duration.
const { transcodeSegment, sliceVideo, generateTestClip } = require('../ffmpeg-wasm/ffmpeg-wrapper');

async function main() {
  const numFrames = Number(process.argv[2]);
  const gopSize = Number(process.argv[3]) || 300;
  const targetChunkFrames = Number(process.argv[4]) || 90;

  const result = { numFrames, durationSec: numFrames / 10 };

  let t0 = Date.now();
  const clip = await generateTestClip(numFrames, gopSize);
  result.generateMs = Date.now() - t0;
  result.clipBytes = clip.length;

  t0 = Date.now();
  const { chunks, durations } = await sliceVideo(clip, targetChunkFrames);
  result.sliceMs = Date.now() - t0;
  result.chunkCount = chunks.length;
  result.totalChunkBytes = chunks.reduce((a, c) => a + c.length, 0);

  // Transcode just the first and last chunk, not all of them - this is
  // checking whether the pipeline survives holding a long video's worth
  // of sliced chunks in MEMFS at once, not re-measuring per-chunk encode
  // throughput (already covered by the existing codec bake-off test).
  t0 = Date.now();
  await transcodeSegment(chunks[0], { width: 320, height: 240, bitrateKbps: 500 });
  if (chunks.length > 1) {
    await transcodeSegment(chunks[chunks.length - 1], { width: 320, height: 240, bitrateKbps: 500 });
  }
  result.sampleTranscodeMs = Date.now() - t0;

  result.memoryUsage = process.memoryUsage();
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message || String(err) }));
  process.exit(1);
});
