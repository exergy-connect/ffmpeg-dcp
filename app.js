'use strict';

// Page controller for index.html: dispatches transcode jobs to the DCP fleet.

// 16:9 throughout - the scaler (sws_getContext in dcp-transcode.c)
// stretches to the exact width/height given, no letterbox/pillarbox, so
// a mismatched aspect ratio would distort the picture against a 16:9
// source. Every rendition here (ladder and bake-off) is individually
// skippable via a checkbox in section 1, checked by default -
// toggleId is what wires that up in runOnce().
const RENDITIONS = [
  { label: '1080p', width: 1920, height: 1080, bitrateKbps: 5000, encoder: 'libopenh264', playable: true, toggleId: 'ladder1080pToggle' },
  { label: '720p', width: 1280, height: 720, bitrateKbps: 2500, encoder: 'libopenh264', playable: true, toggleId: 'ladder720pToggle' },
  { label: '480p', width: 854, height: 480, bitrateKbps: 1200, encoder: 'libopenh264', playable: true, toggleId: 'ladder480pToggle' },
  { label: '240p', width: 426, height: 240, bitrateKbps: 400, encoder: 'libopenh264', playable: true, toggleId: 'ladder240pToggle' },
  // Codec-comparison trio, same resolution as the ladder's bottom rung,
  // quality mode (not a bitrate cap, which would make all three
  // converge to the same size). playable: false - not part of the ABR
  // ladder, and AV1/HEVC in MPEG-TS isn't reliably playable in
  // hls.js/browsers.
  { label: 'h264-240p-quality', width: 426, height: 240, bitrateKbps: 0, encoder: 'libopenh264', playable: false, toggleId: 'bakeoffH264Toggle' },
  { label: 'av1-240p', width: 426, height: 240, bitrateKbps: 0, encoder: 'libsvtav1', playable: false, toggleId: 'bakeoffAv1Toggle' },
  { label: 'hevc-240p', width: 426, height: 240, bitrateKbps: 0, encoder: 'libx265', playable: false, toggleId: 'bakeoffHevcToggle' },
];
// The bake-off trio's byte-count stat boxes (section 4) need their own
// wiring beyond the shared skip mechanism above.
const BAKEOFF_RENDITIONS = [
  { label: 'h264-240p-quality', statBytesId: 'statH264Bytes', statSavingsId: null },
  { label: 'av1-240p', statBytesId: 'statAv1Bytes', statSavingsId: 'statAv1Savings' },
  { label: 'hevc-240p', statBytesId: 'statHevcBytes', statSavingsId: 'statHevcSavings' },
];
let skippedLabels = new Set();
const TARGET_CHUNK_FRAMES = 90; // ~3s at 30fps

// Real AWS MediaConvert rate card (aws.amazon.com/mediaconvert/pricing/),
// not derived from running anything on AWS or from this demo's encode
// time - AWS bills per minute of OUTPUT video, so this multiplies real
// chunk duration by the published rate for the codec/resolution tier.
// SD = <720p, HD = 720-1080p (AWS's own boundary) - this ladder tops out
// at 1080p, so 4K/8K multipliers aren't needed here.
//   Basic tier (H.264/AVC): 1x SD, 2x HD, <=30fps single-pass.
//   Professional tier (AV1/HEVC): $0.0120/min base, then AV1 3.5x SD /
//     7x HD, HEVC 2x SD / 4x HD, <=30fps single-pass.
const AWS_BASIC_TIER_RATE_PER_MIN = 0.0075; // H.264/AVC, Basic tier, SD, 1x
const AWS_PROFESSIONAL_TIER_RATE_PER_MIN = 0.0120; // base rate, SD, before codec multiplier
const AWS_AV1_SD_SINGLEPASS_MULTIPLIER = 3.5;
const AWS_AV1_HD_SINGLEPASS_MULTIPLIER = 7;
const AWS_HEVC_SD_SINGLEPASS_MULTIPLIER = 2;
const AWS_HEVC_HD_SINGLEPASS_MULTIPLIER = 4;
const AWS_HD_MIN_HEIGHT = 720; // AWS's own SD/HD boundary
const AWS_AV1_RATE_PER_MIN = AWS_PROFESSIONAL_TIER_RATE_PER_MIN * AWS_AV1_SD_SINGLEPASS_MULTIPLIER; // $0.042/min - bake-off trio is always SD (240p)
const AWS_HEVC_RATE_PER_MIN = AWS_PROFESSIONAL_TIER_RATE_PER_MIN * AWS_HEVC_SD_SINGLEPASS_MULTIPLIER; // $0.024/min - bake-off trio is always SD (240p)
const AWS_H264_HD_RATE_PER_MIN = AWS_BASIC_TIER_RATE_PER_MIN * 2; // $0.015/min

