'use strict';

/**
 * xFrame Social Transcoder runtime.
 * Driven by concepts injected from dcp-transcoding.xp into #app-config.
 * Self-contained under xframe/ — does not import the root app.js.
 */

const CONFIG = JSON.parse(document.getElementById('app-config').textContent);
const el = (id) => document.getElementById(id);
const logEl = el('log');

/** Payment offered per DCP slice (updated from job nofunds events). */
const DEFAULT_SLICE_PAYMENT_DCC = 0.124;
let slicePaymentDcc = DEFAULT_SLICE_PAYMENT_DCC;
const CREDIT_SYMBOL = '\u2287'; // ⊇

let inputDurationSec = null;
let lastKnownBalanceDcc = null;
let balanceRefreshInFlight = false;
let lastExactSliceCount = null;
let lastNofunds = null;

function log(msg) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(msg);
}

/** Verbose activity-log + console helper for DCP diagnosis. */
function dbg(msg, detail) {
  let text = `[debug] ${msg}`;
  if (detail !== undefined) {
    try {
      text += ` ${typeof detail === 'string' ? detail : safeJson(detail)}`;
    } catch (_) {
      text += ` ${String(detail)}`;
    }
  }
  log(text);
}

function safeJson(value, depth = 0) {
  if (value == null) return String(value);
  if (typeof value === 'string') {
    if (value.length > 240) return JSON.stringify(`${value.slice(0, 80)}…(${value.length} chars)`);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') return JSON.stringify(value);
  if (depth > 3) return '"[MaxDepth]"';
  if (Array.isArray(value)) {
    if (value.length > 12) {
      return `[${value.slice(0, 8).map((v) => safeJson(v, depth + 1)).join(',')},…+${value.length - 8}]`;
    }
    return `[${value.map((v) => safeJson(v, depth + 1)).join(',')}]`;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/base64|chunkBase64|segmentBase64|keystore|private|secret|apiKey/i.test(k)) {
      const len = typeof v === 'string' ? v.length : (v?.byteLength ?? '?');
      out[k] = `<omitted len=${len}>`;
    } else if (typeof v === 'string' && v.length > 200) {
      out[k] = `${v.slice(0, 60)}…(${v.length})`;
    } else if (v && typeof v === 'object') {
      out[k] = JSON.parse(safeJson(v, depth + 1));
    } else {
      out[k] = v;
    }
  }
  try {
    return JSON.stringify(out);
  } catch (_) {
    return String(value);
  }
}

/** Mirror every job EventEmitter event into the activity log. */
function attachJobDebug(job) {
  const seen = new Set();
  const bind = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    try {
      job.on(name, (...args) => {
        if (name === 'result') return; // handled with richer logging elsewhere
        const head = args[0];
        if (name === 'readyStateChange') {
          el('readyStateBadge').textContent = String(head);
          dbg(`job.${name}`, head);
          return;
        }
        if (name === 'console' || name === 'stdout' || name === 'stderr') {
          const line = typeof head === 'string'
            ? head
            : (head?.message || head?.data || safeJson(head));
          dbg(`job.${name}`, line);
          return;
        }
        if (name === 'error') {
          dbg(`job.${name}`, head?.message || head?.stack || safeJson(head));
          return;
        }
        if (name === 'accepted') {
          // Prefer job.id; payload is often empty or non-enumerable.
          dbg(`job.${name}`, {
            id: job.id || job.jobId || '(pending)',
            payload: head && typeof head === 'object' ? Object.keys(head) : head,
          });
          return;
        }
        if (name === 'status') {
          const s = (head && typeof head === 'object') ? head : (job.status || {});
          dbg(`job.${name}`, {
            total: s.total,
            distributed: s.distributed,
            computed: s.computed,
            runStatus: s.runStatus,
            raw: head && typeof head !== 'object' ? head : undefined,
          });
          return;
        }
        dbg(`job.${name}`, args.length <= 1 ? head : args);
      });
    } catch (err) {
      dbg(`could not bind job.on('${name}')`, err?.message || err);
    }
  };

  for (const name of [
    'readyStateChange', 'error', 'console', 'stdout', 'stderr', 'nofunds',
    'accepted', 'status', 'cancel', 'complete', 'payment', 'warning',
    'readystatechange', 'slice', 'progress', 'deployed', 'uploaded',
    'submit', 'submitted', 'fetch', 'fetchResult', 'resultHandle',
  ]) {
    bind(name);
  }

  // Catch-all: wrap emit so unknown events still surface.
  if (typeof job.emit === 'function') {
    const origEmit = job.emit.bind(job);
    job.emit = function patchedEmit(event, ...args) {
      try {
        if (event !== 'result' && event !== 'newListener' && event !== 'removeListener') {
          if (event === 'readyStateChange') {
            el('readyStateBadge').textContent = String(args[0]);
          }
          // Known events already log via job.on; only log unknowns here.
          if (!seen.has(event)) {
            dbg(`emit:${event}`, args.length <= 1 ? args[0] : args);
          }
        }
      } catch (_) { /* never break the job path for logging */ }
      return origEmit(event, ...args);
    };
    dbg('patched job.emit for catch-all event logging');
  } else {
    dbg('job.emit missing — only explicit listeners will log');
  }
}

function hideRunError() {
  el('runError').classList.add('hidden');
}
function hideNofunds() {
  lastNofunds = null;
  el('nofundsBox').classList.add('hidden');
}

