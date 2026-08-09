async function main() {
  const compute = require('dcp/compute');
  const fs = require('fs').promises;
  const { sliceVideo, generateTestClip } = require('./ffmpeg-wasm/ffmpeg-wrapper');

  const identity = require('dcp/identity');
  await identity.set('0x87ba424720c4a221f0f9c541928f366b2d1b6c78bff4107288c1e9985dd88a91');

  const wallet = require('dcp/wallet');
  const pay = await wallet.get('live demo');
  await wallet.add(pay);

  /* Slicing happens locally, once, at deploy time - the sandbox has no
   * filesystem and slicing needs to run before dispatch anyway (each
   * chunk becomes its own work unit). Swap generateTestClip for a real
   * uploaded video's bytes for an actual demo. */
  const sourceClip = await generateTestClip(150, 20); // 15s @ 10fps, 2s GOPs
  const { chunks, durations } = await sliceVideo(sourceClip, 30); // ~3-4s chunks

  const RENDITIONS = [
    { label: '240p', width: 320, height: 240, bitrateKbps: 500 },
    { label: '160p', width: 240, height: 160, bitrateKbps: 300 },
    { label: '120p', width: 160, height: 120, bitrateKbps: 150 },
  ];

  /* INPUT SET - one unit per (chunk, rendition). Each chunk's bytes are
   * embedded in its own unit's datum, not a bound compute.for() argument
   * - see the how-to doc on why bound arguments break when combined with
   * job.requires() on the same job. */
  const units = [];
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunkBase64 = Buffer.from(chunks[chunkIndex]).toString('base64');
    for (const rendition of RENDITIONS) {
      units.push({ chunkIndex, ...rendition, chunkBase64 });
    }
  }

  async function workFunction(unit) {
    const { transcodeSegment } = require('./ffmpeg-wasm/ffmpeg-wrapper');
    progress();

    const chunkBytes = Uint8Array.from(atob(unit.chunkBase64), (c) => c.charCodeAt(0));
    const segBytes = await transcodeSegment(chunkBytes, {
      width: unit.width,
      height: unit.height,
      bitrateKbps: unit.bitrateKbps,
    });
    progress();

    // No Buffer in the sandbox - btoa in chunks avoids blowing the call
    // stack on String.fromCharCode.apply for a large single array.
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < segBytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, segBytes.subarray(i, i + chunkSize));
    }

    return {
      chunkIndex: unit.chunkIndex,
      label: unit.label,
      segmentBase64: btoa(binary),
    };
  }

  /* COMPUTE FOR */
  const job = compute.for(units, workFunction);

  /* COMPUTE GROUPS */
  job.computeGroups = [
    { joinKey: 'bell', joinSecret: '18be80' }
  ];

  /* MODULES */
  job.requires(['./ffmpeg-wasm/ffmpeg-wrapper']);

  /* PUBLIC INFO */
  job.public = {
    name: 'Bell FFmpeg+OpenH264 HLS chunking demo',
    description: 'Real ffmpeg+openh264 wasm, chunked ABR transcode assembled into a playable HLS ladder across a DCP worker fleet',
    link: 'https://bell.ca',
  };

  /* EVENTS */
  job.on('readystatechange', (ev) => console.log(`Ready state: ${ev}`));
  job.on('accepted', () =>
    console.log(`  Job id: ${job.id}\n  Awaiting results... (${units.length} units)`),
  );
  job.on('result', (ev) => console.log(`  slice ${ev.sliceNumber}: chunk ${ev.result.chunkIndex} @ ${ev.result.label}`));
  job.on('error', (error) => console.error('  Job error:', error));
  job.on('nofunds', (ev) => console.log(ev));
  job.on('console', (con) => console.dir(con, { depth: Infinity }));

  /* EXECUTION */
  const results = await job.exec();

  /* ASSEMBLY - group by rendition, order by chunkIndex, write segments +
   * HLS playlists to local disk (this is "the drop page"'s job in the
   * eventual browser frontend; for now it's this deploy script). */
  const byRendition = {};
  for (const r of results) {
    if (!byRendition[r.label]) byRendition[r.label] = [];
    byRendition[r.label][r.chunkIndex] = r.segmentBase64;
  }

  const outDir = __dirname + '/hls-output';
  await fs.mkdir(outDir, { recursive: true });
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  for (const rendition of RENDITIONS) {
    const renditionDir = `${outDir}/${rendition.label}`;
    await fs.mkdir(renditionDir, { recursive: true });
    const segs = byRendition[rendition.label];

    const mediaLines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ];
    let totalBytes = 0;

    for (let i = 0; i < segs.length; i++) {
      const segBytes = Buffer.from(segs[i], 'base64');
      totalBytes += segBytes.length;
      const segName = `seg-${String(i).padStart(3, '0')}.ts`;
      await fs.writeFile(`${renditionDir}/${segName}`, segBytes);
      mediaLines.push(`#EXTINF:${durations[i].toFixed(3)},`, segName);
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
}
require('dcp-client').init('https://scheduler.distributed.computer').then(main);
