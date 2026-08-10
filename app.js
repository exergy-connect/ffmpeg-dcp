'use strict';

// Page controller for index.html: dispatches to DCP (runFleetRace) and
// races it against a local encode using the same wasm module.

const RENDITIONS = [
  { label: '240p', width: 320, height: 240, bitrateKbps: 500, encoder: 'libopenh264', playable: true },
  { label: '160p', width: 240, height: 160, bitrateKbps: 300, encoder: 'libopenh264', playable: true },
  { label: '120p', width: 160, height: 120, bitrateKbps: 150, encoder: 'libopenh264', playable: true },
  // Codec-comparison trio, quality mode (not a bitrate cap, which would
  // make all three converge to the same size). playable: false - not
  // part of the ABR ladder, and AV1/HEVC in MPEG-TS isn't reliably
  // playable in hls.js/browsers.
  { label: 'h264-240p-quality', width: 320, height: 240, bitrateKbps: 0, encoder: 'libopenh264', playable: false },
  { label: 'av1-240p', width: 320, height: 240, bitrateKbps: 0, encoder: 'libsvtav1', playable: false },
  { label: 'hevc-240p', width: 320, height: 240, bitrateKbps: 0, encoder: 'libx265', playable: false },
];
// Individually skippable via checkboxes in section 1, checked by default.
const BAKEOFF_RENDITIONS = [
  { label: 'h264-240p-quality', toggleId: 'bakeoffH264Toggle', statBytesId: 'statH264Bytes', statSavingsId: null },
  { label: 'av1-240p', toggleId: 'bakeoffAv1Toggle', statBytesId: 'statAv1Bytes', statSavingsId: 'statAv1Savings' },
  { label: 'hevc-240p', toggleId: 'bakeoffHevcToggle', statBytesId: 'statHevcBytes', statSavingsId: 'statHevcSavings' },
];
let skippedBakeoffLabels = new Set();
// ~3s at 30fps - near typical real-world GOP sizes, so sliceVideoAdaptive()
// (ffmpeg-worker.js) rarely needs to re-encode a chunk to hit this target.
const TARGET_CHUNK_FRAMES = 90;

// Real AWS MediaConvert rate card (aws.amazon.com/mediaconvert/pricing/),
// not derived from running anything on AWS or from this demo's encode
// time - AWS bills per minute of OUTPUT video, so this multiplies real
// chunk duration by the published rate for the codec/tier:
//   Basic tier (AVC only): $0.0075/min, single-pass.
//   Professional tier (required for AV1/HEVC): $0.0120/min base,
//     x3.5 for AV1 or x2 for HEVC at SD/<=30fps single-pass.
const AWS_BASIC_TIER_RATE_PER_MIN = 0.0075; // H.264/AVC, Basic tier, SD, 1x
const AWS_PROFESSIONAL_TIER_RATE_PER_MIN = 0.0120; // base rate, SD, before codec multiplier
const AWS_AV1_SD_SINGLEPASS_MULTIPLIER = 3.5; // Professional tier, AV1, SD, <=30fps
const AWS_HEVC_SD_SINGLEPASS_MULTIPLIER = 2; // Professional tier, HEVC, SD, <=30fps
const AWS_AV1_RATE_PER_MIN = AWS_PROFESSIONAL_TIER_RATE_PER_MIN * AWS_AV1_SD_SINGLEPASS_MULTIPLIER; // $0.042/min
const AWS_HEVC_RATE_PER_MIN = AWS_PROFESSIONAL_TIER_RATE_PER_MIN * AWS_HEVC_SD_SINGLEPASS_MULTIPLIER; // $0.024/min

function awsRatePerMinute(rendition) {
  if (rendition.encoder === 'libsvtav1') return AWS_AV1_RATE_PER_MIN;
  if (rendition.encoder === 'libx265') return AWS_HEVC_RATE_PER_MIN;
  return AWS_BASIC_TIER_RATE_PER_MIN;
}

// DCP's market rate: 1.000 ⊇ per 100 vCPU-seconds = $0.0003171 USD -
// priced from each slice's own real measured compute time (workFunction
// below), unlike AWS's per-output-minute model above.
const DCP_USD_PER_100_VCPU_SECONDS = 0.0003171;

