'use strict';

// Page controller for index.html. Mirrors hls-transcode-job.js's
// dispatch shape where it can (same units, same computeGroups, same HLS
// assembly logic - all proven correct there via real deployment); this
// file drives the same kind of DCP calls from a browser tab instead of
// Node, and adds a second "local" encode path (same wasm module, via
// ffmpeg-browser.js) purely for the race comparison.
//
// One thing does NOT carry over: job.requires(). Confirmed live that
// dcp-client's browser-side job.requires() only resolves published DCP
// packages by name, not arbitrary local files fetched from the page's
// own origin the way Node's filesystem-based bundler does - see
// runFleetRace()'s comment for how the fleet work function ships the
// wasm module instead (bound arguments, not job.requires()).
//
// Lives at the ffmpeg-dcp/ top level, alongside ffmpeg-wasm/ (not in its
// own demo/ subfolder) so ffmpeg-browser.js's fetch() calls stay simple
// same-directory paths.

const RENDITIONS = [
  { label: '240p', width: 320, height: 240, bitrateKbps: 500, encoder: 'libopenh264', playable: true },
  { label: '160p', width: 240, height: 160, bitrateKbps: 300, encoder: 'libopenh264', playable: true },
  { label: '120p', width: 160, height: 120, bitrateKbps: 150, encoder: 'libopenh264', playable: true },
  // Dedicated codec-comparison pair, NOT part of the ABR ladder above -
  // same resolution, both in each encoder's own *quality* mode (CRF,
  // bitrateKbps: 0) rather than a bitrate cap. This distinction is
  // load-bearing, confirmed live: at the SAME bitrate cap (500kbps,
  // matching the ABR '240p' rendition above), AV1 actually came out
  // *larger* than H.264 for one real test chunk (both encoders just
  // converge toward the target size regardless of underlying
  // efficiency) - the real ~50-60% size advantage this project's own
  // bake-off found (ffmpeg-openh264-wasm-dcp.md) only shows up when
  // comparing quality mode to quality mode, a true apples-to-apples
  // compression-efficiency comparison. `playable: false` on both: this
  // pair isn't part of the real ABR ladder, and separately, AV1-in-
  // MPEG-TS (this pipeline's segment container) isn't a combination
  // hls.js/browsers reliably support - confirmed live via a real ffmpeg
  // muxer warning ("Stream 0, codec av1, is muxed as a private data
  // stream and may not be recognized upon reading"), not just theorized.
  { label: 'h264-240p-quality', width: 320, height: 240, bitrateKbps: 0, encoder: 'libopenh264', playable: false },
  { label: 'av1-240p', width: 320, height: 240, bitrateKbps: 0, encoder: 'libsvtav1', playable: false },
];
// ~3s at a typical 30fps source - chosen to land near common real-world
// GOP sizes (2-10s is typical for web video) so sliceVideoAdaptive()'s
// cheap native slice() already satisfies most real chunks without
// needing to re-encode them (see that function in ffmpeg-worker.js).
// A much smaller target (15, tried first) sounded like it'd give finer
// fleet-dispatch granularity, but in practice meant nearly every real
// chunk exceeded 2x target and needed individual re-encoding anyway -
// confirmed live (4 of 5 chunks on one real test file) - so total
// processing time barely improved over re-encoding the whole video.
const TARGET_CHUNK_FRAMES = 90;

// Real AWS Elemental MediaConvert on-demand rates (aws.amazon.com/
// mediaconvert/pricing/, checked 2026-08-09), not a single flat
// illustrative figure. MediaConvert's actual model is `cost =
// normalized_minutes x tier_rate`, where normalized_minutes = real
// minutes x a resolution/codec/frame-rate multiplier table - simplified
// here to what applies to this demo's own renditions:
//   Basic tier (AVC/VP8/VP9 only - no AV1/HEVC support at all):
//     $0.0075/min at SD, single-pass, first pricing tier.
//   Professional tier (the only tier AV1 is available on):
//     $0.0120/min base at SD, first tier, x3.5 multiplier for AV1 at
//     SD/<=30fps -> $0.042/min effective.
// All this demo's renditions are "SD" in AWS's own bucketing (their
// SD/HD/4K/8K tiers start at SD for anything under 720p). Both rates
// are AWS's *first* pricing tier only (<=100k Basic / <=50k Professional
// normalized minutes/month before volume discounts kick in) - this demo
// will never process real AWS-scale volume, so the discounted brackets
// don't apply.
const AWS_BASIC_TIER_RATE_PER_MIN = 0.0075; // H.264/AVC, Basic tier, SD, 1x
const AWS_PROFESSIONAL_TIER_RATE_PER_MIN = 0.0120; // base rate, SD, before codec multiplier
const AWS_AV1_SD_SINGLEPASS_MULTIPLIER = 3.5; // Professional tier, AV1, SD, <=30fps
const AWS_AV1_RATE_PER_MIN = AWS_PROFESSIONAL_TIER_RATE_PER_MIN * AWS_AV1_SD_SINGLEPASS_MULTIPLIER; // $0.042/min

