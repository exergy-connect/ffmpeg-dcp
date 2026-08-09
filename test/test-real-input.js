'use strict';
// Full pipeline dry run against a real downloaded video, not a synthetic
// clip - entirely local (no DCP dispatch), same shape as
// test-hls-pipeline-local.js. Real footage has caught bugs this
// project's synthetic test clips never did (see the how-to doc's
// "A real-world-input bug" section) - videoplayback.mp4 is the larger,
// more representative fixture for that going forward.
const fs = require('fs').promises;
const { sliceVideo, transcodeSegment } = require('../ffmpeg-wasm/ffmpeg-wrapper');

const INPUT_PATH = __dirname + '/videoplayback.mp4';
const TARGET_CHUNK_FRAMES = 90; // matches app.js's TARGET_CHUNK_FRAMES

const RENDITIONS = [
  { label: '240p', width: 320, height: 240, bitrateKbps: 500, encoder: 'libopenh264' },
  { label: '160p', width: 240, height: 160, bitrateKbps: 300, encoder: 'libopenh264' },
  { label: '120p', width: 160, height: 120, bitrateKbps: 150, encoder: 'libopenh264' },
];

async function main() {
  const inputBytes = await fs.readFile(INPUT_PATH);
  console.log(`Input: ${INPUT_PATH} (${(inputBytes.length / (1024 * 1024)).toFixed(1)}MB)`);

  let t0 = Date.now();
  const { chunks, durations, fps } = await sliceVideo(inputBytes, TARGET_CHUNK_FRAMES);
  console.log(
    `Sliced into ${chunks.length} chunk(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
    `fps=${fps.toFixed(2)}, total duration=${durations.reduce((a, b) => a + b, 0).toFixed(1)}s, ` +
    `chunk durations=[${durations.map((d) => d.toFixed(1)).join(', ')}]`,
  );

  const outDir = __dirname + '/hls-output';
  await fs.mkdir(outDir, { recursive: true });
  const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  for (const rendition of RENDITIONS) {
    const renditionDir = `${outDir}/${rendition.label}`;
    await fs.mkdir(renditionDir, { recursive: true });
    const mediaLines = [
      '#EXTM3U', '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ];

    t0 = Date.now();
    let totalBytes = 0;
    for (let i = 0; i < chunks.length; i++) {
      const segBytes = await transcodeSegment(chunks[i], rendition);
      totalBytes += segBytes.length;
      const segName = `seg-${String(i).padStart(3, '0')}.ts`;
      await fs.writeFile(`${renditionDir}/${segName}`, segBytes);
      mediaLines.push(`#EXTINF:${durations[i].toFixed(3)},`, segName);
    }
    mediaLines.push('#EXT-X-ENDLIST');
    await fs.writeFile(`${renditionDir}/playlist.m3u8`, mediaLines.join('\n') + '\n');

    const elapsedSec = (Date.now() - t0) / 1000;
    console.log(`  ${rendition.label}: ${chunks.length} segments, ${(totalBytes / 1024).toFixed(0)}KB total, ${elapsedSec.toFixed(1)}s`);

    const totalDuration = durations.reduce((a, b) => a + b, 0);
    const bandwidth = Math.round((totalBytes * 8) / totalDuration);
    masterLines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${rendition.width}x${rendition.height}`,
      `${rendition.label}/playlist.m3u8`,
    );
  }
  await fs.writeFile(`${outDir}/master.m3u8`, masterLines.join('\n') + '\n');

  // One AV1 sample on the first chunk only, in quality mode - checking
  // that AV1 survives real (non-synthetic) footage, not re-running the
  // full codec bake-off (test-codec-bakeoff.js already owns that).
  t0 = Date.now();
  const av1Sample = await transcodeSegment(chunks[0], { width: 320, height: 240, bitrateKbps: 0, encoder: 'libsvtav1' });
  console.log(`  av1-240p sample (chunk 0, quality mode): ${av1Sample.length} bytes, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log(`\nOK - wrote HLS output to ${outDir}`);
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