// Bell's fleet runs at roughly 38% the per-core speed of a GCP-class vCPU.
const BELL_CPU_EFFICIENCY = 0.38;

// Bell earns back 80% of its own spend on internal jobs (net cost 20%),
// or keeps 80% as revenue reselling externally (Distributive keeps 20%).
const BELL_INTERNAL_NET_FACTOR = 0.20;
const BELL_EXTERNAL_REVENUE_SHARE = 0.80;

const el = (id) => document.getElementById(id);
const logEl = el('log');
function log(msg) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(msg);
}

new QRCode(el('qrcode'), {
  text: `https://dcp.live/?computeGroups=bell,18be80`,
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
el('demoClipBtn').addEventListener('click', async (e) => {
  // Stop the click bubbling to dropzone's own handler (fileInput.click()),
  // which would otherwise also pop open the file picker.
  e.stopPropagation();
  const extras = el('demoClipExtrasToggle').checked;
  // generate_test_input() defaults to 320x240 when width/height are 0.
  showDropzoneLoaded(`demo-clip - synthetic, 320x240, 15.0s${extras ? ', dual-language audio + HDR10 tags' : ''}`);
  log(`Generating a synthetic demo clip in-browser (150 frames, 15s @ 10fps${extras ? ', dual-language audio + HDR10 tags' : ''})...`);
  const bytes = await generateTestClip(150, 20, 0, 0, extras ? 1 : 0, extras ? 1 : 0);
  runWithBytes(bytes, 'demo-clip');
});

function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

// Swaps the dropzone's chooser for a checkmark + file-info line in place.
function showDropzoneLoaded(text) {
  el('dropzoneChooser').classList.add('hidden');
  el('dropzoneLoaded').classList.remove('hidden');
  el('fileInfo').textContent = text;
}

// Native <video> demuxing, not a wasm decode - cheap, but no codec name.
function probeVideoMetadataCheap(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
      URL.revokeObjectURL(url);
    };
    v.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    v.src = url;
  });
}

async function handleFile(file) {
  const sizeStr = formatBytes(file.size);
  showDropzoneLoaded(`${file.name} - ${sizeStr} (${file.type || 'unknown type'}) - reading metadata...`);
  log(`Reading ${file.name} (${(file.size / 1024).toFixed(0)}KB)...`);
  probeVideoMetadataCheap(file).then((meta) => {
    if (meta) {
      el('fileInfo').textContent =
        `${file.name} - ${sizeStr} (${file.type || 'unknown type'}) - ${meta.width}x${meta.height}, ${meta.duration.toFixed(1)}s`;
    }
  });
  const buf = new Uint8Array(await file.arrayBuffer());
  // Filesystem-safe base name, used as the output filename prefix.
  const baseName = file.name.replace(/\.[^./\\]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'input';
  runWithBytes(buf, baseName);
}

// ---- ffmpeg-worker.js RPC client ----
// The actual wasm work (transcoding, slicing) runs in ffmpeg-worker.js, a
// real Web Worker, off the main thread - a single Module.ccall (especially
// a full-source re-encode) is one uninterruptible synchronous block, long
// enough to freeze the tab and trigger the browser's own "Page
// Unresponsive" warning.
const ffmpegWorker = new Worker('./ffmpeg-worker.js');
let nextRpcId = 1;
const pendingRpcCalls = new Map();

ffmpegWorker.onmessage = ({ data: { id, result, error, progress } }) => {
  const p = pendingRpcCalls.get(id);
  if (!p) return;
  if (progress !== undefined) {
    if (p.onProgress) p.onProgress(progress);
    return; // more messages (progress updates, then the final result) still coming
  }
  pendingRpcCalls.delete(id);
  if (error) p.reject(new Error(error));
  else p.resolve(result);
};
ffmpegWorker.onerror = (err) => {
  // A worker-level error (e.g. a script load failure) has no request id
  // to match to a specific pending call - reject everything outstanding
  // rather than leaving those promises hanging forever.
  for (const [id, p] of pendingRpcCalls) {
    pendingRpcCalls.delete(id);
    p.reject(new Error(`ffmpeg worker error: ${err.message || err}`));
  }
};

function callWorker(fn, args, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    pendingRpcCalls.set(id, { resolve, reject, onProgress });
    ffmpegWorker.postMessage({ id, fn, args });
  });
}