function clearExactCostBasis() {
  lastExactSliceCount = null;
}
function showNofunds(ev) {
  const fundsRequired = Number(ev?.fundsRequired);
  const slicePay = Number(ev?.slicePaymentAmount);
  const remaining = Number(ev?.remainingSlices);
  const account = ev?.bankAccount ? String(ev.bankAccount) : '';

  if (Number.isFinite(slicePay) && slicePay > 0) {
    slicePaymentDcc = slicePay;
  }
  lastNofunds = {
    fundsRequired: Number.isFinite(fundsRequired) ? fundsRequired : null,
    slicePaymentAmount: slicePaymentDcc,
    remainingSlices: Number.isFinite(remaining) ? remaining : null,
    bankAccount: account,
    job: ev?.job || '',
    name: ev?.name || '',
  };

  el('nofundsRequired').textContent = formatCredits(lastNofunds.fundsRequired);
  el('nofundsRemaining').textContent =
    lastNofunds.remainingSlices != null ? String(lastNofunds.remainingSlices) : '—';
  el('nofundsSlicePay').textContent = formatCredits(lastNofunds.slicePaymentAmount);
  el('nofundsMessage').textContent =
    `Job paused: need ${formatCredits(lastNofunds.fundsRequired)} to finish ` +
    `${lastNofunds.remainingSlices ?? '?'} remaining slice(s).`;
  const shortAcct = account
    ? `${account.slice(0, 10)}…${account.slice(-6)}`
    : 'payment account';
  el('nofundsRemedy').innerHTML =
    `Add funds to <code title="${account}">${shortAcct}</code>, then retry the job. ` +
    `Cost estimate below uses ${formatCredits(slicePaymentDcc)}/slice from the scheduler.`;
  el('nofundsBox').classList.remove('hidden');

  if (lastExactSliceCount != null) updateCostEstimate(lastExactSliceCount);
  else updateCostEstimate();
  fetchAccountBalance().catch(() => {});
}
function showRunError(error) {
  const message = error?.message || String(error);
  let remedy = 'Retry the job. Check the activity log for details.';
  if (/malformed keystore|invalid.*api key/i.test(message)) {
    remedy = 'Enter a valid DCP identity API key (0x + 64 hex).';
  } else if (/Failed to fetch|NetworkError|ERR_NAME_NOT_RESOLVED/i.test(message)) {
    remedy = 'Check network access to scheduler.distributed.computer.';
  } else if (/nofunds|insufficient funds/i.test(message)) {
    remedy = 'Fund the DCP payment account shown above, then retry.';
  } else if (/fetchModuleURL|Could not locate module|package\.dcp|ffmpeg-wasm-social/i.test(message)) {
    remedy = 'Publish the DCP package: cd xframe && node package/build-bravojs-bundle.js && node package/publish.js';
  } else if (/slice_webm|Only VP8 or VP9|MediaRecorder|\.webm/i.test(message)) {
    remedy = 'Use an in-page recording or drop a browser MediaRecorder WebM (VP8/VP9 + Opus). MP4/H.264 files are also accepted now via the MPEG-TS slicer — hard-refresh if you still see a WebM-only error.';
  } else if (/vp8|vp9|opus|decoder|wasm/i.test(message)) {
    remedy = 'Rebuild the xframe WASM package (see xframe/README.md) and publish ffmpeg-wasm-social.';
  }
  el('runErrorMessage').textContent = message;
  el('runErrorRemedy').textContent = remedy;
  el('runError').classList.remove('hidden');
}

