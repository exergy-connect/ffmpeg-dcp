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
el('accountForm').addEventListener('submit', (e) => e.preventDefault());
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
function platformEntries() {
  return Object.entries(CONFIG.platforms || {}).map(([key, p]) => ({ key, ...p }));
}

function formatOf(placement) {
  const f = placement.format;
  if (f && typeof f === 'object' && f.width) return f;
  // Unresolved Jinja leave-behind: look up by placement id in formats
  const formats = CONFIG.formats || {};
  for (const v of Object.values(formats)) {
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
    for (const [pkey, placement] of Object.entries(placements)) {
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
  const fps = CONFIG.timing?.output_fps || CONFIG.timing?.target_fps || 30;
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
    const bankTeller = new protocol.Connection(window.dcpConfig.bank.services.bankTeller);
    try {
      const req = new bankTeller.Request('viewAccounts', {
        addresses: [pay.address],
      });
      // authorize() expects a Keystore (or PrivateKey), not an Address.
      await req.authorize(pay);
      const res = await req.send();
      if (!res?.success) {
        const detail = res?.payload?.message || res?.payload?.code || JSON.stringify(res?.payload || res);
        throw new Error(detail || 'Bank balance request failed');
      }
      const raw = res.payload?.accounts?.[0]?.balance;
      let balance;
      if (raw == null) balance = NaN;
      else if (typeof raw === 'number') balance = raw;
      else if (typeof raw === 'string') balance = Number(raw);
      else if (typeof raw.toNumber === 'function') balance = raw.toNumber();
      else balance = Number(String(raw));
      lastKnownBalanceDcc = balance;
      balEl.textContent = formatCredits(balance);
      updateCostEstimate();
    } finally {
      bankTeller.close();
    }
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
el('framingSelect').value = CONFIG.defaultFraming || 'cover';

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
const ffmpegWorker = new Worker(assetUrl(CONFIG.workerScript || 'ffmpeg-worker.js'));
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

async function dispatchJob(chunks, uniqueFormats, durations, maxDistribution, inputBaseName) {
  const { compute, wallet } = window.dcp;
  await ensureIdentity();
  const pay = await wallet.get();
  await wallet.add(pay);
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

  const prepWorker = new Worker(assetUrl(CONFIG.deployWorkerScript || 'dcp-deploy-worker.js'));
  const inputSet = await new Promise((resolve, reject) => {
    prepWorker.onmessage = ({ data }) => resolve(data.inputSet);
    prepWorker.onerror = (err) => reject(new Error(`prep worker failed: ${err.message || 'script error'}`));
    prepWorker.postMessage({
      cmd: 'prepare',
      chunks,
      formatCount: uniqueFormats.length,
      maxDistribution,
    });
  });
  prepWorker.terminate();

  async function workFunction(unit, formatsMetaJsonArg) {
    progress();
    const formatsMetaArg = JSON.parse(formatsMetaJsonArg);
    const { createFfmpegModule } = require('ffmpeg-wasm.js');
    const Module = await createFfmpegModule();

    const chunkBytes = Uint8Array.from(atob(unit.chunkBase64), (c) => c.charCodeAt(0));
    const inPath = '/chunk-in.webm';
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
      if (code < 0) {
        throw new Error(`transcode_social_segment failed (${code}) for ${fmt.signature}`);
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
    }
    Module.FS.unlink(inPath);
    return { chunkIndex: unit.chunkIndex, segments: results };
  }

  const t0 = performance.now();
  const timer = setInterval(() => {
    el('fleetTime').textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);

  let completed = 0;
  const bySignature = {};
  for (const f of uniqueFormats) bySignature[f.signature] = new Array(chunks.length).fill(null);

  setupGrid(inputSet.length);
  el('statCompleted').textContent = `0 / ${totalUnits}`;

  const job = compute.for(inputSet, workFunction, [formatsMetaJson]);
  job.requires([CONFIG.dcpPackage || 'ffmpeg-wasm-social/ffmpeg-wasm.js']);
  job.computeGroups = getComputeGroups();
  job.public = {
    name: `🎞️ Social transcoder: ${inputBaseName}`,
    description: 'Browser WebM → social H.264/AAC masters via DCP',
  };
  job.greedyEstimation = true;
  job.estimationSlices = inputSet.length;

  let unitIndex = 0;
  job.on('readyStateChange', (state) => { el('readyStateBadge').textContent = state; });
  job.on('error', (err) => log(`Job error: ${err.message || err}`));
  job.on('nofunds', (ev) => {
    log(`Nofunds: ${JSON.stringify(ev)}`);
    showNofunds(ev);
    showRunError(new Error(
      `Insufficient DCP funds: need ${ev?.fundsRequired ?? '?'} ${CREDIT_SYMBOL} ` +
      `for ${ev?.remainingSlices ?? '?'} remaining slice(s).`,
    ));
  });
  job.on('result', (ev) => {
    const { chunkIndex, segments } = ev.result;
    for (const seg of segments) {
      bySignature[seg.signature][chunkIndex] = seg.segmentBase64;
      completed += 1;
    }
    const cell = gridCells[unitIndex++];
    if (cell) cell.classList.add('done');
    el('fleetBar').style.width = `${(completed / totalUnits) * 100}%`;
    el('statCompleted').textContent = `${completed} / ${totalUnits}`;
  });

  log(`Dispatching ${inputSet.length} slice(s), ${totalUnits} format-units (${chunks.length} chunks × ${uniqueFormats.length} unique formats)…`);
  updateCostEstimate(inputSet.length);
  await job.exec(slicePaymentDcc);
  clearInterval(timer);
  const elapsedSec = (performance.now() - t0) / 1000;
  el('fleetTime').textContent = `${elapsedSec.toFixed(1)}s`;
  log(`Job done in ${elapsedSec.toFixed(1)}s`);
  fetchAccountBalance().catch(() => {});
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
    if (Array.isArray(durations) && durations.length) {
      inputDurationSec = durations.reduce((a, b) => a + b, 0);
    }
    const maxDistribution = el('maxDistributionToggle').checked;
    updateCostEstimate(maxDistribution ? chunks.length * uniqueFormats.length : chunks.length);
    el('preprocessingStatus').textContent = 'Dispatching to DCP…';

    const { bySignature } = await dispatchJob(chunks, uniqueFormats, durations, maxDistribution, inputBaseName);
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

log(`Config loaded: ${platformEntries().length} platforms, package ${CONFIG.dcpPackage}`);
el('maxDistributionToggle').addEventListener('change', () => {
  clearExactCostBasis();
  updateCostEstimate();
});
el('refreshBalanceBtn').addEventListener('click', () => fetchAccountBalance());
updateCostEstimate();