async function transcodeSegment(chunkBytes, params = {}) {
  return callWorker('transcodeSegment', [chunkBytes, params]);
}
async function sliceVideoAdaptive(inputBytes, targetChunkFrames, outWidth = 0, outHeight = 0, onProgress) {
  return callWorker('sliceVideoAdaptive', [inputBytes, targetChunkFrames, outWidth, outHeight], onProgress);
}
async function generateTestClip(numFrames, gopSize, width = 0, height = 0, extraAudioTrack = 0, hdr = 0) {
  return callWorker('generateTestClip', [numFrames, gopSize, width, height, extraAudioTrack, hdr]);
}

// ---- Main orchestration ----
let runInProgress = false;
async function runWithBytes(inputBytes, inputBaseName) {
  if (runInProgress) {
    log('A run is already in progress - ignoring this trigger until it finishes.');
    return;
  }
  runInProgress = true;
  try {
    await runOnce(inputBytes, inputBaseName);
  } finally {
    runInProgress = false;
  }
}

async function runOnce(inputBytes, inputBaseName) {
  el('raceSection').classList.remove('hidden');
  el('liveSection').classList.remove('hidden');
  el('costSection').classList.remove('hidden');
  el('codecSection').classList.remove('hidden');
  resetUi();
  showPreprocessing('Preprocessing (slicing source video)');

  const maxRenditionWidth = Math.max(...RENDITIONS.map((r) => r.width));
  const maxRenditionHeight = Math.max(...RENDITIONS.map((r) => r.height));
  log('Slicing (client-side, same wasm module used everywhere else in this project)...');
  // Slices cheaply at native keyframes, then re-encodes only oversized
  // chunks (capped at the largest rendition) - see ffmpeg-worker.js.
  const { chunks, durations, fps } = await sliceVideoAdaptive(
    inputBytes, TARGET_CHUNK_FRAMES, maxRenditionWidth, maxRenditionHeight,
    (info) => {
      if (info.phase === 'sliced') {
        log(`Native slice: ${info.nativeChunks} chunk(s), ${info.needsReencode} too big for target - re-encoding those individually...`);
        if (info.needsReencode) updatePreprocessing(`Preprocessing (re-encoding ${info.needsReencode} oversized chunk(s))`);
      } else if (info.phase === 'reencoding') {
        log(`  re-encoding oversized chunk ${info.current}/${info.total}...`);
        updatePreprocessing(`Preprocessing (re-encoding oversized chunk ${info.current}/${info.total})`);
      }
    },
  );
  log(`Sliced into ${chunks.length} chunk(s), fps=${fps.toFixed(2)}, durations=[${durations.map((d) => d.toFixed(2)).join(', ')}]`);
  updatePreprocessing('Preprocessing (connecting to the DCP fleet)');

  const normalizeLoudness = el('normalizeLoudnessToggle').checked;
  if (normalizeLoudness) log('Loudness normalization enabled: audio on every rendition runs a real decode -> loudnorm filter -> re-encode pass.');

  skippedBakeoffLabels = new Set(BAKEOFF_RENDITIONS.filter((b) => !el(b.toggleId).checked).map((b) => b.label));
  if (skippedBakeoffLabels.size) log(`Skipping bake-off rendition(s) this run: ${[...skippedBakeoffLabels].join(', ')}`);
  for (const b of BAKEOFF_RENDITIONS) {
    if (skippedBakeoffLabels.has(b.label)) {
      el(b.statBytesId).textContent = 'skipped';
      if (b.statSavingsId) el(b.statSavingsId).textContent = 'skipped';
    }
  }
  const activeRenditions = RENDITIONS.filter((r) => !skippedBakeoffLabels.has(r.label));

  const units = [];
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    for (const rendition of activeRenditions) units.push({ chunkIndex, rendition, normalizeLoudness });
  }
  setupGrid(chunks.length, activeRenditions);
  hidePreprocessing();

  // Local race waits for the wallet handshake so it doesn't start
  // encoding while the passphrase modal is still up - runFleetRace()
  // resolves this right after wallet.add(), before it starts dispatch.
  let resolveWalletReady;
  const walletReady = new Promise((resolve) => { resolveWalletReady = resolve; });
  const fleetPromise = runFleetRace(chunks, activeRenditions, durations, normalizeLoudness, resolveWalletReady);
  await walletReady;
  const localPromise = runLocalRace(chunks, units);

  // Off fleetPromise directly, not Promise.all - playback/save don't
  // need the (much slower) local race to finish too.
  fleetPromise.then((fleetOutcome) => {
    if (fleetOutcome) {
      assembleAndPlay(fleetOutcome.byRendition, durations, RENDITIONS);
      setupSaveOutputs(fleetOutcome.byRendition, inputBaseName);
    }
  }).catch((err) => log(`Fleet race promise error: ${err.message}`));

  await localPromise;
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
  el('statHevcBytes').textContent = '0 MB';
  el('statHevcSavings').textContent = '—';
  el('playerSection').classList.add('hidden');
  el('saveOutputsBtn').classList.add('hidden');
  el('saveOutputsStatus').textContent = '';
  hidePreprocessing();
  localElapsedSec = null;
  fleetElapsedSec = null;
}