function assetUrl(rel) {
  // Every browser runtime asset is staged beside the compiled HTML.
  return new URL(rel.replace(/^\.\//, ''), window.location.href).href;
}

// ---- Account persistence ----
const DEFAULT_API_KEY = '0x8dc846130f8d909129b83a155a3c8818d8b146e00412169e10161d49725b6f36';
const API_KEY_STORAGE_KEY = 'xframe-social:apiKey';
const COMPUTE_GROUPS_STORAGE_KEY = 'xframe-social:computeGroups';
const API_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const apiKeyInput = el('apiKeyInput');
apiKeyInput.value = localStorage.getItem(API_KEY_STORAGE_KEY) || '';

function validateApiKeyField(showError = true) {
  const value = apiKeyInput.value.trim();
  const valid = value === '' || API_KEY_PATTERN.test(value);
  apiKeyInput.setCustomValidity(valid ? '' : 'Invalid key');
  el('apiKeyValidation').classList.toggle('hidden', valid || !showError);
  return valid;
}
apiKeyInput.addEventListener('input', () => {
  validateApiKeyField(apiKeyInput.value.trim() !== '');
  hideRunError();
});
apiKeyInput.addEventListener('change', () => {
  if (validateApiKeyField()) localStorage.setItem(API_KEY_STORAGE_KEY, apiKeyInput.value.trim());
});
el('identityForm').addEventListener('submit', (e) => e.preventDefault());
el('computeGroupsForm').addEventListener('submit', (e) => e.preventDefault());
validateApiKeyField(false);

function getApiKey() {
  return apiKeyInput.value.trim() || DEFAULT_API_KEY;
}

/** identity.set() may only run once per page load (EHAVEIDENTITY). */
async function ensureIdentity() {
  const { identity } = window.dcp || {};
  if (!identity) throw new Error('DCP identity API is not available yet.');
  if (typeof identity.check === 'function' && identity.check()) return;
  try {
    await identity.set(getApiKey());
  } catch (err) {
    const msg = err?.message || String(err);
    if (/already been set|EHAVEIDENTITY/i.test(msg)) return;
    throw err;
  }
}

const computeGroupRowsEl = el('computeGroupRows');
let computeGroupRowEls = [];

function loadStoredComputeGroups() {
  try {
    const stored = JSON.parse(localStorage.getItem(COMPUTE_GROUPS_STORAGE_KEY) || 'null');
    if (Array.isArray(stored) && stored.length) return stored;
  } catch { /* default */ }
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
  row.style.cssText = 'display:flex;gap:0.5rem;align-items:center;margin-bottom:0.4rem';
  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = 'joinKey (blank = public)';
  keyInput.value = joinKey || '';
  const secretInput = document.createElement('input');
  secretInput.type = 'password';
  secretInput.placeholder = 'joinSecret (optional)';
  secretInput.value = joinSecret || '';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = '×';
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

const qrcode = new QRCode(el('qrcode'), { width: 112, height: 112 });
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
  validateApiKeyField(false);
  localStorage.removeItem(API_KEY_STORAGE_KEY);
  localStorage.removeItem(COMPUTE_GROUPS_STORAGE_KEY);
  renderComputeGroupRows([{ joinKey: '', joinSecret: '' }]);
  updateQrCode();
  log('Cleared saved API key and compute group(s).');
});

// ---- Platform UI from concepts ----
function conceptEntries(obj) {
  return Object.entries(obj || {}).filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object');
}

function platformEntries() {
  return conceptEntries(CONFIG.platforms).map(([key, p]) => ({ key, ...p }));
}

function formatOf(placement) {
  const f = placement.format;
  if (f && typeof f === 'object' && f.width) return f;
  // Unresolved Jinja leave-behind: look up by placement id in formats
  const formats = CONFIG.formats || {};
  for (const v of conceptEntries(formats).map(([, fmt]) => fmt)) {
    if (v && v.id === placement.id) return v;
  }
  return f || {};
}

function platformLogo(platformId) {
  const logos = {
    youtube: '<svg viewBox="0 0 32 32" role="img" aria-label="YouTube"><rect width="32" height="32" rx="8" fill="#ff0033"/><path d="M22.9 11.3c-.2-.9-.9-1.6-1.8-1.8C19.5 9 16 9 16 9s-3.5 0-5.1.5c-.9.2-1.6.9-1.8 1.8-.4 1.5-.4 4.7-.4 4.7s0 3.2.4 4.7c.2.9.9 1.6 1.8 1.8 1.6.5 5.1.5 5.1.5s3.5 0 5.1-.5c.9-.2 1.6-.9 1.8-1.8.4-1.5.4-4.7.4-4.7s0-3.2-.4-4.7Z" fill="#fff"/><path d="m14 19.2 5.2-3.2-5.2-3.2v6.4Z" fill="#ff0033"/></svg>',
    x: '<svg viewBox="0 0 32 32" role="img" aria-label="X"><rect width="32" height="32" rx="8" fill="#050505"/><path d="M9.1 8h4.7l4.1 5.5L22.6 8H24l-5.5 6.5L24.8 24h-4.7l-4.5-6.1L10.4 24H9l6-7.1L9.1 8Zm4.1 1.2h-1.8l9.3 13.6h1.8L13.2 9.2Z" fill="#fff"/></svg>',
    instagram: '<svg viewBox="0 0 32 32" role="img" aria-label="Instagram"><defs><radialGradient id="ig-a" cx="30%" cy="100%" r="110%"><stop offset="0" stop-color="#ffd600"/><stop offset=".48" stop-color="#ff0169"/><stop offset="1" stop-color="#d300c5"/></radialGradient></defs><rect width="32" height="32" rx="8" fill="url(#ig-a)"/><rect x="8.5" y="8.5" width="15" height="15" rx="4.5" fill="none" stroke="#fff" stroke-width="2"/><circle cx="16" cy="16" r="3.6" fill="none" stroke="#fff" stroke-width="2"/><circle cx="21.2" cy="10.9" r="1.2" fill="#fff"/></svg>',
    facebook: '<svg viewBox="0 0 32 32" role="img" aria-label="Facebook"><rect width="32" height="32" rx="8" fill="#1877f2"/><path d="M18.2 25v-8h2.7l.4-3.1h-3.1v-2c0-.9.3-1.5 1.6-1.5h1.7V7.6c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.1H12V17h2.8v8h3.4Z" fill="#fff"/></svg>',
    linkedin: '<svg viewBox="0 0 32 32" role="img" aria-label="LinkedIn"><rect width="32" height="32" rx="8" fill="#0a66c2"/><path d="M11.5 12.7H8.4V23h3.1V12.7ZM10 8a1.8 1.8 0 1 0 0 3.6A1.8 1.8 0 0 0 10 8Zm13 9.1c0-3.1-1.7-4.6-3.9-4.6-1.8 0-2.6 1-3.1 1.7v-1.5h-3.1V23H16v-5.1c0-1.3.3-2.7 2-2.7s1.8 1.6 1.8 2.8v5H23v-5.9Z" fill="#fff"/></svg>',
  };
  const logo = document.createElement('span');
  logo.className = 'platform-logo';
  logo.innerHTML = logos[platformId] || '';
  return logo;
}

function renderPlatforms() {
  const host = el('platformList');
  host.innerHTML = '';
  for (const platform of platformEntries()) {
    const card = document.createElement('div');
    card.className = 'platform-card';
    const heading = document.createElement('div');
    heading.className = 'platform-title';
    const title = document.createElement('h3');
    title.textContent = platform.name || platform.id;
    heading.append(platformLogo(platform.id), title);
    card.appendChild(heading);
    const placements = platform.placements || {};
    for (const [pkey, placement] of conceptEntries(placements)) {
      const fmt = formatOf(placement);
      const row = document.createElement('label');
      row.className = 'placement';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.platform = platform.id;
      cb.dataset.placement = pkey;
      cb.dataset.deliverable = placement.id;
      cb.dataset.signature = fmt.signature || `${fmt.width}x${fmt.height}-${fmt.video_bitrate_kbps}-${fmt.audio_bitrate_kbps}-${fmt.max_fps}`;
      cb.checked = !!placement.default_selected;
      cb.addEventListener('change', updateSelectionSummary);
      const text = document.createElement('span');
      text.innerHTML = `<strong>${placement.label}</strong> — ${fmt.width || '?'}×${fmt.height || '?'} @ ${fmt.video_bitrate_kbps || '?'} kbps video / ${fmt.audio_bitrate_kbps || '?'} kbps AAC · signature <code>${cb.dataset.signature}</code>`;
      row.append(cb, text);
      card.appendChild(row);
    }
    host.appendChild(card);
  }
  updateSelectionSummary();
}

function selectedDeliverables() {
  const boxes = [...document.querySelectorAll('#platformList input[type=checkbox]:checked')];
  return boxes.map((cb) => {
    const platform = platformEntries().find((p) => p.id === cb.dataset.platform);
    const placement = platform?.placements?.[cb.dataset.placement];
    const fmt = formatOf(placement || {});
    return {
      deliverableId: cb.dataset.deliverable,
      platformId: cb.dataset.platform,
      platformName: platform?.name || cb.dataset.platform,
      placementKey: cb.dataset.placement,
      placementLabel: placement?.label || cb.dataset.placement,
      signature: cb.dataset.signature,
      width: +fmt.width,
      height: +fmt.height,
      bitrateKbps: +fmt.video_bitrate_kbps,
      audioBitrateKbps: +fmt.audio_bitrate_kbps,
      maxFps: +fmt.max_fps || 30,
      gopSeconds: +fmt.gop_seconds || 2,
      encoder: 'libopenh264',
    };
  });
}

function dedupeFormats(deliverables) {
  const bySig = new Map();
  for (const d of deliverables) {
    if (!bySig.has(d.signature)) {
      bySig.set(d.signature, {
        signature: d.signature,
        width: d.width,
        height: d.height,
        bitrateKbps: d.bitrateKbps,
        audioBitrateKbps: d.audioBitrateKbps,
        maxFps: d.maxFps,
        gopSeconds: d.gopSeconds,
        encoder: d.encoder,
        aliases: [],
      });
    }
    bySig.get(d.signature).aliases.push(d);
  }
  return [...bySig.values()];
}

function updateSelectionSummary() {
  const selected = selectedDeliverables();
  const unique = dedupeFormats(selected);
  const aliasExtra = selected.length - unique.length;
  el('selectionSummary').textContent = selected.length
    ? `${selected.length} placement(s) → ${unique.length} unique encode(s)` +
      (aliasExtra > 0 ? ` (${aliasExtra} shared via identical signatures)` : '')
    : 'No placements selected.';
  el('statUnique').textContent = String(unique.length);
  el('statAliases').textContent = String(selected.length);
  el('runBtn').disabled = !inputBytes || selected.length === 0;
  clearExactCostBasis();
  updateCostEstimate();
}

function formatCredits(n, digits = 3) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${Number(n).toFixed(digits)} ${CREDIT_SYMBOL}`;
}

function estimateChunkCount(durationSec) {
  if (!(durationSec > 0)) return null;
  const targetFrames = CONFIG.dispatch?.target_chunk_frames || 90;
  const fps = CONFIG.timing?.social_default?.output_fps || CONFIG.timing?.social_default?.target_fps || 30;
  return Math.max(1, Math.ceil((durationSec * fps) / targetFrames));
}

/** Rough fallback when browser can't report duration (common for MediaRecorder WebM). */
function estimateChunkCountFromBytes(byteLength) {
  if (!(byteLength > 0)) return null;
  // ~1.2 Mbps average for screen/webcam WebM → bytes/sec
  const approxSec = byteLength / 150000;
  return estimateChunkCount(Math.max(3, approxSec));
}

function estimateSliceCount(uniqueFormatCount, chunkCount) {
  if (!uniqueFormatCount || !chunkCount) return null;
  const maxDistribution = el('maxDistributionToggle')?.checked !== false;
  return maxDistribution ? chunkCount * uniqueFormatCount : chunkCount;
}

function currentChunkEstimate() {
  if (lastExactSliceCount != null) return { chunks: null, approx: false, source: 'exact' };
  const fromDuration = estimateChunkCount(inputDurationSec);
  if (fromDuration != null) return { chunks: fromDuration, approx: true, source: 'duration' };
  if (inputBytes?.length) {
    const fromBytes = estimateChunkCountFromBytes(inputBytes.length);
    if (fromBytes != null) return { chunks: fromBytes, approx: true, source: 'size' };
  }
  return { chunks: null, approx: true, source: 'none' };
}

function updateCostEstimate(exactSliceCount = null) {
  if (exactSliceCount != null) lastExactSliceCount = exactSliceCount;
  const selected = selectedDeliverables();
  const unique = dedupeFormats(selected);
  const chunkInfo = currentChunkEstimate();
  const slices = lastExactSliceCount != null
    ? lastExactSliceCount
    : estimateSliceCount(unique.length, chunkInfo.chunks);

  const costEl = el('costEstimate');
  const detailEl = el('costEstimateDetail');
  const preCost = el('preflightCostValue');
  const preSlices = el('preflightSliceValue');
  const preDetail = el('preflightCostDetail');

  const paint = (costText, sliceText, detail, warn) => {
    costEl.textContent = costText;
    preCost.textContent = costText;
    preSlices.textContent = sliceText;
    detailEl.textContent = detail;
    preDetail.textContent = detail;
    costEl.classList.toggle('warn-text', !!warn);
    preCost.classList.toggle('warn-text', !!warn);
  };

  if (!selected.length) {
    paint('—', '—', 'Select placements to estimate DCP cost.', false);
    return;
  }
  if (!inputBytes) {
    paint('—', '—', 'Load a recording to estimate slice count and cost.', false);
    return;
  }
  if (slices == null) {
    // Still show per-format floor: 1 chunk × unique formats
    const floorSlices = el('maxDistributionToggle').checked ? Math.max(1, unique.length) : 1;
    const floorCost = floorSlices * slicePaymentDcc;
    paint(
      `≥ ${formatCredits(floorCost)}`,
      `≥ ${floorSlices}`,
      `Lower bound for ${unique.length} unique format(s) at ${slicePaymentDcc} ${CREDIT_SYMBOL}/slice (duration unknown).`,
      lastKnownBalanceDcc != null && floorCost > lastKnownBalanceDcc,
    );
    return;
  }

  const costDcc = slices * slicePaymentDcc;
  const approx = lastExactSliceCount == null;
  const chunkNote = lastExactSliceCount != null
    ? `${slices} slice(s)`
    : `~${slices} slice(s) (~${chunkInfo.chunks} chunk(s) × ${unique.length} format(s)` +
      `${el('maxDistributionToggle').checked ? '' : ', bundled'})` +
      `${chunkInfo.source === 'size' ? ', from file size' : ''}` +
      `${chunkInfo.source === 'duration' && inputDurationSec ? `, ${inputDurationSec.toFixed(1)}s` : ''}`;
  let detail =
    `${approx ? '~' : ''}${chunkNote} × ${slicePaymentDcc} ${CREDIT_SYMBOL}/slice` +
    (approx ? ' — before dispatch' : '');

  let warn = false;
  if (lastNofunds?.fundsRequired != null) {
    detail +=
      ` · still need ${formatCredits(lastNofunds.fundsRequired)}` +
      (lastNofunds.remainingSlices != null
        ? ` for ${lastNofunds.remainingSlices} remaining`
        : '');
    warn = true;
  } else if (lastKnownBalanceDcc != null && costDcc > lastKnownBalanceDcc) {
    warn = true;
    detail += ' — estimate exceeds current balance.';
  }

  paint(
    `${approx ? '~' : ''}${formatCredits(costDcc)}`,
    `${approx ? '~' : ''}${slices}`,
    detail,
    warn,
  );
}

async function fetchAccountBalance(existingPayKeystore = null) {
  if (balanceRefreshInFlight) return;
  if (!window.dcp?.protocol || !window.dcp?.wallet || !window.dcp?.identity) {
    el('accountBalance').textContent = '—';
    return;
  }
  if (!window.dcpBankAccount?.viewAccountBalance) {
    el('accountBalance').textContent = '—';
    log('Balance refresh failed: dcp-bank-account.js is not loaded.');
    return;
  }
  if (!validateApiKeyField()) {
    el('accountBalance').textContent = '—';
    log('Balance refresh failed: enter a valid DCP identity API key first.');
    return;
  }
  balanceRefreshInFlight = true;
  const balEl = el('accountBalance');
  balEl.textContent = '…';
  try {
    const { wallet, protocol } = window.dcp;
    // Bank teller signs with connection.identity; must be set before Connection.
    await ensureIdentity();
    const pay = existingPayKeystore || await wallet.get();
    if (!existingPayKeystore) await wallet.add(pay);
    // Same viewAccount protocol as test/accountBalance.js (bank concept in .xp).
    const { balance } = await window.dcpBankAccount.viewAccountBalance({
      Connection: protocol.Connection,
      dcpConfig: window.dcpConfig,
      fromKey: pay,
      bank: CONFIG.bank,
    });
    lastKnownBalanceDcc = balance;
    balEl.textContent = formatCredits(balance);
    updateCostEstimate();
  } catch (err) {
    lastKnownBalanceDcc = null;
    balEl.textContent = '—';
    log(`Balance refresh failed: ${err.message || err}`);
  } finally {
    balanceRefreshInFlight = false;
  }
}

// ---- Recording / file input ----
let inputBytes = null;
let inputBaseName = 'recording';
let mediaRecorder = null;
let recordChunks = [];
let recordStream = null;

renderPlatforms();
el('framingSelect').value = CONFIG.default_framing || 'cover';

function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

function preferredMime() {
  const prefs = CONFIG.input?.mime_preference || [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const m of prefs) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'video/webm';
}

async function readVideoDuration(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(v.src); } catch { /* ignore */ }
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    };
    const timer = setTimeout(() => finish(null), 4000);
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        clearTimeout(timer);
        finish(v.duration);
        return;
      }
      // MediaRecorder WebM often reports Infinity until a far seek forces duration.
      try {
        v.currentTime = Number.MAX_SAFE_INTEGER;
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    };
    v.ontimeupdate = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        clearTimeout(timer);
        finish(v.duration);
      }
    };
    v.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
    v.src = url;
  });
}

async function handleFile(file) {
  const sizeStr = formatBytes(file.size);
  el('inputLoaded').classList.remove('hidden');
  el('fileInfo').textContent = `${file.name} — ${sizeStr} (${file.type || 'unknown'})`;
  inputBaseName = file.name.replace(/\.[^./\\]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'recording';
  inputBytes = new Uint8Array(await file.arrayBuffer());
  const url = URL.createObjectURL(file);
  el('preview').src = url;
  inputDurationSec = await readVideoDuration(URL.createObjectURL(file));
  if (inputDurationSec != null) {
    log(`Loaded ${file.name} (${(file.size / 1024).toFixed(0)} KB, ${inputDurationSec.toFixed(1)}s)`);
  } else {
    log(`Loaded ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
  }
  updateSelectionSummary();
}

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