function awsRatePerMinute(rendition) {
  // AV1 costs more on real AWS pricing for two independent reasons, not
  // just the encode itself: it's Professional-tier-only (H.264 can use
  // the cheaper Basic tier) AND carries its own 3.5x+ multiplier on top
  // of that tier's already-higher base rate.
  return rendition.encoder === 'libsvtav1' ? AWS_AV1_RATE_PER_MIN : AWS_BASIC_TIER_RATE_PER_MIN;
}

// DCP's own market rate: 1.000 ⊇ per 100 vCPU-seconds = $0.0003171 USD
// (DCP credit -> USD conversion as given, not independently re-derived
// here). This is a RAW per-compute-second rate, unlike AWS's per-
// output-minute model above - priced directly from each fleet slice's
// own real measured compute time (see workFunction below), not an
// estimate, so it automatically reflects whatever hardware speed
// actually executed each slice - no separate normalization step needed.
const DCP_USD_PER_100_VCPU_SECONDS = 0.0003171;

// Reference-only context for the explanatory copy in index.html, not a
// multiplier applied anywhere here: Bell's own internal fleet hardware
// runs at roughly 38% the per-core speed of an AWS-class vCPU, so if the
// slices in a given run actually land on Bell's own fleet, the real
// measured compute times above (and therefore the real dollar cost)
// already come out proportionally higher than a same-hardware
// comparison against AWS's own rate would suggest - the real numbers
// demonstrate this effect on their own; this constant just documents
// the reference figure being described.
const BELL_CPU_EFFICIENCY = 0.38;

// Bell's own economics on top of the raw DCP rate, not just "DCP is
// cheap": if Bell dispatches its own transcode jobs to the DCP network,
// its own machines are among those eligible to pick up the work, and
// Bell earns back 80% of what it spends as compute credit - so Bell's
// own *net* cost for its own internal jobs is only 20% of the raw DCP
// rate (spend 1.0, earn back 0.8, net 0.2 - "1/5 of the DCP cost").
// Conversely, if Bell resells DCP-backed transcoding to an external
// customer paying the raw DCP rate, Bell keeps 80% of that as revenue
// and Distributive (the network operator) takes the remaining 20% -
// same 80/20 split, opposite direction (cost avoided vs. revenue kept).
const BELL_INTERNAL_NET_FACTOR = 0.20; // net cost to Bell for its own jobs
const BELL_EXTERNAL_REVENUE_SHARE = 0.80; // Bell's cut when reselling to a customer

function dcpRawCostForSeconds(vcpuSeconds) {
  return (vcpuSeconds / 100) * DCP_USD_PER_100_VCPU_SECONDS;
}

// Same demo identity/computeGroup used by every other job script in
// this project (see hls-transcode-job.js) - not a secret, already
// committed in this repo's other job drivers.
const DEMO_IDENTITY_KEY = '0x87ba424720c4a221f0f9c541928f366b2d1b6c78bff4107288c1e9985dd88a91';
const COMPUTE_GROUP = { joinKey: 'bell', joinSecret: '18be80' };

const el = (id) => document.getElementById(id);
const logEl = el('log');
function log(msg) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(msg);
}

// ---- QR code: dcp.live's own worker-join page, pre-filled with this
// job's compute group via query params, so a scanning device joins
// eligible for *this* job's slices specifically (not just the general
// scheduler pool) - the real mechanism, in place of this page's earlier
// best-effort join.html guess. ----
new QRCode(el('qrcode'), {
  text: `https://dcp.live/?computeGroups=${COMPUTE_GROUP.joinKey},${COMPUTE_GROUP.joinSecret}`,
  width: 128, height: 128,
});

// ---- Drop zone wiring ----
const dropzone = el('dropzone');
const fileInput = el('fileInput');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});
el('demoClipBtn').addEventListener('click', async () => {
  log('Generating a synthetic demo clip in-browser (150 frames, 15s @ 10fps)...');
  const bytes = await window.ffmpegBrowser.generateTestClip(150, 20);
  runWithBytes(bytes);
});

async function handleFile(file) {
  log(`Reading ${file.name} (${(file.size / 1024).toFixed(0)}KB)...`);
  const buf = new Uint8Array(await file.arrayBuffer());
  runWithBytes(buf);
}

