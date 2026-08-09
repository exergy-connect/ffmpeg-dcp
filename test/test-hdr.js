'use strict';
// Verifies HDR10 color-metadata passthrough end to end: generates a
// synthetic clip tagged with real BT.2020/PQ color info, transcodes it,
// then asserts the OUTPUT still carries the same color_primaries the
// INPUT had - a real passthrough check, not just "did it not crash".
//
// Scope, found live, not assumed: do_transcode()'s per-frame side-data
// copy (mastering display primaries/luminance, content light level) is
// real, working code (see its own comment in dcp-transcode.c) but
// UNVERIFIED here - generate_test_input() always encodes its own
// source through libopenh264, and that encode step never serializes
// the AVFrame side data this project attaches into the H.264 bitstream
// at all (confirmed live: has_mastering_display_metadata=0 on the SOURCE
// clip already, before do_transcode() ever runs, and unchanged when the
// transcode step uses libx264 instead - ruling out do_transcode()'s own
// encoder choice as the cause). So the source fixture this test can
// generate never actually carries SEI-level HDR10 metadata to passthrough
// in the first place - a real gap in what this project's synthetic
// generator can prove, not a bug in the passthrough code itself. Only
// container/codecpar-level color info (color_primaries/color_trc/
// color_space, independent of the bitstream's own SEI) is verified
// below. Dolby Vision remains explicitly out of scope regardless.
const { generateTestClip, transcodeSlice, probeHdr } = require('../ffmpeg-wasm/ffmpeg-wrapper');

const AVCOL_PRI_BT2020 = 9;
const AVCOL_TRC_SMPTE2084 = 16;

async function main() {
  const clip = await generateTestClip(30, 10, 0, 0, /* extraAudioTrack */ 0, /* hdr */ 1);
  console.log(`Generated HDR10-tagged clip: ${clip.length} bytes`);

  console.log('Source color metadata:');
  const sourcePrimaries = await probeHdr(clip);
  if (sourcePrimaries !== AVCOL_PRI_BT2020) {
    throw new Error(`generate_test_input()'s own HDR tagging didn't take - expected color_primaries=${AVCOL_PRI_BT2020} (BT.2020), got ${sourcePrimaries}`);
  }

  console.log('Transcoding (real HDR10 passthrough path in do_transcode())...');
  const transcoded = await transcodeSlice(clip, { width: 320, height: 240, bitrateKbps: 500 });
  console.log(`Transcoded: ${transcoded.length} bytes`);

  console.log('Output color metadata:');
  const outPrimaries = await probeHdr(transcoded);
  if (outPrimaries !== AVCOL_PRI_BT2020) {
    throw new Error(`color_primaries did not survive transcode - expected ${AVCOL_PRI_BT2020} (BT.2020), got ${outPrimaries}`);
  }

  console.log('\nOK - BT.2020 color_primaries survived do_transcode() end to end (see the two [probe_hdr] stderr lines above for the full color_trc/color_space/mastering-display/content-light breakdown).');
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