el('recordBtn').addEventListener('click', async () => {
  try {
    recordStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true,
    }).catch(async () => navigator.mediaDevices.getUserMedia({ video: true, audio: true }));
    const live = el('livePreview');
    live.srcObject = recordStream;
    live.classList.remove('hidden');
    await live.play();
    const mime = preferredMime();
    recordChunks = [];
    mediaRecorder = new MediaRecorder(recordStream, { mimeType: mime });
    mediaRecorder.ondataavailable = (ev) => { if (ev.data?.size) recordChunks.push(ev.data); };
    mediaRecorder.onstop = async () => {
      live.classList.add('hidden');
      live.srcObject = null;
      for (const t of recordStream.getTracks()) t.stop();
      recordStream = null;
      const blob = new Blob(recordChunks, { type: mime.split(';')[0] });
      el('recordStatus').textContent = 'Recording ready';
      await handleFile(new File([blob], `browser-recording-${Date.now()}.webm`, { type: blob.type }));
    };
    mediaRecorder.start(1000);
    el('recordBtn').disabled = true;
    el('stopRecordBtn').disabled = false;
    el('recordStatus').textContent = `Recording… (${mime})`;
    log(`Recording started with ${mime}`);
  } catch (err) {
    showRunError(err);
    log(`Could not start recording: ${err.message}`);
  }
});

