'use strict';
// Verifies multi-audio-track passthrough (Fr/En-style dual-track) end to
// end: generates a synthetic clip with a second 880Hz audio track
// alongside the default 440Hz one, runs it through both slice() (chunk
// splitting) and transcode() (whole-file), then asserts BOTH tracks
// survive with real decoded audio (probeStreams' minDecodedAudioFrames,
// not just audioTracks - a track that exists in the container but never
// actually decodes anything would still pass an audioTracks-only check).
const { generateTestClip, sliceVideo, transcodeSlice, probeStreams } = require('../ffmpeg-wasm/ffmpeg-wrapper');

function assertDualTrack(label, probe) {
  console.log(`  ${label}: audioTracks=${probe.audioTracks} minDecodedAudioFrames=${probe.minDecodedAudioFrames}`);
  if (probe.audioTracks !== 2) {
    throw new Error(`${label}: expected 2 audio tracks, got ${probe.audioTracks}`);
  }
  if (probe.minDecodedAudioFrames < 1) {
    throw new Error(`${label}: at least one track decoded 0 frames - a track surviving in name only, not really`);
  }
}

async function main() {
  const clip = await generateTestClip(100, 20, 0, 0, /* extraAudioTrack */ 1);
  console.log(`Generated dual-track clip: ${clip.length} bytes`);
  assertDualTrack('source', await probeStreams(clip));

  const transcoded = await transcodeSlice(clip, { width: 320, height: 240, bitrateKbps: 500 });
  console.log(`Transcoded: ${transcoded.length} bytes`);
  assertDualTrack('whole-file transcode', await probeStreams(transcoded));

  const { chunks } = await sliceVideo(clip, 30);
  console.log(`Sliced into ${chunks.length} chunk(s)`);
  for (let i = 0; i < chunks.length; i++) {
    assertDualTrack(`chunk ${i}`, await probeStreams(chunks[i]));
  }

  console.log('\nOK - both audio tracks survived source, whole-file transcode, and every sliced chunk.');
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