// Animated-ellipsis status line covering slicing, before the race bars start moving.
let preprocessingInterval = null;
let preprocessingBaseText = '';
function showPreprocessing(text) {
  preprocessingBaseText = text;
  const target = el('preprocessingStatus');
  target.classList.remove('hidden');
  clearInterval(preprocessingInterval);
  let dots = 0;
  target.textContent = text;
  preprocessingInterval = setInterval(() => {
    dots = (dots + 1) % 4;
    target.textContent = preprocessingBaseText + '.'.repeat(dots);
  }, 400);
}
function updatePreprocessing(text) {
  preprocessingBaseText = text;
}
function hidePreprocessing() {
  clearInterval(preprocessingInterval);
  el('preprocessingStatus').classList.add('hidden');
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
      await transcodeSegment(chunkBytes, {
        width: unit.rendition.width,
        height: unit.rendition.height,
        bitrateKbps: unit.rendition.bitrateKbps,
        encoder: unit.rendition.encoder,
        normalizeLoudness: unit.normalizeLoudness,
      });
    } catch (err) {
      log(`Local encode failed for chunk ${unit.chunkIndex} @ ${unit.rendition.label}: ${err.message}`);
    }
    completed += 1;
    el('localBar').style.width = `${(completed / units.length) * 100}%`;
    // Yield so the progress bar/timer repaint between (still-blocking) units.
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

// Fetched once, reused across every runFleetRace() call this session.
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
function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}