el('stopRecordBtn').addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  el('recordBtn').disabled = false;
  el('stopRecordBtn').disabled = true;
});

// ---- ffmpeg worker RPC ----
const ffmpegWorker = new Worker(assetUrl(CONFIG.worker_script || 'ffmpeg-worker.js'));
let nextRpcId = 1;
const pendingRpcCalls = new Map();

ffmpegWorker.onmessage = ({ data: { id, result, error, progress } }) => {
  const p = pendingRpcCalls.get(id);
  if (!p) return;
  if (progress !== undefined) {
    if (p.onProgress) p.onProgress(progress);
    return;
  }
  pendingRpcCalls.delete(id);
  if (error) p.reject(new Error(error));
  else p.resolve(result);
};
ffmpegWorker.onerror = (err) => {
  for (const [, p] of pendingRpcCalls) p.reject(new Error(`ffmpeg worker error: ${err.message || err}`));
  pendingRpcCalls.clear();
};

function callWorker(fn, args, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    pendingRpcCalls.set(id, { resolve, reject, onProgress });
    ffmpegWorker.postMessage({ id, fn, args });
  });
}

async function sliceVideo(bytes, targetChunkFrames) {
  return callWorker('sliceVideo', [bytes, targetChunkFrames]);
}

async function remuxToMp4(tsBytes) {
  return callWorker('remuxToMp4', [tsBytes]);
}

// ---- Grid / progress ----
let gridCells = {};
function setupGrid(total) {
  const grid = el('grid');
  grid.innerHTML = '';
  gridCells = {};
  const cols = Math.min(24, Math.max(1, Math.ceil(Math.sqrt(total))));
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  for (let i = 0; i < total; i++) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    cell.title = `unit ${i}`;
    grid.appendChild(cell);
    gridCells[i] = cell;
  }
}

// ---- DCP dispatch ----
function framingModeCode() {
  const v = el('framingSelect').value;
  if (v === 'contain') return 2;
  if (v === 'stretch') return 0;
  return 1; // cover
}

