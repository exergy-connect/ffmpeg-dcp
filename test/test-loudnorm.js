'use strict';
// Verifies EBU R128 loudness normalization runs a real decode -> avfilter
// graph (abuffer -> loudnorm -> abuffersink) -> re-encode pipeline
// end to end without erroring, and that the resulting audio still
// decodes cleanly (real frames, not zero) - the same "actually decode
// it" verification bar every other audio feature in this project uses.
//
// What this does NOT verify: the actual resulting LUFS value. That
// needs ffmpeg's own ebur128 analysis filter (not enabled in this
// build - out of scope for this pass) or an external tool; this test
// confirms the real filter graph runs and produces valid, decodable
// output, not that the loudness target was hit precisely.
const { generateTestClip, transcodeSlice, probeStreams } = require('../ffmpeg-wasm/ffmpeg-wrapper');

async function main() {
  const clip = await generateTestClip(100, 20); // 10s @ 10fps
  console.log(`Generated clip: ${clip.length} bytes`);

  console.log('Transcoding WITHOUT loudness normalization (stream-copy audio, baseline)...');
  const plain = await transcodeSlice(clip, { width: 320, height: 240, bitrateKbps: 500 });
  const plainProbe = await probeStreams(plain);
  console.log(`  ${plain.length} bytes, audioTracks=${plainProbe.audioTracks} minDecodedAudioFrames=${plainProbe.minDecodedAudioFrames}`);
  if (!plainProbe.hasAudio || plainProbe.minDecodedAudioFrames < 1) {
    throw new Error('baseline (non-normalized) transcode lost its audio track');
  }

  console.log('Transcoding WITH loudness normalization (real decode -> loudnorm filter -> re-encode)...');
  const normalized = await transcodeSlice(clip, { width: 320, height: 240, bitrateKbps: 500, normalizeLoudness: true });
  const normalizedProbe = await probeStreams(normalized);
  console.log(`  ${normalized.length} bytes, audioTracks=${normalizedProbe.audioTracks} minDecodedAudioFrames=${normalizedProbe.minDecodedAudioFrames}`);
  if (!normalizedProbe.hasAudio || normalizedProbe.minDecodedAudioFrames < 1) {
    throw new Error('loudness-normalized transcode lost its audio track - the filter graph broke something, not just changed volume');
  }

  console.log('\nOK - loudness-normalized audio survives as real, independently decodable audio (LUFS value itself not verified - see header comment).');
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