// ---- Main orchestration ----
async function runWithBytes(inputBytes) {
  el('raceSection').classList.remove('hidden');
  el('liveSection').classList.remove('hidden');
  el('costSection').classList.remove('hidden');
  el('codecSection').classList.remove('hidden');
  resetUi();

  // sliceVideo() alone can only cut at keyframes the source already has,
  // so on real-world video (commonly a 2-6s+ native keyframe interval)
  // TARGET_CHUNK_FRAMES has no effect below that interval no matter how
  // low it's set - confirmed live, chunks stayed the exact same 3s
  // regardless of the target. But forcing a short GOP via a full-video
  // re-encode is serial, one-machine cost that scales with source
  // length and doesn't touch the fleet at all - a real problem for
  // "larger and larger videos", not just an upfront tax. sliceVideoAdaptive()
  // is the hybrid: slice cheaply first at the source's native keyframes,
  // then only re-encode individual chunks that come out genuinely
  // oversized (each pays for only its own size, not the whole video) -
  // see ffmpeg-worker.js for the actual logic. Capped at the largest
  // configured rendition when a chunk does need re-encoding - this
  // artifact gets re-encoded again per rendition anyway, so there's no
  // reason to pay full source-resolution encode time for it.
  // Kicked off in parallel with slicing below, not awaited yet - this is
  // independent work against the original upload (see
  // generateThumbnailSprite()'s own comment), so there's no reason to
  // make it part of the critical path before the race can start.
  const thumbPromise = generateThumbnailSprite(inputBytes).catch((err) => {
    log(`Scrubbing preview failed (non-fatal): ${err.message}`);
    return null;
  });

  const maxRenditionWidth = Math.max(...RENDITIONS.map((r) => r.width));
  const maxRenditionHeight = Math.max(...RENDITIONS.map((r) => r.height));
  log('Slicing (client-side, same wasm module used everywhere else in this project)...');
  const { chunks, durations, fps } = await window.ffmpegBrowser.sliceVideoAdaptive(
    inputBytes, TARGET_CHUNK_FRAMES, maxRenditionWidth, maxRenditionHeight,
    (info) => {
      if (info.phase === 'sliced') {
        log(`Native slice: ${info.nativeChunks} chunk(s), ${info.needsReencode} too big for target - re-encoding those individually...`);
      } else if (info.phase === 'reencoding') {
        log(`  re-encoding oversized chunk ${info.current}/${info.total}...`);
      }
    },
  );
  log(`Sliced into ${chunks.length} chunk(s), fps=${fps.toFixed(2)}, durations=[${durations.map((d) => d.toFixed(2)).join(', ')}]`);

  const totalDurationSec = durations.reduce((a, b) => a + b, 0);
  thumbPromise.then((thumbData) => {
    if (thumbData) finishScrubPreview(thumbData.sprite, thumbData.thumbCount, totalDurationSec);
  });

  const units = [];
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    for (const rendition of RENDITIONS) units.push({ chunkIndex, rendition });
  }
  setupGrid(chunks.length, RENDITIONS);

  // DCP identity/wallet setup happens once, up front, and is awaited
  // before either race starts - not part of either race's timed work,
  // and doing it before the CPU-heavy local race starts means its
  // network round-trips aren't competing for event-loop turns against
  // local's synchronous wasm bursts (confirmed live: without this,
  // wallet.get() didn't even resolve until the local race had already
  // finished, since a several-second synchronous ccall doesn't yield
  // for anything, including pending fetch callbacks, until it returns).
  const dcp = await setupDcp();

  const localPromise = runLocalRace(chunks, units);
  const fleetPromise = dcp ? runFleetRace(dcp, chunks, units, durations) : Promise.resolve(null);

  const [, fleetOutcome] = await Promise.all([localPromise, fleetPromise]);
  if (fleetOutcome) assembleAndPlay(fleetOutcome.byRendition, durations, RENDITIONS);
}

// This exact identity.set()/wallet.get(label)/wallet.add() shape is
// carried over from every Node job script in this project (proven there
// via real deployment) - dcp-client's official browser examples only
// demonstrate the no-argument wallet.get()/wallet.getId() forms (for a
// *worker's* own identity, a different call than what a job *deployer*
// needs), so this specific shape was unverified until tested live. It
// worked as-is.
async function setupDcp() {
  const { compute, identity, wallet } = window.dcp;
  if (!compute || !identity || !wallet) {
    log('window.dcp.compute/identity/wallet not found - dcp-client script may not have loaded. Fleet race skipped.');
    return null;
  }
  try {
    await identity.set(DEMO_IDENTITY_KEY);
    const pay = await wallet.get('live demo');
    await wallet.add(pay);
    return { compute };
  } catch (err) {
    log(`Identity/wallet setup failed: ${err.message} - fleet race skipped.`);
    return null;
  }
}