// ---- DCP job definition and dispatch, one slice PER CHUNK ----
async function runFleetRace(chunks, activeRenditions, durations, normalizeLoudness, onWalletReady) {

  const { compute, identity, wallet } = window.dcp;
  log('Fetching wasm module + glue for fleet dispatch...');
  const [glueSource, wasmBase64] = await Promise.all([getGlueSource(), getWasmBase64()]);


  // ID AND PAYMENT
  await identity.set('0x87ba424720c4a221f0f9c541928f366b2d1b6c78bff4107288c1e9985dd88a91');
  const pay = await wallet.get('live demo');
  await wallet.add(pay);
  if (onWalletReady) onWalletReady();


  // INPUT SET
  const renditionsMetaJson = JSON.stringify(activeRenditions.map((r) => ({
    label: r.label, width: r.width, height: r.height, bitrateKbps: r.bitrateKbps, encoder: r.encoder,
  })));
  const totalUnits = chunks.length * activeRenditions.length;
  const inputSet = chunks.map((c, chunkIndex) => ({ chunkIndex, chunkBase64: bytesToBase64(c) }));


  // WORK FUNCTION
  async function workFunction(unit, glueSourceArg, wasmBase64Arg, renditionsMetaJsonArg, normalizeLoudnessArg) {
    progress();
    const renditionsMetaArg = JSON.parse(renditionsMetaJsonArg);
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

    const results = [];
    for (const rendition of renditionsMetaArg) {
      const computeT0 = Date.now();
      const ret = Module.ccall(
        'transcode_segment', 'number',
        ['string', 'string', 'number', 'number', 'number', 'string', 'number'],
        [inPath, outPath, rendition.width, rendition.height, rendition.bitrateKbps, rendition.encoder, normalizeLoudnessArg ? 1 : 0],
      );
      const computeSeconds = (Date.now() - computeT0) / 1000;
      if (ret !== 0) throw new Error(`transcode_segment() failed with code ${ret}`);
      const segBytes = Module.FS.readFile(outPath);
      Module.FS.unlink(outPath);
      progress();

      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < segBytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, segBytes.subarray(i, i + chunkSize));
      }
      results.push({ label: rendition.label, segmentBase64: btoa(binary), computeSeconds });
    }
    Module.FS.unlink(inPath);
    return { chunkIndex: unit.chunkIndex, renditions: results };
  }

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


  // JOB
  const job = compute.for(inputSet, workFunction, [glueSource, wasmBase64, renditionsMetaJson, normalizeLoudness]);
  

  // JOB CONFIG
  job.computeGroups = [
    { joinKey: 'bell', joinSecret: '18be80' }
  ];
  job.public = {
    name: '🎞️ FFmpeg+WASM',
    description: 'Browser-dispatched chunk x rendition ABR transcode race vs. in-page local encoding',
    link: 'https://bell.ca',
  };
  job.greedyEstimation = true;          // to force an even slice distribution
  job.estimationSlices = chunks.length; // one slice per chunk


  // EVENTS
  function handleResult(ev) {
    const { chunkIndex, renditions: sliceResults } = ev.result;
    for (const r of sliceResults) {
      completed += 1;
      resultTimestamps.push(Date.now());
      byRendition[r.label][chunkIndex] = r.segmentBase64;
      renditionBytes[r.label] += atob(r.segmentBase64).length;
      const rendition = renditionByLabel.get(r.label);
      const chunkDurationMin = (durations[chunkIndex] || 0) / 60;
      totalCost += chunkDurationMin * awsRatePerMinute(rendition);
      totalDcpRawCost += r.computeSeconds / 100 * DCP_USD_PER_100_VCPU_SECONDS || 0;
    }
    markGridCellDone(chunkIndex, sliceResults, activeRenditions);
    el('fleetBar').style.width = `${(completed / totalUnits) * 100}%`;
    el('statCompleted').textContent = `${completed} / ${totalUnits}`;
    updateThroughputStats(resultTimestamps);
    updateCostCounter(totalCost, completed, totalUnits);
    updateDcpCostComparison(totalDcpRawCost, completed, totalUnits);
    updateCodecComparison(renditionBytes);
  }

  job.on('error', (err) => log(`Job error: ${err.message || err}`));
  job.on('nofunds', (ev) => log(`Nofunds: ${JSON.stringify(ev)}`));
  job.on('result', handleResult);


  // EXEC
  log(`Dispatching 1 job, ${chunks.length} slice(s) (${totalUnits} rendition-units across ${chunks.length} chunks x ${activeRenditions.length} renditions), to the DCP fleet (computeGroup: bell)...`);
  await job.exec();

  clearInterval(timer);
  const elapsedSec = (performance.now() - t0) / 1000;
  el('fleetTime').textContent = `${elapsedSec.toFixed(1)}s`;
  log(`Fleet race done in ${elapsedSec.toFixed(1)}s (1 job, ${chunks.length} slices)`);
  maybeShowSpeedup(elapsedSec, 'fleet');
  return { byRendition };
}


// ---- Dasboard updates ----
const GRID_CELL_MAX = 23;
const GRID_GAP = 3;
const GRID_MAX_HEIGHT = 220;

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

function renditionMetaLine(r) {
  return `${r.label}: ${r.width}x${r.height}, ${r.bitrateKbps ? `${r.bitrateKbps}kbps` : 'quality mode'}, ${r.encoder}`;
}

