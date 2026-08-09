'use strict';
const { transcodeSlice } = require('../ffmpeg-wasm/ffmpeg-wrapper');
const fs = require('fs');

(async () => {
  const inputBytes = fs.readFileSync(__dirname + '/test-input.mp4');
  console.log('input size =', inputBytes.length);

  const out1 = await transcodeSlice(inputBytes, { width: 80, height: 60, bitrateKbps: 200 });
  console.log('rung1 (80x60, 200kbps) output size =', out1.length);

  const out2 = await transcodeSlice(inputBytes, {});
  console.log('rung2 (default) output size =', out2.length);

  console.log('OK');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