function resetUi() {
  el('localBar').style.width = '0%';
  el('fleetBar').style.width = '0%';
  el('localTime').textContent = '0.0s';
  el('fleetTime').textContent = '0.0s';
  el('speedup').textContent = '';
  el('costCounter').textContent = '$0.0000';
  el('statDcpRaw').textContent = '$0.0000';
  el('statDcpInternal').textContent = '$0.0000';
  el('statDcpExternal').textContent = '$0.0000';
  el('dcpDetail').textContent = '0/0 fleet slices: priced from each slice\'s own real compute time';
  el('statH264Bytes').textContent = '0 MB';
  el('statAv1Bytes').textContent = '0 MB';
  el('statAv1Savings').textContent = '—';
  el('playerSection').classList.add('hidden');
  el('thumbSection').classList.add('hidden');
  el('thumbDetail').textContent = '';
  el('scrubPreview').style.display = 'none';
}

// ---- Local race: same wasm module, sequential, in-page ----
async function runLocalRace(chunks, units) {
  const t0 = performance.now();
  const timer = setInterval(() => {
    el('localTime').textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);

  let completed = 0;
  for (const unit of units) {
    const chunkBytes = chunks[unit.chunkIndex];
    try {
      await window.ffmpegBrowser.transcodeSegment(chunkBytes, {
        width: unit.rendition.width,
        height: unit.rendition.height,
        bitrateKbps: unit.rendition.bitrateKbps,
        encoder: unit.rendition.encoder,
      });
    } catch (err) {
      log(`Local encode failed for chunk ${unit.chunkIndex} @ ${unit.rendition.label}: ${err.message}`);
    }
    completed += 1;
    el('localBar').style.width = `${(completed / units.length) * 100}%`;
    // Yield to the event loop between units so the progress bar / timer
    // actually repaint - each transcodeSegment call itself is still one
    // blocking synchronous burst of wasm work.
    await new Promise((r) => setTimeout(r, 0));
  }

  clearInterval(timer);
  const elapsedSec = (performance.now() - t0) / 1000;
  el('localTime').textContent = `${elapsedSec.toFixed(1)}s`;
  log(`Local race done in ${elapsedSec.toFixed(1)}s`);
  maybeShowSpeedup(elapsedSec, 'local');
  return { elapsedSec };
}

// ---- Fleet race: real DCP dispatch ----
let fleetElapsedSec = null;
let localElapsedSec = null;
function maybeShowSpeedup(elapsedSec, which) {
  if (which === 'local') localElapsedSec = elapsedSec;
  else fleetElapsedSec = elapsedSec;
  if (localElapsedSec != null && fleetElapsedSec != null) {
    const speedup = localElapsedSec / fleetElapsedSec;
    el('speedup').innerHTML = `${speedup.toFixed(1)}<span class="unit">x faster on the fleet</span>`;
  }
}

// Fetched once and reused across every call to runFleetRace() in this
// page session - both are static assets, not per-run data.
let glueSourcePromise = null;
let wasmBase64Promise = null;
async function getGlueSource() {
  if (!glueSourcePromise) glueSourcePromise = fetch('./ffmpeg-wasm/dcp-transcode-glue.js').then((r) => r.text());
  return glueSourcePromise;
}
async function getWasmBase64() {
  if (!wasmBase64Promise) {
    wasmBase64Promise = fetch('./ffmpeg-wasm/dcp-transcode.wasm')
      .then((r) => r.arrayBuffer())
      .then((buf) => bytesToBase64(new Uint8Array(buf)));
  }
  return wasmBase64Promise;
}

async function runFleetRace({ compute }, chunks, units, durations) {
  // No job.requires() on this job at all, unlike every Node job script
  // in this project - confirmed live that the browser build's
  // job.requires() only resolves published DCP packages by name
  // ("Could not locate module /packages/ffmpeg-wasm/package.dcp" for a
  // specifier that was a perfectly valid local relative path), not
  // arbitrary local files fetched from the page's own origin the way
  // Node's filesystem-based bundler does. No local-package-publishing
  // workflow was available to try instead, so this ships the glue code
  // and wasm bytes as bound arguments - the delivery mechanism already
  // proven throughout this project, just not normally used for
  // something this large. Real cost: unlike the job.requires() sandbox
  // wrapper (whose module-scoped getModule() cache persists across
  // multiple slices dispatched to the same worker process), a bound
  // argument can't back a module-scope cache the same way - work
  // functions are re-eval'd fresh per slice, so every single slice here
  // re-materializes and re-instantiates the wasm module from scratch.
  log('Fetching wasm module + glue for fleet dispatch (bound arguments, not job.requires - see the how-to doc)...');
  const [glueSource, wasmBase64] = await Promise.all([getGlueSource(), getWasmBase64()]);

  const jobUnits = units.map((u) => ({
    chunkIndex: u.chunkIndex,
    label: u.rendition.label,
    width: u.rendition.width,
    height: u.rendition.height,
    bitrateKbps: u.rendition.bitrateKbps,
    encoder: u.rendition.encoder,
    chunkBase64: bytesToBase64(chunks[u.chunkIndex]),
  }));

  async function workFunction(unit, glueSourceArg, wasmBase64Arg) {
    progress();
    // Materialize createFfmpegModule from the inlined Emscripten glue
    // source - same file as ffmpeg-wasm/dcp-transcode-glue.js, just
    // eval'd via a CommonJS shim instead of loaded through require().
    const moduleShim = { exports: {} };
    new Function('module', 'exports', glueSourceArg)(moduleShim, moduleShim.exports);
    const createFfmpegModule = moduleShim.exports;

    const wasmBytes = Uint8Array.from(atob(wasmBase64Arg), (c) => c.charCodeAt(0));
    const Module = await createFfmpegModule({
      instantiateWasm(imports, successCallback) {
        WebAssembly.instantiate(wasmBytes, imports).then((result) => successCallback(result.instance));
      },
    });

    const chunkBytes = Uint8Array.from(atob(unit.chunkBase64), (c) => c.charCodeAt(0));
    const inPath = '/chunk-in.ts';
    const outPath = '/chunk-out.ts';
    Module.FS.writeFile(inPath, chunkBytes);
    // Real per-slice compute time, measured on whichever worker actually
    // executes this slice - not a proxy from the local browser tab. This
    // is what the DCP cost comparison below is priced from: since every
    // encoder in this project is single-threaded, wall-clock time spent
    // in this one ccall IS real vCPU-seconds consumed on real DCP
    // hardware, no normalization needed (unlike a same-hardware-assumed
    // estimate would). Date.now(), not performance.now(): no prior use
    // of performance.now() inside a dispatched work function elsewhere
    // in this project to confirm it's available in every sandbox this
    // could run in, and Date.now() is universally available in JS.
    const computeT0 = Date.now();
    const ret = Module.ccall(
      'transcode_segment', 'number',
      ['string', 'string', 'number', 'number', 'number', 'string'],
      [inPath, outPath, unit.width, unit.height, unit.bitrateKbps, unit.encoder],
    );
    const computeSeconds = (Date.now() - computeT0) / 1000;
    if (ret !== 0) throw new Error(`transcode_segment() failed with code ${ret}`);
    const segBytes = Module.FS.readFile(outPath);
    progress();

    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < segBytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, segBytes.subarray(i, i + chunkSize));
    }
    return { chunkIndex: unit.chunkIndex, label: unit.label, segmentBase64: btoa(binary), computeSeconds };
  }

  const job = compute.for(jobUnits, workFunction, [glueSource, wasmBase64]);

  job.computeGroups = [COMPUTE_GROUP];
  job.public = {
    name: 'Bell FFmpeg+WASM live demo (browser)',
    description: 'Browser-dispatched chunked ABR transcode race vs. in-page local encoding',
    link: 'https://bell.ca',
  };

  const t0 = performance.now();
  const timer = setInterval(() => {
    el('fleetTime').textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);

  let completed = 0;
  let totalCost = 0;
  let totalDcpRawCost = 0;
  const resultTimestamps = [];
  const byRendition = {};
  const renditionBytes = {};
  const renditionByLabel = new Map(RENDITIONS.map((r) => [r.label, r]));
  for (const r of RENDITIONS) {
    byRendition[r.label] = new Array(chunks.length).fill(null);
    renditionBytes[r.label] = 0;
  }

  job.on('readystatechange', (ev) => log(`DCP job: ${ev}`));
  job.on('accepted', () => log(`Job accepted: ${job.id}`));
  job.on('error', (err) => log(`Job error: ${err.message || err}`));
  job.on('nofunds', (ev) => log(`Nofunds: ${JSON.stringify(ev)}`));
  job.on('result', (ev) => {
    completed += 1;
    resultTimestamps.push(Date.now());
    el('fleetBar').style.width = `${(completed / jobUnits.length) * 100}%`;
    el('statCompleted').textContent = `${completed} / ${jobUnits.length}`;
    markGridCell(ev.result.chunkIndex, ev.result.label);
    byRendition[ev.result.label][ev.result.chunkIndex] = ev.result.segmentBase64;
    renditionBytes[ev.result.label] += atob(ev.result.segmentBase64).length;
    updateThroughputStats(resultTimestamps, (performance.now() - t0) / 1000, completed);
    // Real per-unit chunk duration, not an average across the whole
    // video - durations[chunkIndex] is already tracked precisely by
    // sliceVideoAdaptive(), no reason to approximate when the real
    // number is right there.
    const rendition = renditionByLabel.get(ev.result.label);
    const chunkDurationMin = (durations[ev.result.chunkIndex] || 0) / 60;
    totalCost += chunkDurationMin * awsRatePerMinute(rendition);
    updateCostCounter(totalCost, completed, jobUnits.length);
    // Priced from this slice's own real measured compute time
    // (ev.result.computeSeconds, timed inside workFunction on whichever
    // worker actually ran it) - ticks live from the same event AWS's
    // cost does, not gated on the separate (and much slower, single-
    // threaded) local race finishing.
    totalDcpRawCost += dcpRawCostForSeconds(ev.result.computeSeconds || 0);
    updateDcpCostComparison(totalDcpRawCost, completed, jobUnits.length);
    updateCodecComparison(renditionBytes);
  });

  log(`Dispatching ${jobUnits.length} unit(s) to the DCP fleet (computeGroup: ${COMPUTE_GROUP.joinKey})...`);
  try {
    job.greedyEstimation = true;             // to force an even slice distribution
    job.estimationSlices = jobUnits.length;  // to force an even slice distribution
    await job.exec(compute.marketRate);
  } catch (err) {
    clearInterval(timer);
    log(`Fleet job failed: ${err.message || err}`);
    return null;
  }

  clearInterval(timer);
  const elapsedSec = (performance.now() - t0) / 1000;
  el('fleetTime').textContent = `${elapsedSec.toFixed(1)}s`;
  log(`Fleet race done in ${elapsedSec.toFixed(1)}s`);
  maybeShowSpeedup(elapsedSec, 'fleet');
  return { byRendition };
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---- Progress grid ----
// No structural meaning to rows/columns - just every (chunk, rendition)
// unit as one small tile, the same way a GitHub contribution graph does,
// not a deliberate chunk x rendition matrix. Each cell's `title` tooltip
// still identifies which unit it is on hover.

// GRID_CELL_MAX: the largest a cell is ever allowed to render at - half
// the surface area of this grid's original fixed 32px cell (32*32=1024,
// half=512, side=sqrt(512)~=22.6, rounded). GRID_GAP scaled down to
// match the same gap:cell ratio the original 4px/32px pairing had.
// GRID_MAX_HEIGHT: the grid's reserved footprint. Rather than growing
// the page forever for a large chunk x rendition count (a 3-hour source
// could produce thousands of units), setupGrid() computes the largest
// cell size, up to GRID_CELL_MAX, that still tiles every unit inside a
// box this tall - so a bigger workload shrinks the squares instead of
// growing the block.
const GRID_CELL_MAX = 23;
const GRID_GAP = 3;
const GRID_MAX_HEIGHT = 220;

// Tries every column count and keeps whichever yields the largest cell
// size that still fits `total` cells inside containerWidth x
// GRID_MAX_HEIGHT - so small workloads render at the natural (capped)
// size, and only workloads big enough to need more room than the
// reserved block has get shrunk. `>=`, not `>`: once a column count
// reaches the GRID_CELL_MAX cap, every larger column count ties at the
// same cell size - keep updating through the tie so the result is the
// widest (most columns, fewest rows) layout at that size, not the
// narrowest, closer to how the grid looked before this was dynamic.
function computeGridLayout(total, containerWidth) {
  let bestCols = 1;
  let bestSize = 0;
  for (let cols = 1; cols <= total; cols++) {
    const rows = Math.ceil(total / cols);
    const sizeByWidth = (containerWidth + GRID_GAP) / cols - GRID_GAP;
    const sizeByHeight = (GRID_MAX_HEIGHT + GRID_GAP) / rows - GRID_GAP;
    const size = Math.min(sizeByWidth, sizeByHeight, GRID_CELL_MAX);
    if (size >= bestSize) {
      bestSize = size;
      bestCols = cols;
    }
  }
  return { cols: bestCols, cellSize: Math.max(2, bestSize) };
}

let gridCells = {};
function setupGrid(chunkCount, renditions) {
  const grid = el('grid');
  grid.innerHTML = '';
  gridCells = {};
  const total = chunkCount * renditions.length;
  const { cols, cellSize } = computeGridLayout(total, grid.clientWidth);
  grid.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;
  grid.style.gap = `${GRID_GAP}px`;
  for (let c = 0; c < chunkCount; c++) {
    for (const r of renditions) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.style.width = `${cellSize}px`;
      cell.title = `chunk ${c} @ ${r.label}`;
      grid.appendChild(cell);
      gridCells[`${c}:${r.label}`] = cell;
    }
  }
}
function markGridCell(chunkIndex, label) {
  const cell = gridCells[`${chunkIndex}:${label}`];
  if (cell) cell.classList.add('done');
}