function awsRatePerMinute(rendition) {
  const isHd = rendition.height >= AWS_HD_MIN_HEIGHT;
  if (rendition.encoder === 'libsvtav1') return AWS_PROFESSIONAL_TIER_RATE_PER_MIN * (isHd ? AWS_AV1_HD_SINGLEPASS_MULTIPLIER : AWS_AV1_SD_SINGLEPASS_MULTIPLIER);
  if (rendition.encoder === 'libx265') return AWS_PROFESSIONAL_TIER_RATE_PER_MIN * (isHd ? AWS_HEVC_HD_SINGLEPASS_MULTIPLIER : AWS_HEVC_SD_SINGLEPASS_MULTIPLIER);
  return AWS_BASIC_TIER_RATE_PER_MIN * (isHd ? 2 : 1);
}

// DCP's market rate: 1.000 ⊇ per 100 vCPU-seconds = $0.0003171 USD -
// priced from each slice's own real measured compute time (workFunction
// below), unlike AWS's per-output-minute model above.
const DCP_USD_PER_100_VCPU_SECONDS = 0.0003171;

// DCP's scheduler commission vs. worker earnings split on job payments.
const SCHEDULER_COMMISSION_FACTOR = 0.20;
const WORKER_EARNINGS_FACTOR = 0.80;

const el = (id) => document.getElementById(id);
const logEl = el('log');
function log(msg) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(msg);
}

// ---- DCP account settings: API key + compute group(s), persisted locally ----
const DEFAULT_API_KEY = '0x8dc846130f8d909129b83a155a3c8818d8b146e00412169e10161d49725b6f36';
const API_KEY_STORAGE_KEY = 'ffmpeg-dcp:apiKey';
const COMPUTE_GROUPS_STORAGE_KEY = 'ffmpeg-dcp:computeGroups';

const apiKeyInput = el('apiKeyInput');
apiKeyInput.value = localStorage.getItem(API_KEY_STORAGE_KEY) || '';
apiKeyInput.addEventListener('change', () => localStorage.setItem(API_KEY_STORAGE_KEY, apiKeyInput.value.trim()));

function getApiKey() {
  return apiKeyInput.value.trim() || DEFAULT_API_KEY;
}

// Compute group rows: one {joinKey, joinSecret} pair per row, rendered
// into #computeGroupRows. A blank key means "public group" - at least one
// row is always present so there's always something to fill in; '×'
// removes a row once there's more than one, or just clears the last one.
const computeGroupRowsEl = el('computeGroupRows');
let computeGroupRowEls = [];

function loadStoredComputeGroups() {
  try {
    const stored = JSON.parse(localStorage.getItem(COMPUTE_GROUPS_STORAGE_KEY) || 'null');
    if (Array.isArray(stored) && stored.length) return stored;
  } catch { /* fall through to default */ }
  return [{ joinKey: '', joinSecret: '' }];
}

function persistComputeGroups() {
  const groups = computeGroupRowEls.map((row) => ({
    joinKey: row.keyInput.value.trim(),
    joinSecret: row.secretInput.value.trim(),
  }));
  localStorage.setItem(COMPUTE_GROUPS_STORAGE_KEY, JSON.stringify(groups));
  updateQrCode();
}

