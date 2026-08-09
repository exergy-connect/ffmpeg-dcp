'use strict';
// Full pipeline dry run, entirely local (no DCP dispatch) - validates
// slice -> per-chunk-per-rendition transcode -> HLS assembly end to end
// before spending a real deploy on it. The real job (hls-transcode-job.js)
// does the same assembly logic against results that came back from the
// actual DCP fleet instead of a local loop.
const fs = require('fs').promises;
const { sliceVideo, transcodeSegment, generateTestClip } = require('../ffmpeg-wasm/ffmpeg-wrapper');

const RENDITIONS = [
  { label: '240p', width: 320, height: 240, bitrateKbps: 500 },
  { label: '160p', width: 240, height: 160, bitrateKbps: 300 },
  { label: '120p', width: 160, height: 120, bitrateKbps: 150 },
];

async function main() {
  const sourceClip = await generateTestClip(150, 20); // 15s @ 10fps, 2s GOPs
  const { chunks, durations, fps } = await sliceVideo(sourceClip, 30); // ~3-4s chunks
  console.log(`sliced into ${chunks.length} chunks, fps=${fps.toFixed(3)}, durations=[${durations.map((d) => d.toFixed(2)).join(', ')}]`);

  const totalDuration = durations.reduce((a, b) => a + b, 0);
  console.log(`total duration = ${totalDuration.toFixed(2)}s (source was 15.00s)`);

  const outDir = __dirname + '/hls-output';
  await fs.mkdir(outDir, { recursive: true });

  const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  for (const rendition of RENDITIONS) {
    const renditionDir = `${outDir}/${rendition.label}`;
    await fs.mkdir(renditionDir, { recursive: true });

    const mediaLines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ];
    let totalBytes = 0;

    for (let i = 0; i < chunks.length; i++) {
      const segBytes = await transcodeSegment(chunks[i], rendition);
      totalBytes += segBytes.length;
      const segName = `seg-${String(i).padStart(3, '0')}.ts`;
      await fs.writeFile(`${renditionDir}/${segName}`, Buffer.from(segBytes));
      mediaLines.push(`#EXTINF:${durations[i].toFixed(3)},`, segName);
      console.log(`  ${rendition.label} chunk ${i}: ${segBytes.length} bytes`);
    }
    mediaLines.push('#EXT-X-ENDLIST');
    await fs.writeFile(`${renditionDir}/playlist.m3u8`, mediaLines.join('\n') + '\n');

    const bandwidth = Math.round((totalBytes * 8) / totalDuration);
    masterLines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${rendition.width}x${rendition.height}`,
      `${rendition.label}/playlist.m3u8`,
    );
  }

  await fs.writeFile(`${outDir}/master.m3u8`, masterLines.join('\n') + '\n');
  console.log(`\nWrote HLS output to ${outDir}`);
  console.log('OK');
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