function updateThroughputStats(resultTimestamps, elapsedSec, completed) {
  const now = Date.now();
  const windowMs = 4000;
  const recent = resultTimestamps.filter((t) => now - t < windowMs);
  const throughput = recent.length / (windowMs / 1000);
  el('statThroughput').textContent = throughput.toFixed(2);

  // Little's Law estimate (L = lambda * W): concurrency ~= arrival rate
  // (results/sec, recent window) x average time-per-unit-so-far. This is
  // a real approximation technique, but "average time-per-unit-so-far"
  // is itself derived from overlapping/concurrent work, so treat the
  // result as illustrative, not a precise worker count.
  const avgSecPerUnit = completed > 0 ? elapsedSec / completed : 0;
  const concurrency = throughput * avgSecPerUnit;
  el('statConcurrent').textContent = Math.max(1, Math.round(concurrency)).toString();
}

// ---- Cost counter ----
// totalCost is accumulated by the caller (runFleetRace's 'result'
// handler) per-unit, using each unit's own real chunk duration and its
// rendition's real AWS-equivalent rate (awsRatePerMinute above) - not
// approximated from an average here.
function updateCostCounter(totalCost, completed, totalUnits) {
  el('costCounter').textContent = `$${totalCost.toFixed(4)}`;
  el('costDetail').textContent =
    `${completed}/${totalUnits} units, AWS MediaConvert-equivalent rates: ` +
    `$${AWS_BASIC_TIER_RATE_PER_MIN.toFixed(4)}/min (H.264, Basic tier, SD) vs. ` +
    `$${AWS_AV1_RATE_PER_MIN.toFixed(4)}/min (AV1, Professional tier, ${AWS_AV1_SD_SINGLEPASS_MULTIPLIER}x SD multiplier)`;
}