function makeComputeGroupRow(joinKey, joinSecret) {
  const row = document.createElement('div');
  row.className = 'compute-group-row';
  row.style.cssText = 'display:flex; gap:0.5rem; align-items:center;';

  const fieldStyle = 'flex:1; min-width:0; background:#0d1117; border:1px solid #2d3f52; color:#e6edf3; border-radius:6px; padding:0.5rem 0.7rem; font-family:monospace; font-size:0.85rem;';

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = 'joinKey (blank = public)';
  keyInput.value = joinKey || '';
  keyInput.style.cssText = fieldStyle;

  const secretInput = document.createElement('input');
  secretInput.type = 'password';
  secretInput.placeholder = 'joinSecret (optional)';
  secretInput.value = joinSecret || '';
  secretInput.style.cssText = fieldStyle;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = '×';
  removeBtn.title = 'Remove this group';
  removeBtn.style.cssText = 'flex:0 0 auto; background:transparent; border:none; color:#6e7681; cursor:pointer; font-size:1.2rem; padding:0.2rem 0.5rem; line-height:1;';

  keyInput.addEventListener('change', persistComputeGroups);
  secretInput.addEventListener('change', persistComputeGroups);
  removeBtn.addEventListener('click', () => {
    if (computeGroupRowEls.length > 1) {
      computeGroupRowEls = computeGroupRowEls.filter((r) => r.el !== row);
      row.remove();
    } else {
      keyInput.value = '';
      secretInput.value = '';
    }
    persistComputeGroups();
  });

  row.append(keyInput, secretInput, removeBtn);
  return { el: row, keyInput, secretInput };
}

function renderComputeGroupRows(groups) {
  computeGroupRowsEl.innerHTML = '';
  computeGroupRowEls = groups.map((g) => makeComputeGroupRow(g.joinKey, g.joinSecret));
  for (const row of computeGroupRowEls) computeGroupRowsEl.appendChild(row.el);
}
renderComputeGroupRows(loadStoredComputeGroups());

el('addComputeGroupBtn').addEventListener('click', () => {
  const row = makeComputeGroupRow('', '');
  computeGroupRowEls.push(row);
  computeGroupRowsEl.appendChild(row.el);
});

function getComputeGroups() {
  const groups = computeGroupRowEls
    .map((row) => ({ joinKey: row.keyInput.value.trim(), joinSecret: row.secretInput.value.trim() }))
    .filter((g) => g.joinKey);
  if (!groups.length) return [{ joinKey: 'public' }];
  return groups.map((g) => (g.joinSecret ? g : { joinKey: g.joinKey }));
}

const qrcode = new QRCode(el('qrcode'), { width: 128, height: 128 });
// Only ever points at one group - dcp.live's join flow is for joining a
// single compute group, not several. Several configured: point at the
// first (same one job.computeGroups puts first). None configured
// (public): plain dcp.live, no query param needed for the public group.
function updateQrCode() {
  const groups = getComputeGroups();
  if (groups.length === 1 && groups[0].joinKey === 'public') {
    qrcode.makeCode('https://dcp.live');
    return;
  }
  const first = groups[0];
  const raw = first.joinSecret ? `${first.joinKey},${first.joinSecret}` : first.joinKey;
  qrcode.makeCode(`https://dcp.live/?computeGroups=${encodeURIComponent(raw)}`);
}
updateQrCode();