async function dispatchJob(chunks, uniqueFormats, durations, maxDistribution, inputBaseName, container) {
  const { compute, wallet } = window.dcp;
  dbg('dispatchJob start', {
    chunks: chunks.length,
    formats: uniqueFormats.length,
    maxDistribution,
    container: container || '(sniff)',
    paymentPerSlice: slicePaymentDcc,
    package: CONFIG.dcp_package || 'ffmpeg-wasm-social/ffmpeg-wasm.js',
  });
  dbg('ensureIdentity…');
  await ensureIdentity();
  dbg('wallet.get / wallet.add…');
  const pay = await wallet.get();
  await wallet.add(pay);
  dbg('payment keystore loaded', {
    address: pay?.address || pay?.account || '(unknown)',
    hasId: Boolean(pay),
  });
  await fetchAccountBalance(pay);

  const formatsMeta = uniqueFormats.map((f) => ({
    signature: f.signature,
    width: f.width,
    height: f.height,
    bitrateKbps: f.bitrateKbps,
    audioBitrateKbps: f.audioBitrateKbps,
    maxFps: f.maxFps,
    gopSeconds: f.gopSeconds,
    encoder: f.encoder,
    frameMode: framingModeCode(),
  }));
  const formatsMetaJson = JSON.stringify(formatsMeta);
  const totalUnits = chunks.length * uniqueFormats.length;
  dbg('formatsMeta', formatsMeta.map((f) => `${f.signature} ${f.width}x${f.height}`));

  const prepWorker = new Worker(assetUrl(CONFIG.deploy_worker_script || 'dcp-deploy-worker.js'));
  dbg('prep worker start', assetUrl(CONFIG.deploy_worker_script || 'dcp-deploy-worker.js'));
  const inputSet = await new Promise((resolve, reject) => {
    prepWorker.onmessage = ({ data }) => resolve(data.inputSet);
    prepWorker.onerror = (err) => reject(new Error(`prep worker failed: ${err.message || 'script error'}`));
    prepWorker.postMessage({
      cmd: 'prepare',
      chunks,
      formatCount: uniqueFormats.length,
      maxDistribution,
      container: container || undefined,
    });
  });
  prepWorker.terminate();

  const inputSummary = inputSet.map((u, i) => ({
    i,
    chunkIndex: u.chunkIndex,
    formatIndexes: u.formatIndexes,
    chunkExt: u.chunkExt,
    b64Len: u.chunkBase64?.length ?? 0,
    headHex: (() => {
      try {
        const b = Uint8Array.from(atob(u.chunkBase64.slice(0, 24)), (c) => c.charCodeAt(0));
        return [...b.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('');
      } catch (_) {
        return 'decode-fail';
      }
    })(),
  }));
  dbg(`inputSet ready: ${inputSet.length} slice(s)`, inputSummary.slice(0, 8));
  if (inputSummary.length > 8) dbg(`… ${inputSummary.length - 8} more slice(s) omitted from summary`);

  async function workFunction(unit, formatsMetaJsonArg) {
    // console.* on the worker is often forwarded as job 'console' events.
    const wlog = (...args) => {
      try { console.log('[social-wf]', ...args); } catch (_) { /* ignore */ }
    };
    // Keep the slice alive while the ~8MB WASM package downloads/instantiates;
    // without periodic progress() the scheduler may reclaim the slice mid-load.
    let progressTick = 0;
    const progressKeepalive = setInterval(() => {
      try {
        progressTick += 1;
        progress();
        if (progressTick % 3 === 0) wlog('progress keepalive', { tick: progressTick });
      } catch (_) { /* ignore */ }
    }, 4000);
    const stopKeepalive = () => {
      try { clearInterval(progressKeepalive); } catch (_) { /* ignore */ }
    };

    try {
      progress();
      wlog('start', {
        chunkIndex: unit.chunkIndex,
        formatIndexes: unit.formatIndexes,
        chunkExt: unit.chunkExt,
        b64Len: unit.chunkBase64?.length,
      });
      const formatsMetaArg = JSON.parse(formatsMetaJsonArg);
      wlog('require ffmpeg-wasm.js…');
      const required = require('ffmpeg-wasm.js');
      wlog('require keys', required && typeof required === 'object' ? Object.keys(required) : typeof required);
      const createFfmpegModule = required.createFfmpegModule || required.default || required;
      if (typeof createFfmpegModule !== 'function') {
        throw new Error('ffmpeg-wasm.js did not export createFfmpegModule');
      }
      wlog('createFfmpegModule…');
      const Module = await createFfmpegModule();
      progress();
      wlog('module ready', {
        hasCcall: typeof Module.ccall === 'function',
        hasFS: Boolean(Module.FS),
      });

      const chunkBytes = Uint8Array.from(atob(unit.chunkBase64), (c) => c.charCodeAt(0));
      const isEbml = chunkBytes.length >= 4 &&
        chunkBytes[0] === 0x1a && chunkBytes[1] === 0x45 &&
        chunkBytes[2] === 0xdf && chunkBytes[3] === 0xa3;
      const inExt = unit.chunkExt || (isEbml ? 'webm' : 'ts');
      const inPath = `/chunk-in.${inExt}`;
      wlog('write input', {
        inPath,
        bytes: chunkBytes.length,
        magic: [...chunkBytes.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join(''),
        isEbml,
      });
      Module.FS.writeFile(inPath, chunkBytes);

      const indexes = unit.formatIndexes !== undefined
        ? unit.formatIndexes
        : formatsMetaArg.map((_, i) => i);

      const results = [];
      for (const formatIndex of indexes) {
        const fmt = formatsMetaArg[formatIndex];
        const outPath = `/chunk-out-${formatIndex}.ts`;
        const computeT0 = Date.now();
        const gop = (fmt.gopSeconds || 2) * (fmt.maxFps || 30);
        wlog('transcode_social_segment', {
          formatIndex,
          signature: fmt.signature,
          wh: `${fmt.width}x${fmt.height}`,
          br: fmt.bitrateKbps,
          gop,
          encoder: fmt.encoder || 'libopenh264',
        });
        const code = Module.ccall(
          'transcode_social_segment', 'number',
          ['string', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'string'],
          [
            inPath, outPath, fmt.width, fmt.height, fmt.bitrateKbps,
            fmt.audioBitrateKbps || 160, gop,
            fmt.frameMode === undefined ? 1 : fmt.frameMode,
            fmt.encoder || 'libopenh264',
          ],
        );
        const computeSeconds = (Date.now() - computeT0) / 1000;
        wlog('ccall done', { signature: fmt.signature, code, computeSeconds });
        if (code < 0) {
          throw new Error(`transcode_social_segment failed (${code}) for ${fmt.signature} (in .${inExt})`);
        }
        const segBytes = Module.FS.readFile(outPath);
        Module.FS.unlink(outPath);
        progress();
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < segBytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, segBytes.subarray(i, i + chunkSize));
        }
        results.push({ signature: fmt.signature, segmentBase64: btoa(binary), computeSeconds });
        wlog('segment encoded', { signature: fmt.signature, outBytes: segBytes.length, computeSeconds });
      }
      Module.FS.unlink(inPath);
      wlog('return', { chunkIndex: unit.chunkIndex, segments: results.length });
      return { chunkIndex: unit.chunkIndex, segments: results };
    } catch (err) {
      wlog('FAILED', err && err.message ? err.message : String(err));
      throw err;
    } finally {
      stopKeepalive();
    }
  }

  const t0 = performance.now();
  const timer = setInterval(() => {
    el('fleetTime').textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);

  let completed = 0;
  let resultEvents = 0;
  const bySignature = {};
  for (const f of uniqueFormats) bySignature[f.signature] = new Array(chunks.length).fill(null);

  setupGrid(inputSet.length);
  el('statCompleted').textContent = `0 / ${totalUnits}`;

  dbg('compute.for…', { slices: inputSet.length, argsBytes: formatsMetaJson.length });
  const job = compute.for(inputSet, workFunction, [formatsMetaJson]);
  job.requires([CONFIG.dcp_package || 'ffmpeg-wasm-social/ffmpeg-wasm.js']);
  job.computeGroups = getComputeGroups();
  job.public = {
    name: `🎞️ Social transcoder: ${inputBaseName}`,
    description: 'Browser WebM → social H.264/AAC masters via DCP',
  };
  job.greedyEstimation = true;
  job.estimationSlices = inputSet.length;

  dbg('job config', {
    requires: job.requires,
    computeGroups: job.computeGroups,
    estimationSlices: job.estimationSlices,
    greedyEstimation: job.greedyEstimation,
    id: job.id || job.jobId || job.address || '(pending)',
    keys: Object.keys(job || {}).slice(0, 40),
  });

  attachJobDebug(job);

  let unitIndex = 0;
  let lastStatus = null;
  job.on('accepted', () => {
    log(
      `Job accepted id=${job.id || '(unknown)'} — waiting for workers. ` +
      `Each worker must download/instantiate ffmpeg-wasm-social (~8MB); first result often takes 1–3+ minutes.`,
    );
  });
  job.on('status', (ev) => {
    const s = (ev && typeof ev === 'object' && ('distributed' in ev || 'computed' in ev))
      ? ev
      : (job.status || ev || {});
    lastStatus = {
      total: s.total,
      distributed: s.distributed,
      computed: s.computed,
      runStatus: s.runStatus,
    };
    const statusEl = el('preprocessingStatus');
    if (statusEl) {
      statusEl.textContent =
        `Fleet ${lastStatus.runStatus || el('readyStateBadge')?.textContent || '?'} · ` +
        `distributed ${lastStatus.distributed ?? '?'}/${lastStatus.total ?? inputSet.length} · ` +
        `computed ${lastStatus.computed ?? 0} · results ${resultEvents}`;
    }
  });
  job.on('nofunds', (ev) => {
    log(`Nofunds: ${safeJson(ev)}`);
    showNofunds(ev);
    showRunError(new Error(
      `Insufficient DCP funds: need ${ev?.fundsRequired ?? '?'} ${CREDIT_SYMBOL} ` +
      `for ${ev?.remainingSlices ?? '?'} remaining slice(s).`,
    ));
  });
  job.on('result', (ev) => {
    resultEvents += 1;
    dbg(`result event #${resultEvents}`, {
      sliceNumber: ev?.sliceNumber,
      keys: ev && typeof ev === 'object' ? Object.keys(ev) : typeof ev,
      resultType: typeof ev?.result,
      resultKeys: ev?.result && typeof ev.result === 'object' ? Object.keys(ev.result) : undefined,
    });
    const payload = ev?.result ?? ev;
    const chunkIndex = payload?.chunkIndex;
    const segments = payload?.segments;
    if (!Array.isArray(segments)) {
      log(`Unexpected result payload (slice ${ev?.sliceNumber ?? '?'}): ${safeJson(payload)}`);
      return;
    }
    for (const seg of segments) {
      if (!seg?.signature || !bySignature[seg.signature]) {
        log(`Unknown signature in result: ${seg?.signature}`);
        continue;
      }
      bySignature[seg.signature][chunkIndex] = seg.segmentBase64;
      completed += 1;
    }
    const cell = gridCells[unitIndex++];
    if (cell) cell.classList.add('done');
    el('fleetBar').style.width = `${(completed / totalUnits) * 100}%`;
    el('statCompleted').textContent = `${completed} / ${totalUnits}`;
    const status = el('preprocessingStatus');
    if (status) {
      status.textContent = `Fleet: received ${completed}/${totalUnits} format-units…`;
    }
    log(
      `Received slice ${ev?.sliceNumber ?? unitIndex}: chunk ${chunkIndex}, ` +
      `${segments.length} segment(s) (${completed}/${totalUnits} format-units)`,
    );
  });

  const groupsLabel = (job.computeGroups || []).map((g) => g.joinKey || g).join(', ') || '(default)';
  log(`Dispatching ${inputSet.length} slice(s), ${totalUnits} format-units (${chunks.length} chunks × ${uniqueFormats.length} unique formats) → groups: ${groupsLabel}`);
  updateCostEstimate(inputSet.length);

  const heartbeat = setInterval(() => {
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    const state = el('readyStateBadge')?.textContent || '?';
    const st = lastStatus || job.status || {};
    dbg(`heartbeat ${sec}s`, {
      readyState: state,
      jobId: job.id || '(none)',
      resultEvents,
      completed,
      totalUnits,
      slices: inputSet.length,
      statusTotal: st.total,
      distributed: st.distributed,
      computed: st.computed,
      runStatus: st.runStatus,
    });
    if (Number(sec) >= 30 && (st.distributed == null || Number(st.distributed) === 0) && resultEvents === 0) {
      dbg(
        'hint: still 0 distributed slices — public workers may be scarce, or open https://dcp.live ' +
        'and join this compute group so a worker can pick up work',
      );
    }
    if (Number(st.distributed) > 0 && Number(st.computed) === 0 && resultEvents === 0 && Number(sec) >= 45) {
      dbg(
        'hint: slices are distributed but none computed yet — workers are likely still loading ' +
        'ffmpeg-wasm-social WASM; watch for job.console [social-wf] lines',
      );
    }
    const status = el('preprocessingStatus');
    if (status) {
      status.textContent =
        `Fleet ${st.runStatus || state} · ${sec}s · dist ${st.distributed ?? 0}/${st.total ?? inputSet.length} · ` +
        `computed ${st.computed ?? 0} · results ${resultEvents}`;
    }
  }, 5000);

  dbg(`job.exec(${slicePaymentDcc})…`);
  try {
    await job.exec(slicePaymentDcc);
    dbg('job.exec resolved');
  } catch (err) {
    dbg('job.exec rejected', err?.message || err);
    throw err;
  } finally {
    clearInterval(heartbeat);
    clearInterval(timer);
  }

  const elapsedSec = (performance.now() - t0) / 1000;
  el('fleetTime').textContent = `${elapsedSec.toFixed(1)}s`;
  log(`Job done in ${elapsedSec.toFixed(1)}s — result events=${resultEvents}, format-units=${completed}/${totalUnits}`);
  dbg('post-job signature fill', Object.fromEntries(
    Object.entries(bySignature).map(([sig, arr]) => [sig, arr.map((x) => (x ? 'ok' : 'missing'))]),
  ));
  fetchAccountBalance().catch(() => {});
  if (completed === 0) {
    throw new Error(
      'DCP finished with no segments received. Workers likely failed on the fleet. ' +
      'Scroll the activity log for [debug] job.error / job.console / Worker lines — ' +
      'you may still have been charged for attempted slices.',
    );
  }
  if (completed < totalUnits) {
    throw new Error(
      `Incomplete results: received ${completed}/${totalUnits} format-units. ` +
      'Some slices failed on the fleet; assemble aborted to avoid corrupt masters.',
    );
  }
  return { bySignature, durations };
}

async function assembleMasters(bySignature, uniqueFormats, durations, deliverables) {
  const outputs = [];
  el('outputsSection').classList.remove('hidden');
  const host = el('outputs');
  host.innerHTML = '';

  for (const fmt of uniqueFormats) {
    const segs = bySignature[fmt.signature];
    if (!segs || segs.some((s) => s === null)) {
      log(`Skipping incomplete signature ${fmt.signature}`);
      continue;
    }
    const parts = segs.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const concat = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { concat.set(p, off); off += p.length; }

    log(`Remuxing ${fmt.signature} → MP4 (${formatBytes(concat.length)} TS)…`);
    const mp4Bytes = await remuxToMp4(concat);
    const aliases = fmt.aliases || deliverables.filter((d) => d.signature === fmt.signature);
    for (const alias of aliases) {
      const name = `${inputBaseName}-${alias.deliverableId}.mp4`;
      const blob = new Blob([mp4Bytes], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      outputs.push({ name, blob, url, alias, bytes: mp4Bytes.length });
      const row = document.createElement('div');
      row.className = 'output-row';
      row.innerHTML = `<div><strong>${alias.platformName}</strong> · ${alias.placementLabel}<div class="muted">${name} · ${alias.width}×${alias.height} · ${formatBytes(mp4Bytes.length)}</div></div>`;
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.textContent = 'Download';
      a.className = 'btn';
      row.appendChild(a);
      host.appendChild(row);
    }
  }
  return outputs;
}

let lastOutputs = [];
el('saveOutputsBtn').addEventListener('click', async () => {
  if (!lastOutputs.length) return;
  const status = el('saveOutputsStatus');
  if (!window.showDirectoryPicker) {
    status.textContent = 'Folder picker needs Chrome/Edge.';
    return;
  }
  try {
    const root = await window.showDirectoryPicker();
    const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
    const dir = await root.getDirectoryHandle(stamp, { create: true });
    for (const out of lastOutputs) {
      const handle = await dir.getFileHandle(out.name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(out.blob);
      await writable.close();
    }
    status.textContent = `Saved ${lastOutputs.length} file(s) to ${stamp}/`;
    log(status.textContent);
  } catch (err) {
    if (err.name === 'AbortError') status.textContent = 'Save cancelled.';
    else status.textContent = `Save failed: ${err.message}`;
  }
});

// ---- Main run ----
let runInProgress = false;
el('runBtn').addEventListener('click', async () => {
  if (runInProgress) return;
  if (!validateApiKeyField()) {
    showRunError(new Error('Invalid DCP identity API key format.'));
    return;
  }
  const deliverables = selectedDeliverables();
  if (!inputBytes || !deliverables.length) return;

  runInProgress = true;
  hideRunError();
  hideNofunds();
  el('runBtn').disabled = true;
  el('outputsSection').classList.add('hidden');
  el('fleetBar').style.width = '0%';
  try {
    const uniqueFormats = dedupeFormats(deliverables);
    el('statUnique').textContent = String(uniqueFormats.length);
    el('statAliases').textContent = String(deliverables.length);
    el('preprocessingStatus').classList.remove('hidden');
    el('preprocessingStatus').textContent = 'Slicing WebM at keyframes…';
    const targetFrames = CONFIG.dispatch?.target_chunk_frames || 90;
    log('Slicing browser recording (client-side WASM)…');
    const { chunks, durations, fps, container, slicer } = await sliceVideo(inputBytes, targetFrames);
    log(`Sliced into ${chunks.length} chunk(s) via ${slicer || 'slice'} → .${container || '?'} , fps=${(fps || 0).toFixed?.(2) ?? fps}`);
    dbg('slice summary', {
      chunkBytes: chunks.map((c) => c.length),
      durations,
      fps,
      container,
      slicer,
      inputBytes: inputBytes.length,
    });
    if (Array.isArray(durations) && durations.length) {
      inputDurationSec = durations.reduce((a, b) => a + b, 0);
    }
    const maxDistribution = el('maxDistributionToggle').checked;
    updateCostEstimate(maxDistribution ? chunks.length * uniqueFormats.length : chunks.length);
    el('preprocessingStatus').textContent = 'Dispatching to DCP…';

    const { bySignature } = await dispatchJob(
      chunks, uniqueFormats, durations, maxDistribution, inputBaseName, container,
    );
    el('preprocessingStatus').textContent = 'Assembling MP4 masters…';
    lastOutputs = await assembleMasters(bySignature, uniqueFormats, durations, deliverables);
    el('saveOutputsBtn').classList.toggle('hidden', !lastOutputs.length || !window.showDirectoryPicker);
    el('preprocessingStatus').textContent = `Done — ${lastOutputs.length} deliverable(s).`;
    log(`Produced ${lastOutputs.length} MP4 deliverable(s).`);
  } catch (err) {
    log(`Run failed: ${err.message || err}`);
    showRunError(err);
  } finally {
    runInProgress = false;
    updateSelectionSummary();
  }
});

log(`Config loaded: ${platformEntries().length} platforms, package ${CONFIG.dcp_package}`);
el('maxDistributionToggle').addEventListener('change', () => {
  clearExactCostBasis();
  updateCostEstimate();
});
el('refreshBalanceBtn').addEventListener('click', () => fetchAccountBalance());
updateCostEstimate();