// Called live from runFleetRace's 'result' handler, once per completed
// fleet slice - same event, same cadence as updateCostCounter (AWS)
// above, so this doesn't lag behind waiting on the separate (and much
// slower, single-threaded) local race to finish.
function updateDcpCostComparison(totalRawCost, completed, totalUnits) {
  const bellInternalCost = totalRawCost * BELL_INTERNAL_NET_FACTOR;
  const bellExternalRevenue = totalRawCost * BELL_EXTERNAL_REVENUE_SHARE;

  el('statDcpRaw').textContent = `$${totalRawCost.toFixed(4)}`;
  el('statDcpInternal').textContent = `$${bellInternalCost.toFixed(4)}`;
  el('statDcpExternal').textContent = `$${bellExternalRevenue.toFixed(4)}`;
  el('dcpDetail').textContent =
    `${completed}/${totalUnits} fleet slices: priced from each slice's own real compute time`;
}

// ---- Codec comparison: 240p (H.264) vs. av1-240p (SVT-AV1), same
// resolution/bitrate - live totals as fleet results land, the actual
// size difference this project's bake-off found, not just asserted. ----
function updateCodecComparison(renditionBytes) {
  const h264Bytes = renditionBytes['h264-240p-quality'] || 0;
  const av1Bytes = renditionBytes['av1-240p'] || 0;
  el('statH264Bytes').textContent = `${(h264Bytes / (1024 * 1024)).toFixed(2)} MB`;
  el('statAv1Bytes').textContent = `${(av1Bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (h264Bytes > 0 && av1Bytes > 0) {
    const pct = (1 - av1Bytes / h264Bytes) * 100;
    el('statAv1Savings').textContent = `${pct.toFixed(0)}% smaller`;
  }
}

// ---- HLS assembly + playback (blob URLs, no server - see the plan doc) ----
function assembleAndPlay(byRendition, durations, renditions) {
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  let firstMediaUrl = null;

  for (const rendition of renditions) {
    if (rendition.playable === false) continue; // e.g. av1-240p - see RENDITIONS' comment
    const segs = byRendition[rendition.label];
    if (!segs || segs.some((s) => s === null)) {
      log(`Skipping ${rendition.label} in playback - incomplete (some chunks missing).`);
      continue;
    }
    const mediaLines = [
      '#EXTM3U', '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ];
    let totalBytes = 0;
    for (let i = 0; i < segs.length; i++) {
      const bytes = Uint8Array.from(atob(segs[i]), (c) => c.charCodeAt(0));
      totalBytes += bytes.length;
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'video/mp2t' }));
      mediaLines.push(`#EXTINF:${durations[i].toFixed(3)},`, blobUrl);
    }
    mediaLines.push('#EXT-X-ENDLIST');
    const mediaUrl = URL.createObjectURL(new Blob([mediaLines.join('\n')], { type: 'application/vnd.apple.mpegurl' }));
    if (!firstMediaUrl) firstMediaUrl = mediaUrl;

    const bandwidth = Math.round((totalBytes * 8) / totalDuration);
    masterLines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${rendition.width}x${rendition.height}`,
      mediaUrl,
    );
  }

  if (!firstMediaUrl) {
    log('No complete renditions to play - fleet job likely failed or was cut short.');
    return;
  }

  const masterUrl = URL.createObjectURL(new Blob([masterLines.join('\n')], { type: 'application/vnd.apple.mpegurl' }));
  el('playerSection').classList.remove('hidden');
  const video = el('player');

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls();
    hls.loadSource(masterUrl);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => log('HLS manifest parsed, ready to play.'));
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = masterUrl; // Safari native HLS
  } else {
    log('hls.js unsupported and no native HLS - cannot play in this browser.');
  }
}

// ---- Scrubbing preview: thumbnail sprite sheet + WebVTT sprite map ----
// generate_thumbnails() (dcp-transcode.c) only extracts individual JPEG
// frames, not a composited sheet - gluing them into one sprite image is
// simpler done here via <canvas> than in C, and mirrors how a real
// pipeline would split the work anyway (server-side frame extraction,
// edge/client-side sprite assembly).
const THUMB_COUNT = 20;
const THUMB_WIDTH = 120;
const THUMB_HEIGHT = 90;

// Runs against the ORIGINAL upload, not chunks - kicked off in parallel
// with slicing (see runWithBytes) since it's independent work, not
// something that should add to the race's critical path.
async function generateThumbnailSprite(inputBytes) {
  const thumbnails = await window.ffmpegBrowser.generateThumbnails(inputBytes, THUMB_COUNT, THUMB_WIDTH, THUMB_HEIGHT);
  const bitmaps = await Promise.all(
    thumbnails.map((jpegBytes) => createImageBitmap(new Blob([jpegBytes], { type: 'image/jpeg' }))),
  );

  const sprite = document.createElement('canvas');
  sprite.width = THUMB_WIDTH * bitmaps.length;
  sprite.height = THUMB_HEIGHT;
  const ctx = sprite.getContext('2d');
  bitmaps.forEach((bmp, i) => ctx.drawImage(bmp, i * THUMB_WIDTH, 0, THUMB_WIDTH, THUMB_HEIGHT));

  return { sprite, thumbCount: bitmaps.length };
}

function fmtVttTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

// Builds the WebVTT sprite map - the same format hls.js/video.js
// scrubbing-preview plugins consume, one cue per thumbnail pointing at
// its crop region (#xywh=x,y,w,h) within the single composited sprite -
// and wires the hover-to-scrub interaction. Only callable once the real
// per-chunk durations are known (for the cues' timestamps), which is why
// this is separate from generateThumbnailSprite() above - that part can
// start immediately, this part needs slicing to have finished first.
function finishScrubPreview(sprite, thumbCount, totalDurationSec) {
  const stepSec = totalDurationSec / thumbCount;
  const vttLines = ['WEBVTT', ''];
  for (let i = 0; i < thumbCount; i++) {
    const start = fmtVttTime(i * stepSec);
    const end = fmtVttTime(Math.min((i + 1) * stepSec, totalDurationSec));
    vttLines.push(`${start} --> ${end}`, `sprite.jpg#xywh=${i * THUMB_WIDTH},0,${THUMB_WIDTH},${THUMB_HEIGHT}`, '');
  }
  log(`Scrubbing-preview sprite sheet ready: ${thumbCount} thumbnails, ${sprite.width}x${sprite.height} (WebVTT sprite map generated, same format hls.js/video.js scrubbing plugins consume).`);

  el('thumbSection').classList.remove('hidden');
  el('thumbDetail').textContent =
    `${thumbCount} thumbnails, ${THUMB_WIDTH}x${THUMB_HEIGHT} each, sprite sheet ${sprite.width}x${sprite.height} - hover the bar above to scrub`;

  const bar = el('scrubBar');
  const preview = el('scrubPreview');
  preview.width = THUMB_WIDTH;
  preview.height = THUMB_HEIGHT;
  const pctx = preview.getContext('2d');

  bar.onmousemove = (ev) => {
    const rect = bar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const index = Math.min(thumbCount - 1, Math.floor(frac * thumbCount));
    pctx.clearRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    pctx.drawImage(sprite, index * THUMB_WIDTH, 0, THUMB_WIDTH, THUMB_HEIGHT, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    preview.style.display = 'block';
    preview.style.left = `${Math.min(rect.width - THUMB_WIDTH, Math.max(0, ev.clientX - rect.left - THUMB_WIDTH / 2))}px`;
    const timeSec = frac * totalDurationSec;
    preview.title = `${Math.floor(timeSec / 60)}:${String(Math.floor(timeSec % 60)).padStart(2, '0')}`;
  };
  bar.onmouseleave = () => { preview.style.display = 'none'; };
}