// One cell per dispatched slice (one chunk, looping every active
// rendition inside the sandbox) - matches the real DCP dispatch
// granularity. Hover a cell for that slice's full rendition breakdown.
let gridCells = {};
function setupGrid(chunkCount, renditions) {
  const grid = el('grid');
  grid.innerHTML = '';
  gridCells = {};
  const { cols, cellSize } = computeGridLayout(chunkCount, grid.clientWidth);
  grid.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;
  grid.style.gap = `${GRID_GAP}px`;
  for (let c = 0; c < chunkCount; c++) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    cell.style.width = `${cellSize}px`;
    cell.title = [`chunk ${c} - pending`, ...renditions.map(renditionMetaLine)].join('\n');
    grid.appendChild(cell);
    gridCells[c] = cell;
  }
}
function markGridCellDone(chunkIndex, sliceResults, renditions) {
  const cell = gridCells[chunkIndex];
  if (!cell) return;
  cell.classList.add('done');
  const renditionByLabel = new Map(renditions.map((r) => [r.label, r]));
  cell.title = [
    `chunk ${chunkIndex} - done`,
    ...sliceResults.map((r) => {
      const meta = renditionByLabel.get(r.label);
      return `${meta ? renditionMetaLine(meta) : r.label} - ${(r.computeSeconds || 0).toFixed(2)}s compute`;
    }),
  ].join('\n');
}

function updateThroughputStats(resultTimestamps) {
  const now = Date.now();
  const windowMs = 4000;
  const recent = resultTimestamps.filter((t) => now - t < windowMs);
  const throughput = recent.length / (windowMs / 1000);
  el('statThroughput').textContent = throughput.toFixed(2);
}

function updateCostCounter(totalCost, completed, totalUnits) {
  el('costCounter').textContent = `$${totalCost.toFixed(4)}`;
  el('costDetail').textContent =
    `${completed}/${totalUnits} units, real minutes x AWS's published rate card (not run on AWS, not this demo's encode time): ` +
    `$${AWS_BASIC_TIER_RATE_PER_MIN.toFixed(4)}/min (H.264, Basic tier, SD) / ` +
    `$${AWS_AV1_RATE_PER_MIN.toFixed(4)}/min (AV1, Professional tier, ${AWS_AV1_SD_SINGLEPASS_MULTIPLIER}x SD multiplier) / ` +
    `$${AWS_HEVC_RATE_PER_MIN.toFixed(4)}/min (HEVC, Professional tier, ${AWS_HEVC_SD_SINGLEPASS_MULTIPLIER}x SD multiplier)`;
}

function updateDcpCostComparison(totalRawCost, completed, totalUnits) {
  const bellInternalCost = totalRawCost * BELL_INTERNAL_NET_FACTOR;
  const bellExternalRevenue = totalRawCost * BELL_EXTERNAL_REVENUE_SHARE;

  el('statDcpRaw').textContent = `$${totalRawCost.toFixed(4)}`;
  el('statDcpInternal').textContent = `$${bellInternalCost.toFixed(4)}`;
  el('statDcpExternal').textContent = `$${bellExternalRevenue.toFixed(4)}`;
  el('dcpDetail').textContent =
    `${completed}/${totalUnits} fleet slices: priced from each slice's own real compute time`;
}

