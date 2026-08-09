'use strict';
// Escalating-duration stress test: finds the practical size ceiling for
// this project's wasm pipeline empirically instead of guessing at one.
// Each size runs in its own `node stress-test-worker.js <numFrames>`
// child process (see that file's header for why: wasm's
// ALLOW_MEMORY_GROWTH heap never shrinks within a process, so testing
// multiple sizes in one long-lived process would make later sizes fail
// earlier than they really would on their own).
//
// Real production input is generally a lot bigger than this project's
// existing test fixtures (see ffmpeg-openh264-wasm-dcp.md) - this is
// what actually motivated the liveness grid's area-locked tiling fix,
// since a long video means a lot of chunk x rendition units, not just a
// long transcode.
const { spawnSync } = require('child_process');
const path = require('path');

const WORKER = path.join(__dirname, 'stress-test-worker.js');
const PER_ATTEMPT_TIMEOUT_MS = 3 * 60 * 1000; // a step that doesn't finish in 3min counts as "chokes here" too, not just a crash

// Frames at the synthetic clip's fixed 10fps (see dcp-transcode.c's
// generate_test_input): 5min, 30min, 90min, 3hr, 6hr.
const SIZES_FRAMES = [3000, 18000, 54000, 108000, 216000];

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}m${Math.round(sec % 60)}s`;
}

function fmtBytes(n) {
  if (n == null) return 'n/a';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${mb.toFixed(1)}MB`;
}

async function main() {
  console.log(`Stress-testing ${WORKER} across ${SIZES_FRAMES.length} sizes, one fresh process each...\n`);
  const results = [];

  for (const numFrames of SIZES_FRAMES) {
    const durationSec = numFrames / 10;
    process.stdout.write(`[${fmtDuration(durationSec)} / ${numFrames} frames] running... `);

    const t0 = Date.now();
    const proc = spawnSync(process.execPath, [WORKER, String(numFrames)], {
      timeout: PER_ATTEMPT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    const wallMs = Date.now() - t0;

    if (proc.error && proc.error.code === 'ETIMEDOUT') {
      console.log(`TIMEOUT after ${(wallMs / 1000).toFixed(1)}s (budget ${PER_ATTEMPT_TIMEOUT_MS / 1000}s) - stopping here.`);
      results.push({ numFrames, durationSec, outcome: 'timeout', wallMs });
      break;
    }
    if (proc.status !== 0) {
      const stderr = (proc.stderr || '').trim();
      console.log(`FAILED after ${(wallMs / 1000).toFixed(1)}s: ${stderr || `exit code ${proc.status}`}`);
      results.push({ numFrames, durationSec, outcome: 'error', wallMs, error: stderr });
      break;
    }

    let parsed;
    try {
      parsed = JSON.parse(proc.stdout.trim().split('\n').pop());
    } catch (e) {
      console.log(`FAILED to parse worker output after ${(wallMs / 1000).toFixed(1)}s: ${e.message}\n  raw stdout: ${proc.stdout.slice(0, 500)}`);
      results.push({ numFrames, durationSec, outcome: 'parse-error', wallMs });
      break;
    }

    console.log(
      `ok in ${(wallMs / 1000).toFixed(1)}s - ${parsed.chunkCount} chunks, ` +
      `${fmtBytes(parsed.clipBytes)} source, ${fmtBytes(parsed.totalChunkBytes)} sliced, ` +
      `wasm rss ${fmtBytes(parsed.memoryUsage && parsed.memoryUsage.rss)}`,
    );
    results.push({ numFrames, durationSec, outcome: 'ok', wallMs, ...parsed });
  }

  console.log('\n--- summary ---');
  const lastOk = [...results].reverse().find((r) => r.outcome === 'ok');
  const firstBad = results.find((r) => r.outcome !== 'ok');
  if (lastOk) {
    console.log(`Largest size that completed cleanly: ${fmtDuration(lastOk.durationSec)} (${lastOk.numFrames} frames), ${lastOk.chunkCount} chunks, ${fmtBytes(lastOk.clipBytes)} source.`);
  } else {
    console.log('Even the smallest tested size did not complete cleanly - lower SIZES_FRAMES to bracket the ceiling further down.');
  }
  if (firstBad) {
    console.log(`First size that did not (${firstBad.outcome}): ${fmtDuration(firstBad.durationSec)} (${firstBad.numFrames} frames).`);
  } else {
    console.log('All tested sizes completed cleanly - raise SIZES_FRAMES to find the real ceiling.');
  }
}

main();
