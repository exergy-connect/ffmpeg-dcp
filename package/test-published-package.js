/**
 * @file        test-published-package.js
 * @description Run this AFTER publishing package.dcp, to confirm
 *              ffmpeg-wasm-test/ffmpeg-wasm.js works as an actual published
 *              package -- job.requires(['ffmpeg-wasm-test/ffmpeg-wasm.js']) +
 *              require('ffmpeg-wasm.js') (bare filename, no path), per the
 *              package manager's usage convention (see
 *              docs/patching-wasm-libraries-for-dcp.html in the Edequity
 *              repo, and this repo's own inline job.requires-free approach
 *              in ../app.js's runFleetRace()).
 *
 *              Deliberately a small, cheap slice: generate a short synthetic
 *              clip and slice it, on a real DCP worker, entirely through
 *              the published bundle -- no separate wasm/glue job argument
 *              involved. If this passes, the bravojs wrap + embedded wasm
 *              base64 (build-bravojs-bundle.js) actually resolves and runs
 *              on a real sandbox, not just under local `node`.
 *
 * @usage       node test-published-package.js --apiKey=0x<identity> [--computeGroup=key,secret]
 */
'use strict';

async function testFfmpegWasm(unit) {
  const setProgress = (p) => { if (typeof progress === 'function') progress(p); };
  setProgress(0.0);

  const report = {};
  const t0 = Date.now();

  try {
    // The whole point of publishing: this is ALL a consumer needs to write.
    // No ffmpeg-wasm/, no Emscripten awareness, no instantiateWasm plumbing.
    const { createFfmpegModule } = require('ffmpeg-wasm.js');
    setProgress(0.1);

    const Module = await createFfmpegModule();
    setProgress(0.3);

    const genRet = Module.ccall(
      'generate_test_input', 'number',
      ['string', 'number', 'number', 'number', 'number', 'number', 'number'],
      ['/test.mp4', unit.numFrames, unit.gopSize, 0, 0, 0, 0],
    );
    if (genRet !== 0) throw new Error(`generate_test_input() failed with code ${genRet}`);
    const genBytes = Module.FS.readFile('/test.mp4');
    setProgress(0.6);

    const chunkCount = Module.ccall(
      'slice', 'number',
      ['string', 'string', 'number'],
      ['/test.mp4', '/chunk-', unit.numFrames],
    );
    const fps = Module.ccall('get_source_fps', 'number', [], []);
    setProgress(0.9);

    report.generatedBytes = genBytes.length;
    report.chunkCount = chunkCount;
    report.fps = fps;
    report.pass = genRet === 0 && genBytes.length > 0 && chunkCount > 0;
    report.totalMs = Date.now() - t0;
  } catch (e) {
    report.error = (e && e.message) || String(e);
    report.totalMs = Date.now() - t0;
  }

  setProgress(1.0);
  return report;
}

async function main() {
  const identity = require('dcp/identity');
  const compute = require('dcp/compute');

  function getFlag(name) {
    const pfx = `--${name}=`;
    const hit = process.argv.find((a) => a.startsWith(pfx));
    return hit ? hit.slice(pfx.length) : undefined;
  }

  const apiKey = getFlag('apiKey');
  const cg = getFlag('computeGroup');
  if (!apiKey) {
    console.error('ERROR: --apiKey=0x... is required');
    process.exit(1);
  }
  let computeGroup;
  if (cg) {
    const [joinKey, joinSecret] = cg.split(',');
    computeGroup = joinSecret ? { joinKey, joinSecret } : { joinKey };
  }

  await identity.set(apiKey);

  const job = compute.for([{ numFrames: 10, gopSize: 2 }], testFfmpegWasm, []);
  job.requires(['ffmpeg-wasm-test/ffmpeg-wasm.js']);
  job.computeGroups = computeGroup ? [computeGroup] : [{ joinKey: 'public' }];
  job.public = {
    name: 'ffmpeg-wasm-test published-package test',
    description: 'Confirms the published ffmpeg-wasm-test package works via job.requires()',
  };

  job.on('readystatechange', (ev) => console.log(`Ready state: ${ev}`));
  job.on('accepted', () => console.log(`  Job id: ${job.id}\n  Awaiting result...`));
  job.on('error', (error) => console.error('  Job error:', error));
  job.on('nofunds', (ev) => console.log(ev));
  job.on('result', (ev) => {
    console.log('\n=== RESULT ===\n');
    console.log(JSON.stringify(ev.result, null, 2));
  });

  const [result] = await job.exec();
  const ok = !result.error && result.pass;
  console.log(ok ? '\nPASS: published ffmpeg-wasm-test package runs correctly.' : '\nFAIL: see result above.');
  if (!ok) process.exitCode = 1;
}

require('dcp-client').init().then(main).catch((e) => { console.error(e); process.exit(1); });
