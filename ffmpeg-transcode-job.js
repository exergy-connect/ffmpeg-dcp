async function main() {
  const compute = require('dcp/compute');
  const fs = require('fs').promises;

  const identity = require('dcp/identity');
  await identity.set('0x87ba424720c4a221f0f9c541928f366b2d1b6c78bff4107288c1e9985dd88a91');

  const wallet = require('dcp/wallet');
  const pay = await wallet.get('live demo');
  await wallet.add(pay);

  /* Read + base64-encode the test input locally, once, at deploy time -
   * the sandbox has no filesystem, so this can't happen inside the work
   * function. Swap this for a real uploaded video's bytes for an actual
   * demo; this is a synthetic 10-frame clip used to prove the wiring. */
  const inputBuffer = await fs.readFile(__dirname + '/test/test-input.mp4');
  const inputBase64 = inputBuffer.toString('base64');

  /* INPUT SET - each slice is one rung of the ABR ladder. inputBase64 is
   * embedded in every slice's own datum rather than passed as a bound
   * compute.for() argument - combining a bound argument with
   * job.requires() on the same job makes the bound value arrive as
   * `null` inside the sandbox (see the how-to doc). Costs a small amount
   * of duplication (4x ~9.6KB base64 here), negligible at this size. */
  const renditions = [
    { label: '360p',  width: 640, height: 360, bitrateKbps: 800, inputBase64 },
    { label: '240p',  width: 426, height: 240, bitrateKbps: 400, inputBase64 },
    { label: '160p',  width: 284, height: 160, bitrateKbps: 200, inputBase64 },
    { label: 'source-quality', width: 0, height: 0, bitrateKbps: 0, inputBase64 },
  ];

  /* WORK FUNCTION - decode this slice's own input, transcode to this
   * slice's rendition, report sizes back (not the full output bytes,
   * to keep console output readable - a real job would return outBytes
   * itself as the slice result). */
  async function workFunction(rendition) {
    const { transcodeSlice } = require('./ffmpeg-wasm/ffmpeg-wrapper');
    progress();

    const inputBytes = Uint8Array.from(atob(rendition.inputBase64), (c) => c.charCodeAt(0));
    const outBytes = await transcodeSlice(inputBytes, {
      width: rendition.width,
      height: rendition.height,
      bitrateKbps: rendition.bitrateKbps,
    });
    progress();

    return {
      label: rendition.label,
      inputSize: inputBytes.length,
      outputSize: outBytes.length,
    };
  }

  /* COMPUTE FOR */
  const job = compute.for(renditions, workFunction);

  /* COMPUTE GROUPS */
  job.computeGroups = [
    { joinKey: 'bell', joinSecret: '18be80' }
  ];

  /* MODULES - only the wrapper is declared; dcp-transcode-glue.js and
   * wasm-bytes.js (6.5MB of base64 - the largest payload shipped this
   * way in this doc set) are transitive dependencies and ship without
   * being listed */
  job.requires(['./ffmpeg-wasm/ffmpeg-wrapper']);

  /* PUBLIC INFO */
  job.public = {
    name: 'Bell FFmpeg+OpenH264 ABR ladder demo',
    description: 'Real ffmpeg+openh264 compiled to wasm, transcoding one input into a multi-rendition ABR ladder across a DCP worker fleet',
    link: 'https://bell.ca',
  };

  /* EVENTS */
  job.on('readystatechange', (ev) => console.log(`Ready state: ${ev}`));
  job.on('accepted', () =>
    console.log(`  Job id: ${job.id}\n  Awaiting results...`),
  );
  job.on('result', (ev) => console.log(ev));
  job.on('error', (error) => console.error('  Job error:', error));
  job.on('nofunds', (ev) => console.log(ev));
  job.on('console', (con) => console.dir(con, { depth: Infinity }));

  /* EXECUTION */
  let results = await job.exec();
  console.log(Array.from(results));
}
require('dcp-client').init('https://scheduler.distributed.computer').then(main);