el('clearAccountBtn').addEventListener('click', (e) => {
  e.preventDefault();
  apiKeyInput.value = '';
  localStorage.removeItem(API_KEY_STORAGE_KEY);
  localStorage.removeItem(COMPUTE_GROUPS_STORAGE_KEY);
  renderComputeGroupRows([{ joinKey: '', joinSecret: '' }]);
  updateQrCode();
  log('Cleared saved API key and compute group(s) from local storage.');
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
// Bundled real sample clip (repo root, committed alongside index.html/app.js
// like the wasm binary is - no build step, no network dependency beyond
// this same origin).
el('demoClipBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  log('Fetching bundled sample clip (videoplayback.mp4)...');
  try {
    const res = await fetch('./videoplayback.mp4');
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching videoplayback.mp4`);
    const buf = await res.arrayBuffer();
    handleFile(new File([buf], 'videoplayback.mp4', { type: 'video/mp4' }));
  } catch (err) {
    log(`Could not load the sample clip: ${err.message}`);
  }
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

// ---- Local wasm execution: slicing ----
// Delegates to ffmpeg-worker.js so this never blocks the main thread.
async function sliceVideo(inputBytes, targetChunkFrames) {
  return callWorker('sliceVideo', [inputBytes, targetChunkFrames]);
}

// Local race only (see dispatchJob's workFunction for the fleet's own
// equivalent, which runs the exact same transcode_segment() call but
// inside a DCP sandbox instead of this tab's worker).
async function transcodeSegment(chunkBytes, params) {
  return callWorker('transcodeSegment', [chunkBytes, params]);
}

// ---- ffmpeg-worker.js RPC client: slicing + demo-clip generation ----
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

// ---- Main orchestration ----
let runInProgress = false;
function beginRun() {
  if (runInProgress) {
    log('A run is already in progress - ignoring this trigger until it finishes.');
    return false;
  }
  runInProgress = true;
  return true;
}
function endRun() {
  runInProgress = false;
}

async function runWithBytes(inputBytes, inputBaseName) {
  if (!beginRun()) return;
  try {
    await runOnce(inputBytes, inputBaseName);
  } finally {
    endRun();
  }
}

async function runOnce(inputBytes, inputBaseName) {
  el('raceSection').classList.remove('hidden');
  el('joinSection').classList.remove('hidden');
  el('liveSection').classList.remove('hidden');
  el('costSection').classList.remove('hidden');
  el('codecSection').classList.remove('hidden');
  resetUi();
  showPreprocessing('Preprocessing (slicing source video)');

  log('Slicing (client-side, same wasm module used everywhere else in this project)...');
  const { chunks, durations, fps } = await sliceVideo(inputBytes, TARGET_CHUNK_FRAMES);
  log(`Sliced into ${chunks.length} chunk(s), fps=${fps.toFixed(2)}, durations=[${durations.map((d) => d.toFixed(2)).join(', ')}]`);
  updatePreprocessing('Preprocessing (connecting to the DCP fleet)');

  // Loudness normalization is disabled -- the toggle for it was removed
  // from the UI, it didn't work correctly. normalizeLoudness stays wired
  // through dispatchJob/runLocalRace/workFunction as a plain `false` so
  // none of that plumbing needs to change if it's ever fixed and reenabled.
  const normalizeLoudness = false;

  skippedLabels = new Set(RENDITIONS.filter((r) => !el(r.toggleId).checked).map((r) => r.label));
  if (skippedLabels.size) log(`Skipping rendition(s) this run: ${[...skippedLabels].join(', ')}`);
  for (const b of BAKEOFF_RENDITIONS) {
    if (skippedLabels.has(b.label)) {
      el(b.statBytesId).textContent = 'skipped';
      if (b.statSavingsId) el(b.statSavingsId).textContent = 'skipped';
    }
  }
  const activeRenditions = RENDITIONS.filter((r) => !skippedLabels.has(r.label));

  const maxDistribution = el('maxDistributionToggle').checked;
  setupGrid(chunks.length, activeRenditions, maxDistribution);
  hidePreprocessing();

  // Local race is optional (dcpOnlyToggle) and, when it runs, races the
  // fleet for real - kicked off as soon as the wallet/identity is ready
  // (dispatchJob's onWalletReady), not after the fleet job finishes.
  const dcpOnly = el('dcpOnlyToggle').checked;
  el('localRaceRow').classList.toggle('hidden', dcpOnly);
  let resolveWalletReady;
  const walletReady = new Promise((resolve) => { resolveWalletReady = resolve; });
  const fleetPromise = dispatchJob(chunks, activeRenditions, durations, normalizeLoudness, maxDistribution, inputBaseName, resolveWalletReady);

  let localPromise = Promise.resolve();
  if (!dcpOnly) {
    await walletReady;
    const units = [];
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      for (const rendition of activeRenditions) units.push({ chunkIndex, rendition });
    }
    localPromise = runLocalRace(chunks, units, normalizeLoudness);
  }

  let fleetOutcome;
  try {
    fleetOutcome = await fleetPromise;
    // Show DCP results the moment the fleet job finishes -- these don't
    // depend on the local race at all, so there's no reason to make
    // playback/download wait for it too, even though runOnce() itself
    // still needs to (see the finally below).
    if (fleetOutcome) {
      assembleAndPlay(fleetOutcome.byRendition, durations, RENDITIONS);
      setupSaveOutputs(fleetOutcome.byRendition, inputBaseName);
    }
  } catch (err) {
    log(`Dispatch error: ${err.message}`);
  } finally {
    await localPromise; // don't return while the local race is still running - endRun() would unblock a new run too early
  }
}

// ---- Local race: same wasm module, sequential, in-page ----
let localElapsedSec = null;
let fleetElapsedSec = null;
function maybeShowSpeedup(elapsedSec, which) {
  if (which === 'local') localElapsedSec = elapsedSec;
  else fleetElapsedSec = elapsedSec;
  if (localElapsedSec != null && fleetElapsedSec != null) {
    const speedup = localElapsedSec / fleetElapsedSec;
    el('speedup').innerHTML = `${speedup.toFixed(1)}<span class="unit">x faster on the fleet</span>`;
  }
}

async function runLocalRace(chunks, units, normalizeLoudness) {
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
        normalizeLoudness,
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
}

function resetUi() {
  el('localBar').style.width = '0%';
  el('localTime').textContent = '0.0s';
  el('fleetBar').style.width = '0%';
  el('fleetTime').textContent = '0.0s';
  el('speedup').textContent = '';
  el('readyStateBadge').textContent = '';
  localElapsedSec = null;
  fleetElapsedSec = null;
  el('costCounter').textContent = '$0.0000';
  el('statDcpRaw').textContent = '$0.0000';
  el('statSchedulerCommission').textContent = '$0.0000';
  el('statWorkerEarnings').textContent = '$0.0000';
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
}

// Animated-ellipsis status line covering slicing
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

// ---- Fleet dispatch ----
if (window.dcpConfig && window.dcpConfig.job) {
  window.dcpConfig.job.uploadInitialNumberOfSlices = 1; // start at 1 slice/pile, not 4 - see above
  window.dcpConfig.job.uploadSlicesTarget = 5E6;         // 5MB, down from the 10MB default (real slices here run ~2-6MB)
  window.dcpConfig.job.uploadSlicesCeiling = 100E6;      // 100MB hard cap, down from 300MB but with real headroom
  window.dcpConfig.job.uploadIncreaseFactor = 1.3;       // gentler ramp than the 2x default
}


// Under max distribution, these three ride together in one slice instead
// of each getting its own: all three are libopenh264 (cheap/fast), so
// bundling them doesn't create a straggler slice, and it saves two of
// this chunk's re-transmissions. 1080p/720p (the biggest renditions) and
// av1-240p/hevc-240p (the priciest per-encode - see the codec section)
// stay on their own slices so more workers can pick them up in parallel.
const MAX_DISTRIBUTION_BUNDLE_LABELS = new Set(['480p', '240p', 'h264-240p-quality']);

// Partitions renditions into DCP-slice groups for max distribution: the
// bundle above collapses into one group (at the position of its first
// member), everything else is its own singleton group - so a chunk with
// all 7 renditions active becomes 5 slices, not 7.
function groupRenditionsForMaxDistribution(renditions) {
  const groups = [];
  let bundleGroup = null;
  renditions.forEach((r, renditionIndex) => {
    if (MAX_DISTRIBUTION_BUNDLE_LABELS.has(r.label)) {
      if (!bundleGroup) { bundleGroup = []; groups.push(bundleGroup); }
      bundleGroup.push(renditionIndex);
    } else {
      groups.push([renditionIndex]);
    }
  });
  return groups;
}

// ---- DCP job definition and dispatch ----
// Two input-set shapes, picked by maxDistribution (section 1 toggle):
// one slice per chunk (looping every rendition inside the sandbox), or
// one slice per chunk x rendition-group ("max distribution" - more,
// smaller slices, so more fleet workers can pick up pieces of this job
// concurrently, at the cost of re-transmitting each chunk's bytes once
// per slice instead of once per chunk). Most rendition-groups are a
// single rendition; see MAX_DISTRIBUTION_BUNDLE_LABELS above for the one
// exception.
//
// identity/wallet/compute.for/job.exec all run HERE, on the main thread,
// where dcp-client already loads via a normal <script> tag - NOT inside a
// Worker. Confirmed directly (2026-08-20): dcp-client.js's loader does
// document.write() to inject dcp-config.js, and its wallet-picker UI does
// direct DOM manipulation - neither works in a WorkerGlobalScope (no
// document/window, only self). Running it in a worker doesn't fail
// cleanly either: the script's own early code (console banner etc.) runs
// fine, then it throws partway through once it touches `document`, and
// Chromium reports that as a generic "importScripts ... failed to load"
// NetworkError rather than the real ReferenceError - easy to mistake for
// a network/CORS problem, which is what the first pass at this bug did.
// Only the base64 encoding of raw chunk bytes (pure data transformation,
// CPU-heavy on large inputs, no dcp-client involved at all) is offloaded
// to dcp-deploy-worker.js.
async function dispatchJob(chunks, activeRenditions, durations, normalizeLoudness, maxDistribution, inputBaseName, onWalletReady) {

  const { compute, identity, wallet } = window.dcp;

  // ID AND PAYMENT
  await identity.set(getApiKey());
  const pay = await wallet.get();
  await wallet.add(pay);
  onWalletReady?.(); // lets runOnce() start the local race concurrently, not after this whole job finishes


  // INPUT SET
  // Each slice carries only its own chunk's bytes (not a shared argument
  // broadcast to every worker - compute.for's arguments array goes to
  // EVERY invocation regardless of which chunk it's assigned, so putting
  // the whole video there would mean every worker downloads all of it).
  // Max distribution still duplicates a given chunk's bytes across its
  // activeRenditions.length slices - that's inherent to dispatching
  // (chunk, rendition) pairs to potentially different workers, not
  // something a data-placement change alone can remove.
  const renditionsMetaJson = JSON.stringify(activeRenditions.map((r) => ({
    label: r.label, width: r.width, height: r.height, bitrateKbps: r.bitrateKbps, encoder: r.encoder,
  })));
  const totalUnits = chunks.length * activeRenditions.length;
  const renditionGroups = maxDistribution ? groupRenditionsForMaxDistribution(activeRenditions) : null;
  const totalSlices = maxDistribution ? chunks.length * renditionGroups.length : chunks.length;

  // Base64-encode the raw chunks in a worker so it doesn't block this
  // thread on large inputs. Structured clone, deliberately NOT a transfer
  // list: runOnce() still owns `chunks` and feeds them to the local race
  // after this call. The clone is a memcpy (GB/s) - trivial next to the
  // base64 work itself.
  const prepWorker = new Worker('./dcp-deploy-worker.js');
  const inputSet = await new Promise((resolve, reject) => {
    prepWorker.onmessage = ({ data }) => resolve(data.inputSet);
    prepWorker.onerror = (err) => reject(new Error(`prep worker failed: ${err.message || 'script error'}`));
    prepWorker.postMessage({ cmd: 'prepare', chunks, renditionGroups, maxDistribution });
  });
  prepWorker.terminate();


  // WORK FUNCTION
  async function workFunction(unit, renditionsMetaJsonArg, normalizeLoudnessArg) {
    progress();
    const renditionsMetaArg = JSON.parse(renditionsMetaJsonArg);
    // Resolved via job.requires(['ffmpeg-wasm-test/ffmpeg-wasm.js']) below -
    // the published package already wraps instantiateWasm around its own
    // embedded wasm bytes, so no glue/wasm shipped as job arguments anymore.
    const { createFfmpegModule } = require('ffmpeg-wasm.js');
    const Module = await createFfmpegModule();

    const chunkBytes = Uint8Array.from(atob(unit.chunkBase64), (c) => c.charCodeAt(0));
    const inPath = '/chunk-in.ts';
    const outPath = '/chunk-out.ts';
    Module.FS.writeFile(inPath, chunkBytes);

    // A subset of renditions if this slice is scoped to one rendition
    // group (unit.renditionIndexes present - usually one rendition, more
    // than one for the bundled group), all of them if it's scoped to the
    // whole chunk - the encode loop itself is otherwise identical.
    const renditionsToRun = unit.renditionIndexes !== undefined
      ? unit.renditionIndexes.map((renditionIndex) => renditionsMetaArg[renditionIndex])
      : renditionsMetaArg;

    const results = [];
    for (const rendition of renditionsToRun) {
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
  const job = compute.for(inputSet, workFunction, [renditionsMetaJson, normalizeLoudness]);
  job.requires(['ffmpeg-wasm-test/ffmpeg-wasm.js']);


  // JOB CONFIG
  job.computeGroups = getComputeGroups();
  job.public = {
    name: `🎞️ FFmpeg+WASM: ${inputBaseName}`,
    description: 'Browser-dispatched chunk x rendition ABR transcode job',
  };
  job.greedyEstimation = true;         // to force an even slice distribution
  job.estimationSlices = totalSlices;


  // EVENTS
  function handleResult(result) {
    const { chunkIndex, renditions: sliceResults } = result;
    // Not a per-hop breakdown (disk->scheduler->worker->scheduler->client) -
    // DCP's client-side API doesn't expose that; a 'result' event is just
    // {sliceNumber, result}, no timing metadata attached. This is the one
    // number actually observable from here: wall-clock time from this job's
    // dispatch until this slice's result arrived, everything (upload wait,
    // network, queue, worker compute, return trip) included. Subtracting
    // each rendition's own computeSeconds (already isolated inside the
    // sandbox, one clock, exact) leaves an "overhead" figure - upload +
    // queue + network - which is the closest honest proxy available.
    const wallSeconds = (performance.now() - t0) / 1000;
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
    markGridCellDone(chunkIndex, sliceResults, activeRenditions, maxDistribution, wallSeconds);
    el('fleetBar').style.width = `${(completed / totalUnits) * 100}%`;
    el('statCompleted').textContent = `${completed} / ${totalUnits}`;
    updateThroughputStats(resultTimestamps);
    updateCostCounter(totalCost, completed, totalUnits);
    updateDcpCostComparison(totalDcpRawCost, completed, totalUnits);
    updateCodecComparison(renditionBytes);
  }

  job.on('error', (err) => log(`Job error: ${err.message || err}`));
  job.on('nofunds', (ev) => log(`Nofunds: ${JSON.stringify(ev)}`));
  job.on('result', (ev) => handleResult(ev.result));
  // States observed in practice: init, preauth, deploying, uploading,
  // compute-groups, listeners, deployed, reconnected, complete.
  job.on('readyStateChange', (state) => { el('readyStateBadge').textContent = state; });


  // EXEC
  const computeGroupsLabel = job.computeGroups.map((g) => g.joinKey).join(', ');
  log(`Dispatching 1 job, ${totalSlices} slice(s) (${totalUnits} rendition-units across ${chunks.length} chunks x ${activeRenditions.length} renditions, ${maxDistribution ? 'distribute ladder' : 'one slice per chunk'}), to the DCP fleet (computeGroup: ${computeGroupsLabel})...`);
  await job.exec(0.124);

  clearInterval(timer);
  const elapsedSec = (performance.now() - t0) / 1000;
  el('fleetTime').textContent = `${elapsedSec.toFixed(1)}s`;
  log(`Job done in ${elapsedSec.toFixed(1)}s (1 job, ${totalSlices} slices)`);
  maybeShowSpeedup(elapsedSec, 'fleet');
  return { byRendition };
}


// ---- Dashboard updates ----
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

// One cell per dispatched slice - matches dispatchJob()'s actual input
// set, which is either one slice per chunk or one per chunk x rendition
// depending on maxDistribution. Hover a cell for its rendition(s).
let gridCells = {};
function setupGrid(chunkCount, renditions, maxDistribution) {
  const grid = el('grid');
  grid.innerHTML = '';
  gridCells = {};
  const total = maxDistribution ? chunkCount * renditions.length : chunkCount;
  const { cols, cellSize } = computeGridLayout(total, grid.clientWidth);
  grid.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;
  grid.style.gap = `${GRID_GAP}px`;
  for (let c = 0; c < chunkCount; c++) {
    if (maxDistribution) {
      for (const r of renditions) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.style.width = `${cellSize}px`;
        cell.title = [`chunk ${c} - pending`, renditionMetaLine(r)].join('\n');
        grid.appendChild(cell);
        gridCells[`${c}:${r.label}`] = cell;
      }
    } else {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.style.width = `${cellSize}px`;
      cell.title = [`chunk ${c} - pending`, ...renditions.map(renditionMetaLine)].join('\n');
      grid.appendChild(cell);
      gridCells[c] = cell;
    }
  }
}
function markGridCellDone(chunkIndex, sliceResults, renditions, maxDistribution, wallSeconds) {
  const renditionByLabel = new Map(renditions.map((r) => [r.label, r]));
  const line = (r) => `${renditionByLabel.has(r.label) ? renditionMetaLine(renditionByLabel.get(r.label)) : r.label} - ${(r.computeSeconds || 0).toFixed(2)}s compute`;
  // wallSeconds is this whole slice's dispatch-to-result time (one number
  // for the slice, not per rendition) - upload+queue+network+return trip,
  // everything except each rendition's own isolated compute time. DCP's
  // client API doesn't expose a per-hop breakdown (disk->scheduler,
  // scheduler->worker, worker->scheduler, scheduler->client) - this slice
  // total, minus the compute line(s) above, is the closest honest proxy.
  const title = [
    `chunk ${chunkIndex} - done`,
    ...sliceResults.map(line),
    `${wallSeconds.toFixed(2)}s wall time since dispatch (this slice - includes upload/queue/network, not just compute)`,
  ].join('\n');
  // Under max distribution a bundled slice (see MAX_DISTRIBUTION_BUNDLE_LABELS)
  // returns more than one rendition at once - every one of them landed
  // together, so every one of their grid cells gets marked done together.
  if (maxDistribution) {
    for (const r of sliceResults) {
      const cell = gridCells[`${chunkIndex}:${r.label}`];
      if (!cell) continue;
      cell.classList.add('done');
      cell.title = title;
    }
  } else {
    const cell = gridCells[chunkIndex];
    if (!cell) return;
    cell.classList.add('done');
    cell.title = title;
  }
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
    `${completed}/${totalUnits} units, AWS's published rate x real output minutes (not run on AWS, not this demo's encode time): ` +
    `$${AWS_BASIC_TIER_RATE_PER_MIN.toFixed(4)}/min H.264 SD, $${AWS_H264_HD_RATE_PER_MIN.toFixed(4)} HD, ` +
    `$${AWS_AV1_RATE_PER_MIN.toFixed(4)} AV1 SD (bake-off only), $${AWS_HEVC_RATE_PER_MIN.toFixed(4)} HEVC SD (bake-off only)`;
}

function updateDcpCostComparison(totalRawCost, completed, totalUnits) {
  const schedulerCommission = totalRawCost * SCHEDULER_COMMISSION_FACTOR;
  const workerEarnings = totalRawCost * WORKER_EARNINGS_FACTOR;

  el('statDcpRaw').textContent = `$${totalRawCost.toFixed(4)}`;
  el('statSchedulerCommission').textContent = `$${schedulerCommission.toFixed(4)}`;
  el('statWorkerEarnings').textContent = `$${workerEarnings.toFixed(4)}`;
  el('dcpDetail').textContent =
    `${completed}/${totalUnits} fleet slices: priced from each slice's own real compute time`;
}

function updateCodecComparison(renditionBytes) {
  const h264Bytes = renditionBytes['h264-240p-quality'] || 0;
  const av1Bytes = renditionBytes['av1-240p'] || 0;
  const hevcBytes = renditionBytes['hevc-240p'] || 0;
  // Skipped renditions never produce a result (renditionBytes stays 0) -
  // left showing "skipped" (set in runOnce) instead of "0.00 MB".
  if (!skippedLabels.has('h264-240p-quality')) {
    el('statH264Bytes').textContent = `${(h264Bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (!skippedLabels.has('av1-240p')) {
    el('statAv1Bytes').textContent = `${(av1Bytes / (1024 * 1024)).toFixed(2)} MB`;
    if (h264Bytes > 0 && av1Bytes > 0) {
      const pct = (1 - av1Bytes / h264Bytes) * 100;
      el('statAv1Savings').textContent = `${pct.toFixed(0)}% smaller`;
    }
  }
  if (!skippedLabels.has('hevc-240p')) {
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
