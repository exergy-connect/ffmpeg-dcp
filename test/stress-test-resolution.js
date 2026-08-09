'use strict';
// Escalating-resolution stress test - complements stress-test.js
// (duration axis) with the other axis that matters for "what if someone
// uploads a bigger video": resolution. Each size runs in its own fresh
// `node stress-test-resolution-worker.js <width> <height>` process (see
// that file's header for why).
//
// Real-world tiers, not arbitrary numbers: SD/HD/FHD/4K/8K are the
// resolutions an actual production pipeline would see (see the how-to
// doc's discussion of typical mezzanine/delivery sizes).
const { spawnSync } = require('child_process');
const path = require('path');

const WORKER = path.join(__dirname, 'stress-test-resolution-worker.js');
const PER_ATTEMPT_TIMEOUT_MS = 3 * 60 * 1000;

const SIZES = [
  { label: 'SD', width: 640, height: 480 },
  { label: 'HD', width: 1280, height: 720 },
  { label: 'FHD', width: 1920, height: 1080 },
  { label: '4K UHD', width: 3840, height: 2160 },
  { label: '8K UHD', width: 7680, height: 4320 },
];

function fmtBytes(n) {
  if (n == null) return 'n/a';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${mb.toFixed(1)}MB`;
}

async function main() {
  console.log(`Stress-testing ${WORKER} across ${SIZES.length} resolutions, one fresh process each...\n`);
  const results = [];

  for (const size of SIZES) {
    process.stdout.write(`[${size.label} / ${size.width}x${size.height}] running... `);

    const t0 = Date.now();
    const proc = spawnSync(process.execPath, [WORKER, String(size.width), String(size.height)], {
      timeout: PER_ATTEMPT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    const wallMs = Date.now() - t0;

    if (proc.error && proc.error.code === 'ETIMEDOUT') {
      console.log(`TIMEOUT after ${(wallMs / 1000).toFixed(1)}s (budget ${PER_ATTEMPT_TIMEOUT_MS / 1000}s) - stopping here.`);
      results.push({ ...size, outcome: 'timeout', wallMs });
      break;
    }
    if (proc.status !== 0) {
      const stderr = (proc.stderr || '').trim();
      console.log(`FAILED after ${(wallMs / 1000).toFixed(1)}s: ${stderr || `exit code ${proc.status}`}`);
      results.push({ ...size, outcome: 'error', wallMs, error: stderr });
      break;
    }

    let parsed;
    try {
      parsed = JSON.parse(proc.stdout.trim().split('\n').pop());
    } catch (e) {
      console.log(`FAILED to parse worker output after ${(wallMs / 1000).toFixed(1)}s: ${e.message}\n  raw stdout: ${proc.stdout.slice(0, 500)}`);
      results.push({ ...size, outcome: 'parse-error', wallMs });
      break;
    }

    console.log(
      `ok in ${(wallMs / 1000).toFixed(1)}s - ${fmtBytes(parsed.clipBytes)} source, ` +
      `${fmtBytes(parsed.outputBytes)} downscaled output, wasm rss ${fmtBytes(parsed.memoryUsage && parsed.memoryUsage.rss)}`,
    );
    results.push({ ...size, outcome: 'ok', wallMs, ...parsed });
  }

  console.log('\n--- summary ---');
  const lastOk = [...results].reverse().find((r) => r.outcome === 'ok');
  const firstBad = results.find((r) => r.outcome !== 'ok');
  if (lastOk) {
    console.log(`Largest resolution that completed cleanly: ${lastOk.label} (${lastOk.width}x${lastOk.height}), ${fmtBytes(lastOk.clipBytes)} source, wasm rss ${fmtBytes(lastOk.memoryUsage && lastOk.memoryUsage.rss)}.`);
  } else {
    console.log('Even the smallest tested resolution did not complete cleanly.');
  }
  if (firstBad) {
    console.log(`First resolution that did not (${firstBad.outcome}): ${firstBad.label} (${firstBad.width}x${firstBad.height}).`);
  } else {
    console.log('All tested resolutions completed cleanly - raise SIZES to find the real ceiling.');
  }
}

main();