function updateCodecComparison(renditionBytes) {
  const h264Bytes = renditionBytes['h264-240p-quality'] || 0;
  const av1Bytes = renditionBytes['av1-240p'] || 0;
  const hevcBytes = renditionBytes['hevc-240p'] || 0;
  // Skipped renditions never produce a result (renditionBytes stays 0) -
  // left showing "skipped" (set in runOnce) instead of "0.00 MB".
  if (!skippedBakeoffLabels.has('h264-240p-quality')) {
    el('statH264Bytes').textContent = `${(h264Bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (!skippedBakeoffLabels.has('av1-240p')) {
    el('statAv1Bytes').textContent = `${(av1Bytes / (1024 * 1024)).toFixed(2)} MB`;
    if (h264Bytes > 0 && av1Bytes > 0) {
      const pct = (1 - av1Bytes / h264Bytes) * 100;
      el('statAv1Savings').textContent = `${pct.toFixed(0)}% smaller`;
    }
  }
  if (!skippedBakeoffLabels.has('hevc-240p')) {
    el('statHevcBytes').textContent = `${(hevcBytes / (1024 * 1024)).toFixed(2)} MB`;
    if (h264Bytes > 0 && hevcBytes > 0) {
      const pct = (1 - hevcBytes / h264Bytes) * 100;
      el('statHevcSavings').textContent = `${pct.toFixed(0)}% smaller`;
    }
  }
}

// ---- HLS assembly + playback ----
// Only playable renditions (the ABR ladder) reach this function - hls.js
// picks between them by bandwidth; levelRenditions (same order as
// masterLines below) lets LEVEL_SWITCHED report which one is active.
function assembleAndPlay(byRendition, durations, renditions) {
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  const levelRenditions = [];
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
    levelRenditions.push(rendition);
  }

  if (!firstMediaUrl) {
    log('No complete renditions to play - fleet job likely failed or was cut short.');
    return;
  }

  const masterUrl = URL.createObjectURL(new Blob([masterLines.join('\n')], { type: 'application/vnd.apple.mpegurl' }));
  el('playerSection').classList.remove('hidden');
  const video = el('player');
  const nowPlaying = el('nowPlayingLabel');
  nowPlaying.textContent =
    `Adaptive across ${levelRenditions.map((r) => r.label).join(', ')} (H.264) - hls.js switches renditions live based on estimated bandwidth.`;

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls();
    hls.loadSource(masterUrl);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => log('HLS manifest parsed, ready to play.'));
    hls.on(window.Hls.Events.LEVEL_SWITCHED, (event, data) => {
      const r = levelRenditions[data.level];
      if (r) {
        nowPlaying.textContent =
          `Now playing: ${r.label} (${r.width}x${r.height}, H.264, ${r.bitrateKbps}kbps target) - ` +
          `hls.js may switch to ${levelRenditions.map((x) => x.label).join('/')} based on estimated bandwidth.`;
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = masterUrl; // Safari native HLS
    nowPlaying.textContent += ' (Safari native HLS: switching happens, but which rendition is active isn\'t exposed to this page.)';
  } else {
    log('hls.js unsupported and no native HLS - cannot play in this browser.');
  }
}

// ---- Save outputs to disk (File System Access API, Chromium-only) ----
function setupSaveOutputs(byRendition, inputBaseName) {
  const btn = el('saveOutputsBtn');
  if (!window.showDirectoryPicker) {
    btn.classList.add('hidden');
    el('saveOutputsStatus').textContent =
      'Save-to-disk needs the File System Access API (Chrome/Edge) - not available in this browser.';
    return;
  }
  btn.classList.remove('hidden');
  btn.onclick = () => saveOutputsToDisk(byRendition, RENDITIONS, inputBaseName);
}

async function saveOutputsToDisk(byRendition, renditions, inputBaseName) {
  const status = el('saveOutputsStatus');
  let rootHandle;
  try {
    rootHandle = await window.showDirectoryPicker();
  } catch (err) {
    if (err.name === 'AbortError') { status.textContent = 'Save cancelled.'; return; }
    status.textContent = `Could not open a folder picker: ${err.message}`;
    return;
  }

  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  status.textContent = `Saving to ${stamp}/...`;
  try {
    const runHandle = await rootHandle.getDirectoryHandle(stamp, { create: true });

    let stitched = 0;
    let skippedRenditions = 0;
    for (const rendition of renditions) {
      const segs = byRendition[rendition.label];
      if (!segs) continue;

      const chunkBytesList = [];
      let complete = true;
      for (let i = 0; i < segs.length; i++) {
        if (!segs[i]) { complete = false; continue; }
        chunkBytesList.push(Uint8Array.from(atob(segs[i]), (c) => c.charCodeAt(0)));
      }
      if (!complete || chunkBytesList.length === 0) { skippedRenditions += 1; continue; }

      const totalLength = chunkBytesList.reduce((sum, b) => sum + b.length, 0);
      const full = new Uint8Array(totalLength);
      let offset = 0;
      for (const b of chunkBytesList) { full.set(b, offset); offset += b.length; }
      const fullName = `${inputBaseName}-${rendition.label}.ts`;
      const fullHandle = await runHandle.getFileHandle(fullName, { create: true });
      const fullWritable = await fullHandle.createWritable();
      await fullWritable.write(full);
      await fullWritable.close();
      stitched += 1;
    }
    const msg = `Saved ${stitched} complete video(s) to ${stamp}/` +
      (skippedRenditions ? ` (${skippedRenditions} rendition(s) incomplete, skipped)` : '');
    status.textContent = msg;
    log(msg);
  } catch (err) {
    status.textContent = `Save failed: ${err.message}`;
    log(`Save to disk failed: ${err.message}`);
  }
}
