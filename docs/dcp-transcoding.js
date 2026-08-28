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
          if (String(line).includes('[social-progress]')) return;
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
  } else if (/fetchModuleURL|Could not locate module|package\.dcp|ffmpeg-dcp-social|\/packages\/src\//i.test(message)) {
    remedy = 'Publish the DCP package (cd xframe && node package/build-bravojs-bundle.js && node package/publish.js). If you still see /packages/src/, hard-refresh the worker — bare requires were resolving against the sandbox evaluator path.';
  } else if (/extract_time_range|director.?s cut|needsTrim/i.test(message)) {
    remedy =
      'Director’s-cut boundary trim needs extract_time_range in the DCP package WASM. ' +
      'Rebuild (cd xframe && bash ffmpeg-wasm/build.sh), set a new package/package.dcp name, and republish.';
  } else if (/slice_webm|Only VP8 or VP9|MediaRecorder|\.webm/i.test(message)) {
    remedy = 'Drop a MediaRecorder .webm (VP8/VP9) or an .mp4 (VP9 or H.264). Hard-refresh if a stale worker is still slicing MP4 into MPEG-TS.';
  } else if (/vp8|vp9|opus|decoder|wasm/i.test(message)) {
    remedy = 'Rebuild the xframe WASM package (see xframe/README.md) and publish the package named in package/package.dcp.';
  } else if (/GitHub API 403|not accessible by personal access token|Contents write/i.test(message)) {
    remedy =
      'The PAT cannot write repository contents. Classic token: enable repo scope (workflow alone is insufficient). ' +
      'Fine-grained token: Contents Read and write + Actions Read and write on the target repo; authorize SSO for exergy-connect if required. ' +
      'Then clear the cached token in the dialog and paste a new one.';
  } else if (/GitHub API|GitHub runner|JIT listener|workflow|dcpGhRunner|dcp-gh-runner/i.test(message)) {
    remedy =
      'Check the GitHub token (repo + workflow scopes) and repository access. ' +
      'The slice lists dcp-gh-runner/dcpGhRunner.js via job.requires (no separate publish step). ' +
      'Workers also need ffmpeg-dcp-social-v2/ffmpeg-wasm.js from job.requires.';
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
const API_KEY_STORAGE_KEY = 'xframe-social:apiKey';
const COMPUTE_GROUPS_STORAGE_KEY = 'xframe-social:computeGroups';
const DIRECTORS_CUT_STORAGE_PREFIX = 'xframe-social:directorsCut:';
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
for (const formId of ['identityForm', 'computeGroupsForm', 'accountForm']) {
  const form = document.getElementById(formId);
  if (form) form.addEventListener('submit', (e) => e.preventDefault());
}
validateApiKeyField(false);

function getApiKey() {
  return apiKeyInput.value.trim();
}

function hasValidApiKey() {
  return API_KEY_PATTERN.test(getApiKey());
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
  keyInput.name = 'dcp-join-key';
  keyInput.placeholder = 'joinKey (blank = public)';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.value = joinKey || '';
  const secretInput = document.createElement('input');
  // type=text + CSS disc mask: avoids Chrome password-form heuristics on join secrets.
  secretInput.type = 'text';
  secretInput.className = 'join-secret';
  secretInput.name = 'dcp-join-secret';
  secretInput.placeholder = 'joinSecret (optional)';
  secretInput.autocomplete = 'off';
  secretInput.spellcheck = false;
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

// qrcodejs CorrectLevel.H overflows for ~192–217 char payloads (known lib bug).
const qrcode = new QRCode(el('qrcode'), {
  width: 112,
  height: 112,
  correctLevel: QRCode.CorrectLevel.L,
});
const qrcodeLink = el('qrcodeLink');
const PUBLIC_WORKER_URL = (CONFIG.worker_invite && CONFIG.worker_invite.url)
  || 'https://exergy-connect.github.io/ffmpeg-dcp/worker.html';
let nextDemoCommentIndex = 1;

function updateQrCode() {
  const groups = getComputeGroups();
  let href = PUBLIC_WORKER_URL;
  if (!(groups.length === 1 && groups[0].joinKey === 'public')) {
    const invite = new URL(PUBLIC_WORKER_URL);
    invite.searchParams.set('computeGroups', JSON.stringify(groups));
    href = invite.href;
  }
  qrcodeLink.href = href;
  try {
    qrcode.makeCode(href);
  } catch (err) {
    console.warn('Worker invite QR code skipped:', err?.message || err);
    qrcode.clear();
  }
}
updateQrCode();
qrcodeLink.addEventListener('click', () => {
  const invite = new URL(qrcodeLink.href);
  invite.searchParams.set('demoCommentIndex', String(nextDemoCommentIndex));
  qrcodeLink.href = invite.href;
  nextDemoCommentIndex += 1;
});

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

function sourceIdForFormat(format) {
  return verticalInputBytes && format.height > format.width ? 'vertical' : 'primary';
}

function groupFormatsBySource(formats) {
  const groups = { primary: [], vertical: [] };
  for (const format of formats) groups[sourceIdForFormat(format)].push(format);
  return groups;
}

function updateSelectionSummary() {
  const selected = selectedDeliverables();
  const unique = dedupeFormats(selected);
  const aliasExtra = selected.length - unique.length;
  const sourceGroups = groupFormatsBySource(unique);
  const sourceNote = verticalInputBytes && unique.length
    ? ` · ${sourceGroups.primary.length} horizontal-source / ${sourceGroups.vertical.length} vertical-source encode(s)`
    : '';
  el('selectionSummary').textContent = selected.length
    ? `${selected.length} placement(s) → ${unique.length} unique encode(s)` +
      (aliasExtra > 0 ? ` (${aliasExtra} shared via identical signatures)` : '') +
      sourceNote
    : 'No placements selected.';
  el('statUnique').textContent = String(unique.length);
  el('statAliases').textContent = String(selected.length);
  el('runBtn').disabled = !inputBytes || selected.length === 0;
  const runGithubBtn = el('runGithubBtn');
  if (runGithubBtn) runGithubBtn.disabled = !inputBytes || runInProgress;
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

function sourceChunkEstimate(sourceId) {
  const sourceDuration = sourceId === 'vertical'
    ? (verticalSourceDurationSec || verticalInputDurationSec)
    : (inputSourceDurationSec || inputDurationSec);
  const duration = programmedDurationForSource(sourceId, sourceDuration);
  const bytes = sourceId === 'vertical' ? verticalInputBytes : inputBytes;
  const fromDuration = estimateChunkCount(duration);
  if (fromDuration != null) return { chunks: fromDuration, source: 'duration' };
  if (bytes?.length) {
    const fromBytes = estimateChunkCountFromBytes(bytes.length);
    if (fromBytes != null) return { chunks: fromBytes, source: 'size' };
  }
  return { chunks: null, source: 'none' };
}

function estimatedSlicesForFormats(formats) {
  const groups = groupFormatsBySource(formats);
  let slices = 0;
  const details = [];
  for (const sourceId of ['primary', 'vertical']) {
    const sourceFormats = groups[sourceId];
    if (!sourceFormats.length) continue;
    const chunkInfo = sourceChunkEstimate(sourceId);
    if (chunkInfo.chunks == null) return { slices: null, details };
    const sourceSlices = estimateSliceCount(sourceFormats.length, chunkInfo.chunks);
    slices += sourceSlices;
    details.push(`${sourceId} ~${chunkInfo.chunks} chunk(s) × ${sourceFormats.length} format(s)`);
  }
  return { slices, details };
}

function updateCostEstimate(exactSliceCount = null) {
  if (exactSliceCount != null) lastExactSliceCount = exactSliceCount;
  const selected = selectedDeliverables();
  const unique = dedupeFormats(selected);
  const estimate = estimatedSlicesForFormats(unique);
  const slices = lastExactSliceCount != null
    ? lastExactSliceCount
    : estimate.slices;

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
    : `~${slices} slice(s) (${estimate.details.join('; ')}` +
      `${el('maxDistributionToggle').checked ? '' : ', bundled by source'})`;
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
  if (!hasValidApiKey()) {
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
let inputFileName = null;
let verticalInputBytes = null;
let verticalInputDurationSec = null;
/** Immutable source durations used by the director’s-cut editor. */
let inputSourceDurationSec = null;
let verticalSourceDurationSec = null;
let mediaRecorder = null;
let recordChunks = [];
let recordStream = null;

/** Ordered director's-cut slices for the loaded primary filename. */
let directorsCutSlices = [];
let cutDraftSlices = [];
let previewCutIndex = 0;
let previewSeeking = false;

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

async function readVideoMetadata(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let settled = false;
    const finish = (duration) => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(v.src); } catch { /* ignore */ }
      resolve({
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        width: v.videoWidth || null,
        height: v.videoHeight || null,
      });
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

const CONTAINER_EXT_RE = /\.(mp4|webm|mkv|mov|m4v|ts|m2ts|avi|ogv)$/i;
const SOURCE_CODEC_SUFFIX_RE = /(?:[._-](?:vp8|vp9|vp09|av1|avc1|h263|h264|h265|hevc|hev1|hvc1|mpeg2|mpeg4|theora|prores|dnxhd|cfhd|opus|vorbis|aac|mp3|flac|pcm|ac3|eac3|truehd))+$/i;

function outputStemFromFileName(name) {
  const base = String(name || '').replace(/^.*[/\\]/, '');
  const withoutContainer = base.replace(CONTAINER_EXT_RE, '');
  const withoutCodec = withoutContainer.replace(SOURCE_CODEC_SUFFIX_RE, '');
  return withoutCodec.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'recording';
}

function formatTimecode(sec) {
  if (!(sec >= 0) || !Number.isFinite(sec)) return '—';
  const total = Math.max(0, sec);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function cloneSlices(slices) {
  return (slices || []).map((slice) => ({
    start: Number(slice.start),
    end: Number(slice.end),
  }));
}

function normalizeSlices(rawSlices, durationSec) {
  const duration = Number(durationSec);
  if (!(duration > 0)) return [];
  const cleaned = [];
  for (const raw of rawSlices || []) {
    let start = Number(raw?.start);
    let end = Number(raw?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, Math.min(duration, start));
    end = Math.max(0, Math.min(duration, end));
    if (end - start < 0.05) continue;
    cleaned.push({ start, end });
  }
  return cleaned;
}

function defaultFullSlice(durationSec) {
  const duration = Number(durationSec);
  if (!(duration > 0)) return [];
  return [{ start: 0, end: duration }];
}

function isFullProgram(slices, durationSec) {
  const normalized = normalizeSlices(slices, durationSec);
  if (normalized.length !== 1) return false;
  return normalized[0].start <= 0.001 && Math.abs(normalized[0].end - durationSec) <= 0.05;
}

function programDuration(slices) {
  return (slices || []).reduce((sum, slice) => sum + Math.max(0, slice.end - slice.start), 0);
}

/**
 * Build a [start, end) timeline for keyframe chunks from slicer durations.
 * Used to decide which source chunks overlap the director’s cut; trim offsets
 * sent to extract_time_range are chunk-relative (see mapDirectorsCutToProgram).
 */
function buildChunkTimeline(durations, sourceDurationSec) {
  const sourceDuration = Number(sourceDurationSec);
  const raw = (durations || []).map((d) => Math.max(0, Number(d) || 0));
  if (!raw.length) {
    const end = sourceDuration > 0 ? sourceDuration : 0;
    return { starts: [0], ends: [end], durations: [end] };
  }
  if (raw.length === 1 && !(raw[0] > 0) && sourceDuration > 0) {
    return { starts: [0], ends: [sourceDuration], durations: [sourceDuration] };
  }
  const starts = [];
  let t = 0;
  for (let i = 0; i < raw.length; i++) {
    starts.push(t);
    t += raw[i];
  }
  const ends = raw.map((d, i) => starts[i] + d);
  const sum = ends.length ? ends[ends.length - 1] : 0;
  if (sourceDuration > 0 && sum > 0 && Math.abs(sum - sourceDuration) > 0.25) {
    ends[ends.length - 1] = Math.max(starts[starts.length - 1] + 0.05, sourceDuration);
  } else if (sourceDuration > 0 && !(sum > 0)) {
    const each = sourceDuration / raw.length;
    for (let i = 0; i < raw.length; i++) {
      starts[i] = i * each;
      ends[i] = (i + 1) * each;
    }
  }
  return {
    starts,
    ends,
    durations: ends.map((end, i) => Math.max(0, end - starts[i])),
  };
}

/**
 * Map an ordered director’s-cut program onto keyframe chunks.
 * Dropped ranges never become DCP units; boundary overlaps set needsTrim.
 * trimStartSec/trimEndSec are relative to the chunk file (extract_time_range
 * subtracts stream start_time, so absolute source times would miss all frames).
 */
function mapDirectorsCutToProgram(slices, durations, sourceDurationSec) {
  const timeline = buildChunkTimeline(durations, sourceDurationSec);
  const chunkCount = timeline.starts.length;
  if (!slices || !slices.length) {
    return timeline.starts.map((_, chunkIndex) => ({
      programIndex: chunkIndex,
      chunkIndex,
      trimStartSec: 0,
      trimEndSec: timeline.durations[chunkIndex],
      needsTrim: false,
      durationSec: timeline.durations[chunkIndex],
    }));
  }
  const segments = [];
  let programIndex = 0;
  for (const slice of slices) {
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const chunkStart = timeline.starts[chunkIndex];
      const chunkEnd = timeline.ends[chunkIndex];
      const overlapStart = Math.max(slice.start, chunkStart);
      const overlapEnd = Math.min(slice.end, chunkEnd);
      if (!(overlapEnd - overlapStart >= 0.05)) continue;
      const needsTrim =
        overlapStart - chunkStart > 0.05 || chunkEnd - overlapEnd > 0.05;
      segments.push({
        programIndex,
        chunkIndex,
        trimStartSec: overlapStart - chunkStart,
        trimEndSec: overlapEnd - chunkStart,
        needsTrim,
        durationSec: overlapEnd - overlapStart,
      });
      programIndex += 1;
    }
  }
  return segments;
}

function programmedDurationForSource(sourceId, sourceDuration) {
  const duration = Number(sourceDuration);
  if (!(duration > 0)) return duration;
  const sourceBasis = sourceId === 'vertical'
    ? (verticalSourceDurationSec || duration)
    : (inputSourceDurationSec || duration);
  if (!directorsCutSlices.length || isFullProgram(directorsCutSlices, sourceBasis)) {
    return duration;
  }
  const clamped = normalizeSlices(directorsCutSlices, duration);
  return programDuration(clamped) || duration;
}

function directorsCutStorageKey(fileName) {
  return `${DIRECTORS_CUT_STORAGE_PREFIX}${fileName || ''}`;
}

function loadStoredDirectorsCut(fileName, durationSec) {
  if (!fileName) return defaultFullSlice(durationSec);
  try {
    const raw = localStorage.getItem(directorsCutStorageKey(fileName));
    if (!raw) return defaultFullSlice(durationSec);
    const parsed = JSON.parse(raw);
    const slices = normalizeSlices(parsed?.slices || parsed, durationSec);
    return slices.length ? slices : defaultFullSlice(durationSec);
  } catch {
    return defaultFullSlice(durationSec);
  }
}

function saveDirectorsCut(fileName, slices, durationSec) {
  if (!fileName) return;
  const normalized = normalizeSlices(slices, durationSec);
  const payload = {
    fileName,
    durationSec: Number(durationSec) || null,
    slices: normalized.length ? normalized : defaultFullSlice(durationSec),
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(directorsCutStorageKey(fileName), JSON.stringify(payload));
  directorsCutSlices = payload.slices;
}

function updateCutSummary() {
  const summary = el('cutSummary');
  const btn = el('stageCutBtn');
  if (!summary || !btn) return;
  const basis = inputSourceDurationSec || inputDurationSec;
  if (!inputBytes || !(basis > 0)) {
    summary.textContent = '';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  const slices = directorsCutSlices.length
    ? directorsCutSlices
    : defaultFullSlice(basis);
  const total = programDuration(slices);
  if (isFullProgram(slices, basis)) {
    summary.innerHTML = `Program: <strong>full video</strong> (${formatTimecode(total)})`;
  } else {
    summary.innerHTML =
      `Program: <strong>${slices.length} slice${slices.length === 1 ? '' : 's'}</strong>` +
      ` · ${formatTimecode(total)} staged`;
  }
}

function setCutDialogError(message) {
  const err = el('cutDialogError');
  if (err) err.textContent = message || '';
}

function renderCutDraft() {
  const host = el('cutSliceList');
  const meta = el('cutDialogMeta');
  if (!host) return;
  host.innerHTML = '';
  const duration = inputSourceDurationSec || inputDurationSec || 0;
  if (meta) {
    meta.textContent = duration > 0
      ? `Source ${formatTimecode(duration)} · draft ${formatTimecode(programDuration(cutDraftSlices))}`
      : 'Load a primary video to stage a cut.';
  }
  cutDraftSlices.forEach((slice, index) => {
    const card = document.createElement('div');
    card.className = 'cut-slice';
    const head = document.createElement('div');
    head.className = 'cut-slice-head';
    const title = document.createElement('strong');
    title.textContent = `Slice ${index + 1}`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.disabled = cutDraftSlices.length <= 1;
    removeBtn.addEventListener('click', () => {
      if (cutDraftSlices.length <= 1) return;
      cutDraftSlices.splice(index, 1);
      renderCutDraft();
    });
    head.append(title, removeBtn);

    const range = document.createElement('div');
    range.className = 'cut-range';

    const makeSlider = (kind, value) => {
      const label = document.createElement('label');
      const caption = document.createElement('span');
      caption.textContent = kind === 'start' ? 'Start' : 'End';
      const valueEl = document.createElement('span');
      valueEl.textContent = formatTimecode(value);
      label.append(caption, valueEl);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = String(duration || 0);
      input.step = '0.01';
      input.value = String(value);
      input.addEventListener('input', () => {
        const next = Number(input.value);
        if (kind === 'start') {
          slice.start = Math.min(next, slice.end - 0.05);
          input.value = String(slice.start);
        } else {
          slice.end = Math.max(next, slice.start + 0.05);
          input.value = String(slice.end);
        }
        valueEl.textContent = formatTimecode(kind === 'start' ? slice.start : slice.end);
        if (meta) {
          meta.textContent =
            `Source ${formatTimecode(duration)} · draft ${formatTimecode(programDuration(cutDraftSlices))}`;
        }
        setCutDialogError('');
      });
      range.append(label, input);
    };

    makeSlider('start', slice.start);
    makeSlider('end', slice.end);
    card.append(head, range);
    host.appendChild(card);
  });
}

function openCutDialog() {
  const basis = inputSourceDurationSec || inputDurationSec;
  if (!(basis > 0)) {
    log('Load a primary video before staging a director’s cut.');
    return;
  }
  cutDraftSlices = cloneSlices(
    directorsCutSlices.length ? directorsCutSlices : defaultFullSlice(basis),
  );
  setCutDialogError('');
  renderCutDraft();
  const dialog = el('cutDialog');
  if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
}

function closeCutDialog() {
  const dialog = el('cutDialog');
  if (dialog?.open) dialog.close();
}

function activePreviewSlice(timeSec) {
  const basis = inputSourceDurationSec || inputDurationSec;
  const slices = directorsCutSlices.length
    ? directorsCutSlices
    : defaultFullSlice(basis);
  if (!slices.length) return { index: -1, slice: null };
  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    if (timeSec >= slice.start - 0.04 && timeSec < slice.end - 0.02) {
      return { index: i, slice };
    }
  }
  return { index: -1, slice: null };
}

function seekPreviewToSlice(index) {
  const preview = el('preview');
  const basis = inputSourceDurationSec || inputDurationSec;
  const slices = directorsCutSlices.length
    ? directorsCutSlices
    : defaultFullSlice(basis);
  if (!preview || !slices[index]) return;
  previewCutIndex = index;
  previewSeeking = true;
  try {
    preview.currentTime = slices[index].start;
  } catch { /* ignore */ }
  const clear = () => {
    previewSeeking = false;
    preview.removeEventListener('seeked', clear);
  };
  preview.addEventListener('seeked', clear);
}

function wirePreviewDirectorCut() {
  const preview = el('preview');
  if (!preview || preview.dataset.cutWired === '1') return;
  preview.dataset.cutWired = '1';

  const programSlices = () => {
    const basis = inputSourceDurationSec || inputDurationSec;
    const slices = directorsCutSlices.length
      ? directorsCutSlices
      : defaultFullSlice(basis);
    return { slices, basis };
  };

  preview.addEventListener('play', () => {
    if (previewSeeking) return;
    const { slices, basis } = programSlices();
    if (!slices.length || isFullProgram(slices, basis)) return;
    const hit = activePreviewSlice(preview.currentTime || 0);
    if (hit.index >= 0) {
      previewCutIndex = hit.index;
      return;
    }
    seekPreviewToSlice(0);
  });

  preview.addEventListener('timeupdate', () => {
    if (previewSeeking || preview.paused) return;
    const { slices, basis } = programSlices();
    if (!slices.length || isFullProgram(slices, basis)) return;
    const slice = slices[previewCutIndex] || slices[0];
    if (!slice) return;
    if (preview.currentTime < slice.start - 0.05) {
      seekPreviewToSlice(previewCutIndex);
      return;
    }
    if (preview.currentTime >= slice.end - 0.02) {
      const next = previewCutIndex + 1;
      if (next < slices.length) {
        seekPreviewToSlice(next);
        const play = preview.play();
        if (play && typeof play.catch === 'function') play.catch(() => {});
      } else {
        preview.pause();
        previewCutIndex = 0;
      }
    }
  });

  preview.addEventListener('seeking', () => {
    if (previewSeeking) return;
    const { slices, basis } = programSlices();
    if (!slices.length || isFullProgram(slices, basis)) return;
    const hit = activePreviewSlice(preview.currentTime || 0);
    if (hit.index >= 0) {
      previewCutIndex = hit.index;
      return;
    }
    let best = 0;
    let bestDist = Infinity;
    slices.forEach((slice, index) => {
      const dist = Math.abs(slice.start - preview.currentTime);
      if (dist < bestDist) {
        bestDist = dist;
        best = index;
      }
    });
    seekPreviewToSlice(best);
  });

  preview.addEventListener('ended', () => {
    previewCutIndex = 0;
  });
}

async function handleFile(file, sourceId = 'primary') {
  const isVertical = sourceId === 'vertical';
  const sizeStr = formatBytes(file.size);
  const loadedEl = el(isVertical ? 'verticalInputLoaded' : 'inputLoaded');
  const infoEl = el(isVertical ? 'verticalFileInfo' : 'fileInfo');
  const previewEl = el(isVertical ? 'verticalPreview' : 'preview');
  loadedEl.classList.remove('hidden');
  infoEl.textContent = `${file.name} — ${sizeStr} (${file.type || 'unknown'})`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const url = URL.createObjectURL(file);
  previewEl.src = url;
  const metadata = await readVideoMetadata(URL.createObjectURL(file));
  const orientation = metadata.width && metadata.height
    ? (metadata.height > metadata.width ? 'vertical' : 'horizontal')
    : 'unknown orientation';
  infoEl.textContent =
    `${file.name} — ${sizeStr} · ${metadata.width || '?'}×${metadata.height || '?'} · ${orientation}`;
  if (isVertical) {
    verticalInputBytes = bytes;
    verticalInputDurationSec = metadata.duration;
    verticalSourceDurationSec = metadata.duration;
  } else {
    inputBaseName = outputStemFromFileName(file.name);
    inputFileName = file.name;
    inputBytes = bytes;
    inputDurationSec = metadata.duration;
    inputSourceDurationSec = metadata.duration;
    directorsCutSlices = loadStoredDirectorsCut(inputFileName, inputSourceDurationSec);
    previewCutIndex = 0;
    wirePreviewDirectorCut();
    updateCutSummary();
  }
  const expected = isVertical ? 'vertical' : 'horizontal';
  const orientationWarning = orientation !== 'unknown orientation' && orientation !== expected
    ? ` Warning: this ${orientation} video is in the ${expected} slot.`
    : '';
  log(
    `Loaded ${sourceId} source ${file.name} (${(file.size / 1024).toFixed(0)} KB` +
    `${metadata.duration != null ? `, ${metadata.duration.toFixed(1)}s` : ''}).${orientationWarning}`,
  );
  updateSelectionSummary();
}

function wireDropzone(dropzoneId, fileInputId, sourceId) {
  const dropzone = el(dropzoneId);
  const fileInput = el(fileInputId);
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file, sourceId);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0], sourceId);
  });
}

wireDropzone('dropzone', 'fileInput', 'primary');
wireDropzone('verticalDropzone', 'verticalFileInput', 'vertical');
el('clearVerticalBtn').addEventListener('click', () => {
  verticalInputBytes = null;
  verticalInputDurationSec = null;
  verticalSourceDurationSec = null;
  el('verticalFileInput').value = '';
  el('verticalPreview').removeAttribute('src');
  el('verticalPreview').load();
  el('verticalInputLoaded').classList.add('hidden');
  log('Removed vertical source; the primary source will be used for every placement.');
  updateSelectionSummary();
});

el('stageCutBtn')?.addEventListener('click', () => openCutDialog());
el('cutAddSliceBtn')?.addEventListener('click', () => {
  const duration = inputSourceDurationSec || inputDurationSec || 0;
  if (!(duration > 0)) return;
  const last = cutDraftSlices[cutDraftSlices.length - 1];
  const start = last ? Math.min(duration, last.end) : 0;
  const end = Math.min(duration, start + Math.max(1, duration * 0.15));
  if (end - start < 0.05) {
    setCutDialogError('No room left for another slice on this timeline.');
    return;
  }
  cutDraftSlices.push({ start, end });
  setCutDialogError('');
  renderCutDraft();
});
el('cutResetBtn')?.addEventListener('click', () => {
  cutDraftSlices = defaultFullSlice(inputSourceDurationSec || inputDurationSec);
  setCutDialogError('');
  renderCutDraft();
});
el('cutCancelBtn')?.addEventListener('click', () => closeCutDialog());
el('cutSaveBtn')?.addEventListener('click', () => {
  const basis = inputSourceDurationSec || inputDurationSec;
  const normalized = normalizeSlices(cutDraftSlices, basis);
  if (!normalized.length) {
    setCutDialogError('Add at least one valid slice (end must be after start).');
    return;
  }
  saveDirectorsCut(inputFileName, normalized, basis);
  previewCutIndex = 0;
  updateCutSummary();
  clearExactCostBasis();
  updateCostEstimate();
  updateSelectionSummary();
  closeCutDialog();
  log(
    `Saved director’s cut for ${inputFileName}: ${normalized.length} slice(s), ` +
    `${programDuration(normalized).toFixed(2)}s programmed.`,
  );
});
el('cutDialog')?.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeCutDialog();
});
updateCutSummary();

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
      await handleFile(new File([blob], `browser-recording-${Date.now()}.webm`, { type: blob.type }), 'primary');
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
const spokenCommentKeys = new Set();
const commentSpeechQueue = [];
let commentSpeechActive = false;
let currentCommentAudio = null;
let commentSpeechGeneration = 0;
let commentAutoplayOpen = true;
/** Grid cell whose comment is playing from a manual click (toggle-to-stop). */
let activeManualCommentCell = null;
const playedDemoAudioLocales = new Set();
const DEMO_COMMENT_AUDIO_BASE =
  String(CONFIG.worker_invite?.demo_audio_base || 'crazyOnes/audio/gemini').replace(/\/+$/, '');
const DEMO_COMMENT_AUDIO_SLIDES = Array.isArray(CONFIG.worker_invite?.demo_audio_slides)
  ? CONFIG.worker_invite.demo_audio_slides.map(String)
  : ['non-conformists', 'impact', 'visionaries', 'the-ones-who-do'];
const DEMO_COMMENT_AUDIO_LOCALES = Array.isArray(CONFIG.worker_invite?.demo_audio_locales)
  ? CONFIG.worker_invite.demo_audio_locales.map(String)
  : ['en-US', 'fr-FR', 'es-ES', 'de-DE', 'nl-NL'];
const AUDIENCE = CONFIG.audience || {};
const AUDIENCE_EVERY_NTH = Math.max(1, Number(AUDIENCE.every_nth_segment) || 4);
const AUDIENCE_AUDIO_BASE =
  String(AUDIENCE.audio_base || 'demoMessages/audio/gemini').replace(/\/+$/, '');
const AUDIENCE_MESSAGES = (Array.isArray(AUDIENCE.messages) ? AUDIENCE.messages : [])
  .map((msg) => {
    const quotes = {};
    for (const entry of msg.quotes || []) {
      const language = String(entry.language || '').trim();
      const text = String(entry.text || '').replace(/\s+/g, ' ').trim();
      if (language && text) quotes[language] = text;
    }
    return {
      id: String(msg.id || '').trim(),
      title: String(msg.title || '').trim(),
      quotes,
    };
  })
  .filter((msg) => msg.id && Object.keys(msg.quotes).length);
const AUDIENCE_MESSAGES_BY_ID = new Map(AUDIENCE_MESSAGES.map((msg) => [msg.id, msg]));
/** Remaining catalog ids for this job; consumed without replacement. */
let unusedAudienceMessageIds = AUDIENCE_MESSAGES.map((msg) => msg.id);
const FEMALE_US_VOICE_HINTS = [
  'samantha', 'victoria', 'karen', 'moira', 'tessa', 'fiona', 'allison', 'ava',
  'susan', 'zira', 'jenny', 'aria', 'google us english', 'microsoft zira',
];

function languageFlag(lang) {
  const tag = String(lang || '').trim();
  const parts = tag.split(/[-_]/);
  const region = (parts.length >= 2 ? parts[parts.length - 1] : '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) return '🌐';
  return String.fromCodePoint(...[...region].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65));
}

function normalizeWorkerComment(raw, defaultLanguage = 'en-US') {
  if (raw == null) return null;
  if (typeof raw === 'object' && raw !== null) {
    const text = String(raw.text ?? raw.comment ?? '').trim();
    const language = String(raw.language || defaultLanguage).trim() || defaultLanguage;
    const playbackLanguage = String(raw.playbackLanguage || raw.demoAudioLocale || '').trim();
    const displayLanguage = playbackLanguage || language;
    const parsedDemoIndex = Number.parseInt(
      raw.demoCommentIndex ?? raw.demoIndex ?? raw.demo_index,
      10,
    );
    const demoCommentIndex = Number.isInteger(parsedDemoIndex)
      && parsedDemoIndex >= 1
      && parsedDemoIndex <= DEMO_COMMENT_AUDIO_SLIDES.length
      ? parsedDemoIndex
      : null;
    const demoCommentId = String(raw.demoCommentId ?? raw.demo_id ?? '').trim()
      || (demoCommentIndex != null ? DEMO_COMMENT_AUDIO_SLIDES[demoCommentIndex - 1] : '');
    if (!text) return null;
    return {
      text,
      language,
      ...(demoCommentIndex != null ? { demoCommentIndex } : {}),
      ...(demoCommentId ? { demoCommentId } : {}),
      ...(playbackLanguage ? { playbackLanguage, demoAudioLocale: playbackLanguage } : {}),
      flag: languageFlag(displayLanguage),
      key: `${language}\0${text}\0${demoCommentId || demoCommentIndex || 0}`,
      display: `${languageFlag(displayLanguage)} ${text}`,
    };
  }
  const value = String(raw).trim();
  if (!value) return null;
  if (value.startsWith('{')) {
    try {
      return normalizeWorkerComment(JSON.parse(value), defaultLanguage);
    } catch (_) { /* fall through */ }
  }
  return {
    text: value,
    language: defaultLanguage,
    flag: languageFlag(defaultLanguage),
    key: `${defaultLanguage}\0${value}`,
    display: `${languageFlag(defaultLanguage)} ${value}`,
  };
}

function pickSpeechVoice(language) {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  const tag = String(language || 'en-US').trim().toLowerCase();
  const base = tag.split(/[-_]/)[0];
  const matching = voices.filter((voice) => {
    const lang = String(voice.lang || '').toLowerCase();
    return lang === tag || lang.startsWith(`${base}-`) || lang.startsWith(`${base}_`) || lang === base;
  });
  if (tag === 'en-us' || tag.startsWith('en-us')) {
    const female = matching.find((voice) => FEMALE_US_VOICE_HINTS.some((hint) =>
      voice.name.toLowerCase().includes(hint)));
    if (female) return female;
  }
  return matching[0] || voices.find((voice) => String(voice.lang || '').toLowerCase().startsWith(base)) || null;
}

function demoAudioLocaleForLanguage(language) {
  const tag = String(language || '').trim().toLowerCase();
  const base = tag.split(/[-_]/)[0];
  return DEMO_COMMENT_AUDIO_LOCALES.find((locale) => locale.toLowerCase() === tag)
    || DEMO_COMMENT_AUDIO_LOCALES.find((locale) =>
      locale.toLowerCase() === base || locale.toLowerCase().startsWith(`${base}-`))
    || null;
}

function reserveDemoAudioLocale(language) {
  const preferred = demoAudioLocaleForLanguage(language);
  const candidates = preferred
    ? [preferred, ...DEMO_COMMENT_AUDIO_LOCALES.filter((locale) => locale !== preferred)]
    : DEMO_COMMENT_AUDIO_LOCALES;
  const locale = candidates.find((candidate) => !playedDemoAudioLocales.has(candidate));
  if (locale) playedDemoAudioLocales.add(locale);
  return locale || null;
}

function isCatalogDemoComment(normalized) {
  return Boolean(normalized?.demoCommentId) || normalized?.demoCommentIndex != null;
}

function demoCommentAudioUrl(normalized) {
  const slide = normalized?.demoCommentId
    || (Number.isInteger(normalized?.demoCommentIndex)
      ? DEMO_COMMENT_AUDIO_SLIDES[normalized.demoCommentIndex - 1]
      : null);
  const locale = normalized?.demoAudioLocale;
  if (!slide || !locale) return null;
  const base = AUDIENCE_MESSAGES_BY_ID.has(slide) ? AUDIENCE_AUDIO_BASE : DEMO_COMMENT_AUDIO_BASE;
  return assetUrl(`${base}/${slide}-${locale}.wav`);
}

function resetAudienceEmulation() {
  unusedAudienceMessageIds = AUDIENCE_MESSAGES.map((msg) => msg.id);
}

function takeRandomAudienceMessage() {
  if (!unusedAudienceMessageIds.length) return null;
  const pick = Math.floor(Math.random() * unusedAudienceMessageIds.length);
  const id = unusedAudienceMessageIds.splice(pick, 1)[0];
  return AUDIENCE_MESSAGES_BY_ID.get(id) || null;
}

function maybeEmulateAudienceComment(cell, sliceIndex) {
  if (el('emulateAudienceToggle')?.checked === false) return;
  if (!cell || cell.dataset.workerComment) return;
  if (!Number.isInteger(sliceIndex) || sliceIndex < 0) return;
  if ((sliceIndex + 1) % AUDIENCE_EVERY_NTH !== 0) return;
  const message = takeRandomAudienceMessage();
  if (!message) return;
  const locales = Object.keys(message.quotes);
  const language = locales[Math.floor(Math.random() * locales.length)];
  applyWorkerCommentToCell(cell, {
    text: message.quotes[language],
    language,
    demoCommentId: message.id,
    playbackLanguage: language,
  });
}

function playCommentAudio(url) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    currentCommentAudio = audio;
    audio.preload = 'auto';
    let settled = false;
    const finish = (played) => {
      if (settled) return;
      settled = true;
      if (currentCommentAudio === audio) currentCommentAudio = null;
      resolve(played);
    };
    audio.addEventListener('ended', () => finish(true), { once: true });
    audio.addEventListener('error', () => finish(false), { once: true });
    const started = audio.play();
    if (started && typeof started.catch === 'function') {
      started.catch(() => finish(false));
    }
  });
}

function speakCommentWithBrowser(normalized) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) {
      resolve();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(normalized.text);
    utterance.lang = normalized.language;
    const voice = pickSpeechVoice(normalized.language);
    if (voice) utterance.voice = voice;
    utterance.addEventListener('end', resolve, { once: true });
    utterance.addEventListener('error', resolve, { once: true });
    speechSynthesis.speak(utterance);
  });
}

async function drainCommentSpeechQueue() {
  if (commentSpeechActive) return;
  commentSpeechActive = true;
  const generation = commentSpeechGeneration;
  try {
    while (commentSpeechQueue.length && generation === commentSpeechGeneration) {
      if (el('readOutCommentsToggle')?.checked === false && !activeManualCommentCell) {
        commentSpeechQueue.length = 0;
        break;
      }
      const normalized = commentSpeechQueue.shift();
      const audioUrl = demoCommentAudioUrl(normalized);
      const played = audioUrl ? await playCommentAudio(audioUrl) : false;
      if (generation !== commentSpeechGeneration) break;
      if (!played) await speakCommentWithBrowser(normalized);
    }
  } finally {
    if (generation === commentSpeechGeneration) {
      commentSpeechActive = false;
      activeManualCommentCell = null;
    }
  }
}

function enqueueCommentSpeech(normalized, { force = false } = {}) {
  if (!normalized?.text) return;
  if (!force && !commentAutoplayOpen) return;
  if (!force && el('readOutCommentsToggle')?.checked === false) return;
  if (isCatalogDemoComment(normalized)) {
    if (!normalized.demoAudioLocale && !force) return;
  } else {
    if (!force && spokenCommentKeys.has(normalized.key)) return;
    spokenCommentKeys.add(normalized.key);
  }
  commentSpeechQueue.push(normalized);
  drainCommentSpeechQueue().catch((err) => {
    commentSpeechActive = false;
    activeManualCommentCell = null;
    console.warn('Worker comment speech failed', err);
  });
}

function isCommentPlaybackActive() {
  if (commentSpeechActive || currentCommentAudio) return true;
  try {
    if ('speechSynthesis' in window && speechSynthesis.speaking) return true;
  } catch { /* ignore */ }
  return commentSpeechQueue.length > 0;
}

/** Stop autoplay/manual playback immediately (pending + in-flight). */
function stopCommentAutoplayPlayback() {
  commentSpeechGeneration += 1;
  commentSpeechQueue.length = 0;
  commentSpeechActive = false;
  activeManualCommentCell = null;
  if (currentCommentAudio) {
    currentCommentAudio.pause();
    currentCommentAudio.dispatchEvent(new Event('error'));
    currentCommentAudio = null;
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function workerCommentFromCell(cell) {
  if (!cell?.dataset?.workerComment) return null;
  return normalizeWorkerComment({
    text: cell.dataset.workerComment,
    language: cell.dataset.workerLanguage,
    demoCommentIndex: cell.dataset.workerDemoCommentIndex,
    demoCommentId: cell.dataset.workerDemoCommentId,
    playbackLanguage: cell.dataset.workerPlaybackLanguage,
  });
}

function selectedLinkedInComments() {
  const unique = new Map();
  for (const cell of Object.values(gridCells)) {
    if (cell?.dataset?.linkedinSelected !== 'true') continue;
    const normalized = workerCommentFromCell(cell);
    if (normalized) unique.set(normalized.key, normalized.text);
  }
  return [...unique.values()];
}

function linkedInPostMaxCharacters() {
  const n = Number(CONFIG.platforms?.linkedin?.post?.max_characters);
  return Number.isInteger(n) && n > 0 ? n : 1200;
}

function characterCount(text) {
  return [...String(text ?? '')].length;
}

function truncateToCharacters(text, max) {
  const chars = [...String(text ?? '')];
  if (max <= 0) return '';
  if (chars.length <= max) return chars.join('');
  if (max === 1) return '…';
  return `${chars.slice(0, max - 1).join('')}…`;
}

function linkedInCaptionBase(placementLabel) {
  return `${placementLabel || 'Video'} prepared by DCP Social Media Transcoder`;
}

function linkedInBudgetBase() {
  const labels = conceptEntries(CONFIG.platforms?.linkedin?.placements || {})
    .map(([, placement]) => placement?.label)
    .filter(Boolean);
  const bases = (labels.length ? labels : ['Video']).map(linkedInCaptionBase);
  return bases.reduce((longest, next) =>
    (characterCount(next) > characterCount(longest) ? next : longest));
}

function packLinkedInCaption(quotes, placementLabel) {
  const limit = linkedInPostMaxCharacters();
  const requested = [...new Set((quotes || []).filter(Boolean))];
  let body = placementLabel == null ? linkedInBudgetBase() : linkedInCaptionBase(placementLabel);
  if (characterCount(body) > limit) body = truncateToCharacters(body, limit);
  const included = [];
  let truncated = false;
  for (const quote of requested) {
    const sep = included.length ? '\n' : '\n\n';
    const formatted = `“${quote}”`;
    const next = `${body}${sep}${formatted}`;
    if (characterCount(next) <= limit) {
      body = next;
      included.push(quote);
      continue;
    }
    const room = limit - characterCount(`${body}${sep}`);
    if (!included.length && room > 1) {
      body = `${body}${sep}${truncateToCharacters(formatted, room)}`;
      included.push(quote);
      truncated = true;
      break;
    }
  }
  return {
    text: body,
    limit,
    used: characterCount(body),
    included,
    omitted: requested.filter((quote) => !included.includes(quote)),
    truncated,
  };
}

function setCellLinkedInSelected(cell, selected) {
  if (!cell) return;
  const picker = cell.querySelector('.slice-linkedin-pick input');
  if (selected) {
    const quote = workerCommentFromCell(cell)?.text;
    const trial = packLinkedInCaption(selectedLinkedInComments().concat(quote || []));
    if (quote && !trial.included.includes(quote)) {
      cell.dataset.linkedinSelected = 'false';
      cell.classList.remove('linkedin-comment');
      if (picker) picker.checked = false;
      refreshWorkerCommentLegend(
        `that comment does not fit in the ${linkedInPostMaxCharacters()}-character LinkedIn post`,
      );
      return;
    }
  }
  cell.dataset.linkedinSelected = selected ? 'true' : 'false';
  cell.classList.toggle('linkedin-comment', selected);
  if (picker && picker.checked !== selected) picker.checked = selected;
  refreshWorkerCommentLegend();
}

function ensureLinkedInPicker(cell) {
  if (!cell || cell.querySelector('.slice-linkedin-pick')) return;
  const label = document.createElement('label');
  label.className = 'slice-linkedin-pick';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = cell.dataset.linkedinSelected === 'true';
  input.setAttribute('aria-label', 'Include this worker comment in the LinkedIn post');
  const caption = document.createElement('span');
  caption.textContent = 'LinkedIn';
  label.append(input, caption);
  const stop = (event) => event.stopPropagation();
  label.addEventListener('click', stop);
  label.addEventListener('keydown', stop);
  input.addEventListener('change', () => setCellLinkedInSelected(cell, input.checked));
  cell.appendChild(label);
}

function playWorkerCommentFromCell(cell) {
  let normalized = workerCommentFromCell(cell);
  if (!normalized) return;
  if (activeManualCommentCell === cell && isCommentPlaybackActive()) {
    stopCommentAutoplayPlayback();
    return;
  }
  if (isCatalogDemoComment(normalized) && !normalized.demoAudioLocale) {
    const demoAudioLocale = demoAudioLocaleForLanguage(normalized.language);
    if (demoAudioLocale) {
      normalized = { ...normalized, demoAudioLocale };
    }
  }
  stopCommentAutoplayPlayback();
  activeManualCommentCell = cell;
  enqueueCommentSpeech(normalized, { force: true });
}

function finishCommentAutoplay() {
  commentAutoplayOpen = false;
  commentSpeechQueue.length = 0;
}

function resetCommentSpeechQueue() {
  commentSpeechGeneration += 1;
  commentSpeechQueue.length = 0;
  commentSpeechActive = false;
  commentAutoplayOpen = true;
  activeManualCommentCell = null;
  playedDemoAudioLocales.clear();
  if (currentCommentAudio) {
    currentCommentAudio.pause();
    currentCommentAudio.dispatchEvent(new Event('error'));
    currentCommentAudio = null;
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

el('readOutCommentsToggle')?.addEventListener('change', () => {
  if (el('readOutCommentsToggle')?.checked === false) {
    stopCommentAutoplayPlayback();
  }
});

if ('speechSynthesis' in window) {
  speechSynthesis.getVoices();
  speechSynthesis.addEventListener('voiceschanged', () => {
    speechSynthesis.getVoices();
  });
}

function setupGrid(units, formatsMeta) {
  const grid = el('grid');
  grid.innerHTML = '';
  gridCells = {};
  spokenCommentKeys.clear();
  resetAudienceEmulation();
  resetCommentSpeechQueue();
  const legend = el('workerCommentLegend');
  if (legend) legend.textContent = '';
  const total = units.length;
  const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(total))));
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(12rem, 1fr))`;
  for (let i = 0; i < total; i++) {
    const unit = units[i];
    const formatLabels = (unit.formatIndexes || [])
      .map((index) => formatsMeta[index]?.signature || `format ${index}`)
      .join(', ');
    const baseTitle =
      `slice ${i + 1} · ${unit.sourceId || 'primary'} ` +
      `chunk ${(unit.chunkIndex ?? i) + 1}` +
      (unit.programIndex != null && unit.programIndex !== unit.chunkIndex
        ? ` · program ${unit.programIndex + 1}`
        : '') +
      (unit.needsTrim ? ' · trim' : '') +
      (formatLabels ? `\n${formatLabels}` : '');
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    cell.style.setProperty('--slice-progress', '0%');
    cell.dataset.sliceProgress = '0';
    cell.dataset.baseTitle = baseTitle;
    cell.title = `${baseTitle}\npending`;
    cell.setAttribute('role', 'progressbar');
    cell.setAttribute('aria-label', baseTitle);
    cell.setAttribute('aria-valuemin', '0');
    cell.setAttribute('aria-valuemax', '100');
    cell.setAttribute('aria-valuenow', '0');
    cell.addEventListener('click', () => playWorkerCommentFromCell(cell));
    cell.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      playWorkerCommentFromCell(cell);
    });
    grid.appendChild(cell);
    gridCells[i] = cell;
  }
}

function updateSliceProgress(sliceNumber, rawProgress) {
  const index = Number(sliceNumber) - 1; // DCP slice numbers are one-based.
  const cell = gridCells[index];
  if (!cell || cell.classList.contains('done')) return;
  const n = rawProgress === undefined ? Number.NaN : Number(rawProgress);
  cell.classList.add('active');
  const commentLine = cell.dataset.workerComment
    ? `\nworker: ${workerCommentFromCell(cell)?.display || cell.dataset.workerComment}`
    : '';
  if (!Number.isFinite(n)) {
    cell.classList.add('indeterminate');
    cell.title = `${cell.dataset.baseTitle}${commentLine}\ntranscoding…`;
    return;
  }
  cell.classList.remove('indeterminate');
  const ratio = Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
  const percent = Math.round(ratio * 100);
  cell.style.setProperty('--slice-progress', `${percent}%`);
  cell.dataset.sliceProgress = String(percent);
  cell.setAttribute('aria-valuenow', String(percent));
  cell.title = `${cell.dataset.baseTitle}${commentLine}\n${percent}% transcoded`;
}

function formatComputeSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 10) return `${n.toFixed(2)}s`;
  if (n < 100) return `${n.toFixed(1)}s`;
  return `${Math.round(n)}s`;
}

function summarizeSegmentCompute(segments) {
  const parts = [];
  let total = 0;
  let counted = 0;
  for (const seg of segments || []) {
    const n = Number(seg?.computeSeconds);
    if (!Number.isFinite(n) || n < 0) continue;
    total += n;
    counted += 1;
    const label = formatComputeSeconds(n);
    if (label && seg?.signature) parts.push(`${seg.signature}: ${label}`);
    else if (label) parts.push(label);
  }
  if (!counted) return null;
  return {
    total,
    label: formatComputeSeconds(total),
    detail: parts.length > 1 ? parts.join('\n') : (parts[0] || formatComputeSeconds(total)),
  };
}

function applyComputeSecondsToCell(cell, segments) {
  if (!cell) return;
  const summary = summarizeSegmentCompute(segments);
  if (!summary?.label) return;
  cell.dataset.computeSeconds = String(summary.total);
  let badge = cell.querySelector('.slice-compute');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'slice-compute';
    badge.setAttribute('aria-hidden', 'true');
    cell.appendChild(badge);
  }
  badge.textContent = summary.label;
  badge.title = summary.detail || summary.label;
}

function applyWorkerCommentToCell(cell, workerComment) {
  if (!cell) return;
  const normalized = normalizeWorkerComment(workerComment);
  if (!normalized) return;
  let presented = normalized;
  if (cell.dataset.workerSpeechKey === normalized.key) {
    if (cell.dataset.workerPlaybackLanguage) {
      presented = normalizeWorkerComment({
        ...normalized,
        playbackLanguage: cell.dataset.workerPlaybackLanguage,
      });
    }
  } else {
    const demoAudioLocale = isCatalogDemoComment(normalized)
      ? (normalized.demoAudioLocale || reserveDemoAudioLocale(normalized.language))
      : null;
    if (demoAudioLocale) {
      presented = normalizeWorkerComment({
        ...normalized,
        playbackLanguage: demoAudioLocale,
      });
      cell.dataset.workerPlaybackLanguage = demoAudioLocale;
    } else {
      delete cell.dataset.workerPlaybackLanguage;
    }
    cell.dataset.workerSpeechKey = normalized.key;
    if (el('readOutCommentsToggle')?.checked !== false) {
      enqueueCommentSpeech(presented);
    }
  }
  cell.dataset.workerComment = normalized.text;
  cell.dataset.workerLanguage = normalized.language;
  if (normalized.demoCommentIndex != null) {
    cell.dataset.workerDemoCommentIndex = String(normalized.demoCommentIndex);
  } else {
    delete cell.dataset.workerDemoCommentIndex;
  }
  if (normalized.demoCommentId) {
    cell.dataset.workerDemoCommentId = String(normalized.demoCommentId);
  } else {
    delete cell.dataset.workerDemoCommentId;
  }
  cell.classList.add('has-worker-comment');
  ensureLinkedInPicker(cell);
  const now = cell.dataset.sliceProgress || cell.getAttribute('aria-valuenow') || '0';
  cell.setAttribute('tabindex', '0');
  let callout = cell.querySelector('.slice-callout');
  if (!callout) {
    callout = document.createElement('div');
    callout.className = 'slice-callout';
    callout.setAttribute('aria-hidden', 'true');
    cell.appendChild(callout);
  }
  callout.textContent = presented.display;
  const commentLine = `\nworker: ${presented.display}`;
  const state = cell.classList.contains('done')
    ? 'complete'
    : (cell.classList.contains('indeterminate') ? 'transcoding…' : `${now}%`);
  cell.title = `${cell.dataset.baseTitle}${commentLine}\n${state}`;
  cell.setAttribute(
    'aria-label',
    `${cell.dataset.baseTitle}; play worker comment ${presented.display}; ${state}`,
  );
  refreshWorkerCommentLegend();
}

function refreshWorkerCommentLegend(hint) {
  const legend = el('workerCommentLegend');
  if (!legend) return;
  const comments = new Map();
  for (const cell of Object.values(gridCells)) {
    const normalized = workerCommentFromCell(cell);
    if (normalized) comments.set(normalized.key, normalized.display);
  }
  if (!comments.size) {
    legend.textContent = '';
    return;
  }
  const short = [...comments.values()].map((display) => {
    const t = display.length > 52 ? `${display.slice(0, 49)}…` : display;
    return `“${t}”`;
  });
  const packed = packLinkedInCaption(selectedLinkedInComments());
  const budget = packed.included.length
    ? `${packed.included.length} selected for LinkedIn (${packed.used}/${packed.limit})`
    : `check LinkedIn on a slice to include its comment in the ${linkedInPostMaxCharacters()}-character post`;
  legend.textContent =
    `Workers (${comments.size}): ${short.join(' · ')} · ${budget}` +
    (packed.truncated ? ' · truncated to the LinkedIn limit' : '') +
    (hint ? ` · ${hint}` : '');
}

function formatWorkerComments(comments) {
  const unique = new Map();
  for (const entry of comments || []) {
    const normalized = normalizeWorkerComment(entry);
    if (normalized) unique.set(normalized.key, normalized.display);
  }
  return [...unique.values()];
}

// ---- DCP dispatch ----
function framingModeCode() {
  const v = el('framingSelect').value;
  if (v === 'contain') return 2;
  if (v === 'stretch') return 0;
  return 1; // cover
}

async function dispatchJob(sourcePlans, uniqueFormats, maxDistribution, inputBaseName) {
  const { compute, wallet } = window.dcp;
  const sourceById = new Map(sourcePlans.map((source) => [source.id, source]));
  dbg('dispatchJob start', {
    sources: sourcePlans.map((source) => ({
      id: source.id,
      chunks: source.chunks.length,
      formats: uniqueFormats.filter((format) => format.sourceId === source.id).length,
      container: source.container,
    })),
    formats: uniqueFormats.length,
    maxDistribution,
    paymentPerSlice: slicePaymentDcc,
    package: CONFIG.dcp_package || 'ffmpeg-dcp-social-v2/ffmpeg-wasm.js',
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

  const dcpPackageId = CONFIG.dcp_package || 'ffmpeg-dcp-social-v2/ffmpeg-wasm.js';

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
    sourceId: f.sourceId,
  }));
  const formatsMetaJson = JSON.stringify(formatsMeta);
  const totalUnits = sourcePlans.reduce((total, source) => {
    const formatCount = uniqueFormats.filter((format) => format.sourceId === source.id).length;
    const pieces = source.programSegments?.length || source.chunks.length;
    return total + pieces * formatCount;
  }, 0);
  dbg('formatsMeta', formatsMeta.map((f) => `${f.signature} ${f.width}x${f.height}`));

  const prepWorker = new Worker(assetUrl(CONFIG.deploy_worker_script || 'dcp-deploy-worker.js'));
  dbg('prep worker start', assetUrl(CONFIG.deploy_worker_script || 'dcp-deploy-worker.js'));
  const inputSet = await new Promise((resolve, reject) => {
    prepWorker.onmessage = ({ data }) => resolve(data.inputSet);
    prepWorker.onerror = (err) => reject(new Error(`prep worker failed: ${err.message || 'script error'}`));
    prepWorker.postMessage({
      cmd: 'prepare',
      sourceSets: sourcePlans.map((source) => ({
        sourceId: source.id,
        chunks: source.chunks,
        programSegments: source.programSegments || null,
        formatIndexes: uniqueFormats
          .map((format, index) => (format.sourceId === source.id ? index : -1))
          .filter((index) => index >= 0),
        container: source.container,
      })),
      maxDistribution,
    });
  });
  prepWorker.terminate();

  const inputSummary = inputSet.map((u, i) => ({
    i,
    sourceId: u.sourceId,
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

  async function workFunction(unit, formatsMetaJsonArg, packageIdArg) {
    // console.* on the worker is often forwarded as job 'console' events.
    const wlog = (...args) => {
      try { console.log('[social-wf]', ...args); } catch (_) { /* ignore */ }
    };
    const packageId = String(packageIdArg || 'ffmpeg-dcp-social-v2/ffmpeg-wasm.js');
    const readWorkerComment = () => {
      try {
        const sources = [
          (typeof globalThis !== 'undefined' && globalThis.dcpWorkerContext),
          (typeof self !== 'undefined' && self.dcpWorkerContext),
          (typeof self !== 'undefined' && self.work && self.work.xframeContext),
          (typeof work !== 'undefined' && work && work.xframeContext),
          (typeof progress !== 'undefined' && progress && progress.xframeContext),
          (typeof require !== 'undefined' && require && require.xframeContext),
        ];
        for (const ctx of sources) {
          if (!ctx || ctx.comment == null) continue;
          const raw = ctx.comment;
          if (typeof raw === 'object' && raw !== null) {
            const text = String(raw.text || '').trim();
            const language = String(raw.language || 'en-US').trim() || 'en-US';
            const parsedDemoIndex = Number.parseInt(
              raw.demoCommentIndex ?? raw.demoIndex ?? raw.demo_index,
              10,
            );
            if (text) {
              return {
                text,
                language,
                ...(Number.isInteger(parsedDemoIndex) && parsedDemoIndex >= 1
                  ? { demoCommentIndex: parsedDemoIndex }
                  : {}),
              };
            }
            continue;
          }
          const text = String(raw).trim();
          if (text) return { text, language: 'en-US' };
        }
        return null;
      } catch (_) {
        return null;
      }
    };
    const workerComment = readWorkerComment();
    wlog('context', {
      comment: workerComment,
      hasDcpWorkerContext: !!(
        (typeof globalThis !== 'undefined' && globalThis.dcpWorkerContext)
        || (typeof self !== 'undefined' && self.dcpWorkerContext)
      ),
      hasWorkContext: !!(
        (typeof self !== 'undefined' && self.work && self.work.xframeContext)
        || (typeof work !== 'undefined' && work && work.xframeContext)
      ),
      hasProgressContext: !!(typeof progress !== 'undefined' && progress && progress.xframeContext),
    });
    if (workerComment) {
      try { console.log(`[social-worker-comment] ${JSON.stringify(workerComment)}`); } catch (_) { /* ignore */ }
    }
    let lastDeterminateProgress = -1;
    const reportProgress = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        progress();
        return;
      }
      const next = Math.max(0, Math.min(1, n));
      if (next <= lastDeterminateProgress) return false;
      lastDeterminateProgress = next;
      progress(next);
      // JobHandle does not consistently forward scheduler progress reports to
      // clients. Console events retain the slice index, so mirror this compact
      // marker for the per-slice grid.
      console.log(`[social-progress] ${next.toFixed(6)}`);
      return true;
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
      reportProgress(0);
      wlog('start', {
        chunkIndex: unit.chunkIndex,
        programIndex: unit.programIndex,
        needsTrim: !!unit.needsTrim,
        trimStartSec: unit.trimStartSec,
        trimEndSec: unit.trimEndSec,
        formatIndexes: unit.formatIndexes,
        chunkExt: unit.chunkExt,
        b64Len: unit.chunkBase64?.length,
      });
      const formatsMetaArg = JSON.parse(formatsMetaJsonArg);
      const indexes = unit.formatIndexes !== undefined
        ? unit.formatIndexes
        : formatsMetaArg.map((_, i) => i);
      let activeFormatPosition = 0;
      const formatCount = Math.max(1, indexes.length);
      wlog('require', packageId);
      // Fully-qualified package id — bare 'ffmpeg-wasm.js' can resolve relative to
      // the sandbox evaluator path (…/src/…) as package "src" when the published
      // package is missing from the module search path (seen on iOS Safari).
      // Pin @version so fleet workers do not keep a cached pre-extract build.
      const required = require(packageId);
      wlog('require keys', required && typeof required === 'object' ? Object.keys(required) : typeof required);
      const createFfmpegModule = required.createFfmpegModule || required.default || required;
      if (typeof createFfmpegModule !== 'function') {
        throw new Error(`${packageId} did not export createFfmpegModule`);
      }
      wlog('createFfmpegModule…');
      const Module = await createFfmpegModule({
        onTranscodeProgress(ratio) {
          const localRatio = Number(ratio);
          if (!Number.isFinite(localRatio) || localRatio < 0) {
            progress();
            return;
          }
          // Reserve 10% for module setup and 2% for result serialization.
          reportProgress(0.1 + (0.88 * (activeFormatPosition + Math.min(1, localRatio)) / formatCount));
        },
      });
      reportProgress(0.1);
      wlog('module ready', {
        hasCcall: typeof Module.ccall === 'function',
        hasFS: Boolean(Module.FS),
        hasExtract: typeof Module._extract_time_range === 'function',
      });

      const chunkBytes = Uint8Array.from(atob(unit.chunkBase64), (c) => c.charCodeAt(0));
      const isEbml = chunkBytes.length >= 4 &&
        chunkBytes[0] === 0x1a && chunkBytes[1] === 0x45 &&
        chunkBytes[2] === 0xdf && chunkBytes[3] === 0xa3;
      const isMp4 = chunkBytes.length >= 8 &&
        chunkBytes[4] === 0x66 && chunkBytes[5] === 0x74 &&
        chunkBytes[6] === 0x79 && chunkBytes[7] === 0x70;
      const sniffed = isEbml ? 'webm' : (isMp4 ? 'mp4' : 'ts');
      const inExt = (sniffed === 'webm' || sniffed === 'mp4') ? sniffed : (unit.chunkExt || 'ts');
      if (inExt === 'ts' && chunkBytes[0] === 0x47) {
        throw new Error(
          'Chunk is MPEG-TS. VP9/VP8 in TS is private data, so transcode_social_segment reports no video. ' +
          'Reload so the client slicer keeps WebM/MP4 (not slice() → .ts).',
        );
      }
      const inPath = `/chunk-in.${inExt}`;
      wlog('write input', {
        inPath,
        bytes: chunkBytes.length,
        magic: [...chunkBytes.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join(''),
        isEbml,
        isMp4,
      });
      Module.FS.writeFile(inPath, chunkBytes);

      let socialInPath = inPath;
      const cleanupPaths = [inPath];
      if (unit.needsTrim) {
        if (typeof Module._extract_time_range !== 'function') {
          throw new Error(
            'extract_time_range missing from fleet WASM — jobs must require ' +
            'ffmpeg-dcp-social-v2/ffmpeg-wasm.js (republish if that version is absent).',
          );
        }
        const trimStart = Number(unit.trimStartSec) || 0;
        const trimEnd = Number(unit.trimEndSec) || 0;
        if (!(trimEnd > trimStart)) {
          throw new Error(`Invalid director’s-cut trim ${trimStart}..${trimEnd}`);
        }
        const trimTsPath = '/cut-trim.ts';
        const trimMp4Path = '/cut-trim.mp4';
        wlog('extract_time_range', { trimStart, trimEnd });
        const extractCode = Module.ccall(
          'extract_time_range', 'number',
          ['string', 'string', 'number', 'number', 'number', 'number'],
          [inPath, trimTsPath, trimStart, trimEnd, 6000, 160],
        );
        if (extractCode < 0) {
          throw new Error(`extract_time_range failed (${extractCode}) for ${trimStart}..${trimEnd}`);
        }
        const remuxCode = Module.ccall(
          'remux_to_mp4', 'number',
          ['string', 'string'],
          [trimTsPath, trimMp4Path],
        );
        try { Module.FS.unlink(trimTsPath); } catch (_) { /* ignore */ }
        if (remuxCode < 0) {
          throw new Error(`remux_to_mp4 after extract failed (${remuxCode})`);
        }
        socialInPath = trimMp4Path;
        cleanupPaths.push(trimMp4Path);
        reportProgress(0.12);
      }

      const results = [];
      for (let formatPosition = 0; formatPosition < indexes.length; formatPosition++) {
        const formatIndex = indexes[formatPosition];
        activeFormatPosition = formatPosition;
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
          socialInPath,
        });
        const code = Module.ccall(
          'transcode_social_segment', 'number',
          ['string', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'string'],
          [
            socialInPath, outPath, fmt.width, fmt.height, fmt.bitrateKbps,
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
        reportProgress(0.1 + (0.88 * (formatPosition + 1) / formatCount));
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < segBytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, segBytes.subarray(i, i + chunkSize));
        }
        results.push({ signature: fmt.signature, segmentBase64: btoa(binary), computeSeconds });
        wlog('segment encoded', { signature: fmt.signature, outBytes: segBytes.length, computeSeconds });
      }
      for (const path of cleanupPaths) {
        try { Module.FS.unlink(path); } catch (_) { /* ignore */ }
      }
      reportProgress(1);
      const finalComment = readWorkerComment() || workerComment;
      const programIndex = unit.programIndex != null ? unit.programIndex : unit.chunkIndex;
      wlog('return', {
        chunkIndex: unit.chunkIndex,
        programIndex,
        segments: results.length,
        workerComment: finalComment || null,
      });
      return {
        sourceId: unit.sourceId,
        chunkIndex: unit.chunkIndex,
        programIndex,
        segments: results,
        workerComment: finalComment || null,
      };
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
  const workerCommentsBySignature = {};
  for (const f of uniqueFormats) {
    const source = sourceById.get(f.sourceId);
    const pieces = source?.programSegments?.length || source?.chunks.length || 0;
    bySignature[f.signature] = new Array(pieces).fill(null);
    workerCommentsBySignature[f.signature] = new Array(pieces).fill(null);
  }

  setupGrid(inputSet, formatsMeta);
  el('statCompleted').textContent = `0 / ${totalUnits}`;

  dbg('compute.for…', { slices: inputSet.length, argsBytes: formatsMetaJson.length, package: dcpPackageId });
  const job = compute.for(inputSet, workFunction, [formatsMetaJson, dcpPackageId]);
  job.requires([dcpPackageId]);
  job.computeGroups = getComputeGroups();
  job.public = {
    name: `🎞️ Social transcoder: ${inputBaseName}`,
    description: 'WebM or MP4 → social H.264/AAC masters via DCP',
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
      `Each worker must download/instantiate ffmpeg-dcp-social-v2 (~8MB); first result often takes 1–3+ minutes.`,
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
  job.on('console', (ev) => {
    if (!ev || typeof ev !== 'object') return;
    const raw = ev.message ?? ev.data ?? '';
    const message = Array.isArray(raw)
      ? raw.map((part) => (typeof part === 'string' ? part : (() => {
          try { return JSON.stringify(part); } catch (_) { return String(part); }
        })())).join(' ')
      : String(raw);
    const commentMatch = message.match(/\[social-worker-comment\]\s+(.+?)(?:\s*$)/);
    if (commentMatch) {
      const sliceNumber = ev.sliceNumber ?? ev.sliceIndex ?? ev.slice;
      const index = Number(sliceNumber) - 1;
      applyWorkerCommentToCell(gridCells[index], commentMatch[1].trim());
    }
    const match = message.match(/\[social-progress\]\s+([0-9.]+)/);
    if (!match) return;
    updateSliceProgress(ev.sliceNumber ?? ev.sliceIndex ?? ev.slice, Number(match[1]));
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
    const sourceId = payload?.sourceId || 'primary';
    const chunkIndex = payload?.chunkIndex;
    const programIndex = payload?.programIndex != null ? payload.programIndex : chunkIndex;
    const segments = payload?.segments;
    const workerComment = payload?.workerComment != null ? payload.workerComment : null;
    const normalizedComment = normalizeWorkerComment(workerComment);
    if (!Array.isArray(segments)) {
      log(`Unexpected result payload (slice ${ev?.sliceNumber ?? '?'}): ${safeJson(payload)}`);
      return;
    }
    for (const seg of segments) {
      if (!seg?.signature || !bySignature[seg.signature]) {
        log(`Unknown signature in result: ${seg?.signature}`);
        continue;
      }
      bySignature[seg.signature][programIndex] = seg.segmentBase64;
      if (normalizedComment && workerCommentsBySignature[seg.signature]) {
        workerCommentsBySignature[seg.signature][programIndex] = normalizedComment;
      }
      completed += 1;
    }
    const sliceIndex = Number.isFinite(Number(ev?.sliceNumber))
      ? Number(ev.sliceNumber) - 1
      : unitIndex;
    unitIndex += 1;
    const cell = gridCells[sliceIndex];
    let presented = normalizedComment;
    if (cell) {
      applyWorkerCommentToCell(cell, normalizedComment);
      maybeEmulateAudienceComment(cell, sliceIndex);
      applyComputeSecondsToCell(cell, segments);
      cell.classList.remove('active', 'indeterminate');
      cell.classList.add('done');
      cell.style.setProperty('--slice-progress', '100%');
      cell.dataset.sliceProgress = '100';
      cell.setAttribute('aria-valuenow', '100');
      presented = workerCommentFromCell(cell) || presented;
      if (presented) {
        for (const seg of segments) {
          if (seg?.signature && workerCommentsBySignature[seg.signature]) {
            workerCommentsBySignature[seg.signature][programIndex] = presented;
          }
        }
      }
      const commentLine = presented
        ? `\nworker: ${presented.display}`
        : '';
      const computeSummary = summarizeSegmentCompute(segments);
      const computeLine = computeSummary?.detail
        ? `\ncompute ${computeSummary.detail.replace(/\n/g, '; ')}`
        : '';
      cell.title = `${cell.dataset.baseTitle}${commentLine}${computeLine}\ncomplete`;
      if (computeSummary?.label) {
        cell.setAttribute(
          'aria-label',
          `${cell.dataset.baseTitle}; compute ${computeSummary.label}; complete`,
        );
      }
    }
    el('fleetBar').style.width = `${(completed / totalUnits) * 100}%`;
    el('statCompleted').textContent = `${completed} / ${totalUnits}`;
    const status = el('preprocessingStatus');
    if (status) {
      status.textContent = `Fleet: received ${completed}/${totalUnits} format-units…`;
    }
    const computeSummary = summarizeSegmentCompute(segments);
    log(
      `Received slice ${ev?.sliceNumber ?? unitIndex}: program ${programIndex}, chunk ${chunkIndex}, ` +
      `${sourceId} source, ${segments.length} segment(s)` +
      `${computeSummary?.label ? `, compute ${computeSummary.label}` : ''}` +
      `${presented ? `, worker “${presented.display}”` : ''}` +
      ` (${completed}/${totalUnits} format-units)`,
    );
  });

  const groupsLabel = (job.computeGroups || []).map((g) => g.joinKey || g).join(', ') || '(default)';
  const sourceSummary = sourcePlans
    .map((source) => {
      const formatCount = uniqueFormats.filter((format) => format.sourceId === source.id).length;
      const pieces = source.programSegments?.length || source.chunks.length;
      const cutNote = source.cutIsFull === false
        ? ` (cut → ${pieces}/${source.chunks.length} pieces)`
        : '';
      return `${source.id}: ${pieces} piece(s)${cutNote} × ${formatCount} formats`;
    })
    .join('; ');
  log(`Dispatching ${inputSet.length} slice(s), ${totalUnits} format-units (${sourceSummary}) → groups: ${groupsLabel}`);
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
        `hint: still 0 distributed slices — public workers may be scarce, or open ${PUBLIC_WORKER_URL} ` +
        'and join this compute group so a worker can pick up work',
      );
    }
    if (Number(st.distributed) > 0 && Number(st.computed) === 0 && resultEvents === 0 && Number(sec) >= 45) {
      dbg(
        'hint: slices are distributed but none computed yet — workers are likely still loading ' +
        'ffmpeg-dcp-social-v2 WASM; watch for job.console [social-wf] lines',
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
    finishCommentAutoplay();
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
  return { bySignature, workerCommentsBySignature };
}

function framingLabel() {
  const v = el('framingSelect')?.value;
  if (v === 'contain') return 'Fit (pad)';
  if (v === 'stretch') return 'Stretch';
  return 'Fill (center crop)';
}

function showOutputPreview(out) {
  const panel = el('outputPreviewPanel');
  const video = el('outputPreview');
  const meta = el('outputPreviewMeta');
  if (!panel || !video || !meta) return;
  panel.classList.remove('hidden');
  video.src = out.url;
  const play = video.play();
  if (play && typeof play.catch === 'function') play.catch(() => {});
  const a = out.alias || {};
  const rows = [
    ['File', out.name],
    ['Size', formatBytes(out.bytes)],
    ['Exact size', `${Number(out.bytes || 0).toLocaleString()} bytes`],
    ['Platform', `${a.platformName || '—'} · ${a.placementLabel || '—'}`],
    ['Video', `H.264 (${a.encoder || 'libopenh264'}) ${a.width}×${a.height}`],
    ['Video bitrate', `${a.bitrateKbps} kbps`],
    ['Audio', `AAC-LC ${a.audioBitrateKbps} kbps`],
    ['Frame rate', `${a.maxFps || 30} fps (target)`],
    ['GOP', `${a.gopSeconds || 2}s (~${(a.gopSeconds || 2) * (a.maxFps || 30)} frames)`],
    ['Framing', framingLabel()],
    ['Format signature', a.signature || '—'],
    ['Container', 'MP4 (H.264/AAC, +faststart)'],
  ];
  const dl = document.createElement('dl');
  dl.className = 'preview-meta';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = String(v);
    dl.append(dt, dd);
  }
  meta.replaceChildren(dl);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function linkedInShareText(out) {
  return packLinkedInCaption(selectedLinkedInComments(), out.alias?.placementLabel).text;
}

async function shareOutputToLinkedIn(out) {
  const status = el('saveOutputsStatus');
  const file = new File([out.blob], out.name, { type: 'video/mp4' });
  const packed = packLinkedInCaption(selectedLinkedInComments(), out.alias?.placementLabel);
  const shareData = {
    title: `${out.alias?.platformName || 'LinkedIn'} video`,
    text: packed.text,
    files: [file],
  };
  if (!navigator.share || (navigator.canShare && !navigator.canShare(shareData))) {
    status.textContent =
      'Direct LinkedIn sharing is unavailable in this browser. Download the MP4 and attach it in LinkedIn.';
    return;
  }
  try {
    await navigator.share(shareData);
    status.textContent = packed.truncated || packed.omitted.length
      ? `${out.name} was handed to your device's share sheet (${packed.used}/${packed.limit} characters).`
      : `${out.name} was handed to your device's share sheet.`;
  } catch (err) {
    if (err.name !== 'AbortError') {
      status.textContent = `Could not share ${out.name}: ${err.message}`;
    }
  }
}

async function assembleMasters(bySignature, uniqueFormats, deliverables, workerCommentsBySignature = {}) {
  const outputs = [];
  el('outputsSection').classList.remove('hidden');
  const host = el('outputs');
  host.innerHTML = '';
  const previewVideo = el('outputPreview');
  if (previewVideo) {
    previewVideo.pause();
    previewVideo.removeAttribute('src');
    previewVideo.load();
  }
  el('outputPreviewPanel')?.classList.add('hidden');
  el('outputPreviewMeta')?.replaceChildren();

  for (const fmt of uniqueFormats) {
    const segs = bySignature[fmt.signature];
    if (!segs || segs.some((s) => s === null)) {
      log(`Skipping incomplete signature ${fmt.signature}`);
      continue;
    }
    const parts = segs.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const workerLabels = formatWorkerComments(workerCommentsBySignature[fmt.signature]);

    log(`Remuxing ${fmt.signature} → MP4 (${formatBytes(total)} TS, ${parts.length} segment(s))…`);
    const mp4Bytes = await remuxToMp4(parts);
    const aliases = fmt.aliases || deliverables.filter((d) => d.signature === fmt.signature);
    for (const alias of aliases) {
      const name = `${inputBaseName}-${alias.deliverableId}.mp4`;
      const blob = new Blob([mp4Bytes], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const out = { name, blob, url, alias, bytes: mp4Bytes.length, workerComments: workerLabels };
      outputs.push(out);
      const row = document.createElement('div');
      row.className = 'output-row';
      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${alias.platformName} · ${alias.placementLabel}`;
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.textContent =
        `${name} · ${alias.width}×${alias.height} · ${formatBytes(mp4Bytes.length)}`;
      info.append(title, sub);
      const actions = document.createElement('div');
      actions.className = 'output-actions';
      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'btn';
      previewBtn.textContent = 'Preview';
      previewBtn.addEventListener('click', () => showOutputPreview(out));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.textContent = 'Download';
      a.className = 'btn';
      actions.append(previewBtn);
      if (alias.platformId === 'linkedin') {
        const linkedInBtn = document.createElement('button');
        linkedInBtn.type = 'button';
        linkedInBtn.className = 'btn';
        linkedInBtn.textContent = 'Post to LinkedIn';
        linkedInBtn.addEventListener('click', () => shareOutputToLinkedIn(out));
        actions.append(linkedInBtn);
      }
      actions.append(a);
      row.append(info, actions);
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

async function sliceSource(sourceId, bytes, targetFrames) {
  log(`Slicing ${sourceId} input (client-side WASM)…`);
  const result = await sliceVideo(bytes, targetFrames);
  const { chunks, durations, fps, container, slicer } = result;
  log(
    `Sliced ${sourceId} input into ${chunks.length} chunk(s) via ${slicer || 'slice'} ` +
    `→ .${container || '?'}, fps=${(fps || 0).toFixed?.(2) ?? fps}`,
  );
  const inputKind = (bytes[0] === 0x1a && bytes[1] === 0x45)
    ? 'webm'
    : (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 ? 'mp4' : 'other');
  if (inputKind === 'mp4' || inputKind === 'webm') {
    const bad = chunks.findIndex((chunk) => chunk && chunk[0] === 0x47);
    if (bad >= 0) {
      throw new Error(
        `Slicer ${slicer || 'slice'} turned the ${sourceId} ${inputKind} into MPEG-TS (chunk ${bad}). ` +
        'VP9 in TS is private data (no video). Hard-refresh so ffmpeg-worker.js keeps .mp4/.webm, then retry.',
      );
    }
  }
  dbg(`${sourceId} slice summary`, {
    chunkBytes: chunks.map((chunk) => chunk.length),
    durations,
    fps,
    container,
    slicer,
    inputBytes: bytes.length,
  });
  return { id: sourceId, ...result };
}

function activeDirectorsCutProgram(sourceDurationSec) {
  const sourceDuration = Number(sourceDurationSec);
  if (!(sourceDuration > 0)) return { slices: [], isFull: true };
  const basis = inputSourceDurationSec || sourceDuration;
  const base = directorsCutSlices.length
    ? directorsCutSlices
    : defaultFullSlice(basis);
  const slices = normalizeSlices(base, sourceDuration);
  if (!slices.length) {
    return { slices: defaultFullSlice(sourceDuration), isFull: true };
  }
  return {
    slices,
    isFull: isFullProgram(slices, sourceDuration) || isFullProgram(base, basis),
  };
}

/** Attach director’s-cut program segments to a sliced source (no browser re-encode). */
function attachDirectorsCutProgram(source, sourceDurationSec) {
  const program = activeDirectorsCutProgram(sourceDurationSec);
  const slices = program.isFull ? null : program.slices;
  const programSegments = mapDirectorsCutToProgram(
    slices,
    source.durations,
    sourceDurationSec,
  );
  if (!programSegments.length) {
    throw new Error(
      `Director’s cut for ${source.id} overlaps no keyframe chunks — adjust the cut or re-slice.`,
    );
  }
  source.programSegments = programSegments;
  source.cutIsFull = program.isFull;
  source.cutSlices = program.slices;
  const trimmed = programSegments.filter((seg) => seg.needsTrim).length;
  if (!program.isFull) {
    log(
      `${source.id} director’s cut: ${program.slices.length} range(s) → ` +
      `${programSegments.length} DCP piece(s) from ${source.chunks.length} chunk(s)` +
      `${trimmed ? `, ${trimmed} boundary trim(s) on fleet` : ''}` +
      ` (${programDuration(program.slices).toFixed(2)}s kept)`,
    );
  }
  return source;
}

async function dispatchGithubRunnerJob({
  owner,
  repo,
  token,
  videoPath,
  branch,
  inputBaseName,
  linkedinAccessToken,
  linkedinAuthorUrn,
  linkedinPostText,
}) {
  const githubClient = window.xframeGithubTranscode;
  if (!githubClient) {
    throw new Error('GitHub transcode client is not loaded.');
  }

  const { compute, wallet } = window.dcp;
  const gh = githubClient.githubConfig(CONFIG);
  const dcpGhRunnerPackage = gh.dcp_package || 'dcp-gh-runner/dcpGhRunner.js';
  const ffmpegPackage = CONFIG.dcp_package || 'ffmpeg-dcp-social-v2/ffmpeg-wasm.js';

  dbg('dispatchGithubRunnerJob start', {
    owner,
    repo,
    videoPath,
    branch,
    dcpGhRunnerPackage,
    ffmpegPackage,
  });
  await ensureIdentity();
  const pay = await wallet.get();
  await wallet.add(pay);
  await fetchAccountBalance(pay);

  const unit = {
    githubToken: token,
    githubOwner: owner,
    githubRepo: repo,
    token,
    owner,
    repo,
    videoPath,
    branch: branch || gh.branch || 'main',
    linkedinAccessToken: linkedinAccessToken || '',
    linkedinAuthorUrn: linkedinAuthorUrn || '',
    linkedinPostText: linkedinPostText || '',
    uploadPrefix: gh.upload_prefix || 'docs/uploads',
    postMetadataPrefix: 'xframe/posts/linkedin',
  };

  async function githubRunnerWork(unitArg) {
    const slice = typeof unitArg === 'string' ? JSON.parse(unitArg) : unitArg;
    const wlog = (...args) => {
      try { console.log('[dcpGhRunner]', ...args); } catch (_) { /* ignore */ }
    };

    progress(0);
    wlog('starting browser JIT listener', {
      owner: slice.githubOwner || slice.owner,
      repo: slice.githubRepo || slice.repo,
      videoPath: slice.videoPath,
      branch: slice.branch,
      linkedInDirect: !!(slice.linkedinAccessToken && slice.linkedinAuthorUrn),
    });

    const { runPipeline } = require('dcp-gh-runner/dcpGhRunner.js');
    const { createFfmpegModule } = require('ffmpeg-dcp-social-v2/ffmpeg-wasm.js');

    return runPipeline({
      github: {
        token: slice.githubToken || slice.token,
        owner: slice.githubOwner || slice.owner,
        repo: slice.githubRepo || slice.repo,
        branch: slice.branch,
      },
      linkedin: {
        accessToken: slice.linkedinAccessToken,
        authorUrn: slice.linkedinAuthorUrn,
        postText: slice.linkedinPostText,
      },
      githubPublish: {
        branch: slice.branch,
        uploadPrefix: slice.uploadPrefix,
        postMetadataPrefix: slice.postMetadataPrefix,
      },
      transcode: { format: 'li_feed' },
      createFfmpegModule,
      progress,
      log: wlog,
    });
  }

  const job = compute.for([unit], githubRunnerWork, []);
  job.requires([dcpGhRunnerPackage, ffmpegPackage]);
  job.computeGroups = getComputeGroups();
  job.public = {
    name: `GitHub runner: ${inputBaseName || videoPath}`,
    description: `JIT self-hosted runner for ${videoPath}`,
  };
  job.greedyEstimation = true;
  job.estimationSlices = 1;

  attachJobDebug(job);

  let lastStatus = null;
  job.on('accepted', () => {
    log(
      `GitHub runner job accepted id=${job.id || '(unknown)'} — waiting for a browser WASM worker.`,
    );
  });
  job.on('status', (ev) => {
    const s = (ev && typeof ev === 'object' && ('distributed' in ev || 'computed' in ev))
      ? ev
      : (job.status || ev || {});
    lastStatus = s;
    const statusEl = el('preprocessingStatus');
    if (statusEl) {
      statusEl.textContent =
        `GitHub runner ${s.runStatus || el('readyStateBadge')?.textContent || '?'} · ` +
        `distributed ${s.distributed ?? '?'}/1 · computed ${s.computed ?? 0}`;
    }
  });
  job.on('nofunds', (ev) => {
    showNofunds(ev);
    showRunError(new Error(
      `Insufficient DCP funds: need ${ev?.fundsRequired ?? '?'} ${CREDIT_SYMBOL} ` +
      `for ${ev?.remainingSlices ?? '?'} remaining slice(s).`,
    ));
  });
  job.on('result', (ev) => {
    log(`GitHub runner slice finished: ${safeJson(ev?.result ?? ev)}`);
  });

  const groupsLabel = (job.computeGroups || []).map((g) => g.joinKey || g).join(', ') || '(default)';
  log(`Dispatching GitHub runner slice for ${videoPath} → groups: ${groupsLabel}`);
  updateCostEstimate(1);

  const t0 = performance.now();
  const heartbeat = setInterval(() => {
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    const st = lastStatus || job.status || {};
    const statusEl = el('preprocessingStatus');
    if (statusEl) {
      statusEl.textContent =
        `GitHub runner ${st.runStatus || el('readyStateBadge')?.textContent || '?'} · ${sec}s · ` +
        `dist ${st.distributed ?? 0}/1 · computed ${st.computed ?? 0}`;
    }
  }, 5000);

  try {
    await job.exec(slicePaymentDcc);
  } finally {
    clearInterval(heartbeat);
  }

  const elapsedSec = (performance.now() - t0) / 1000;
  el('fleetTime').textContent = `${elapsedSec.toFixed(1)}s`;
  log(`GitHub runner job finished in ${elapsedSec.toFixed(1)}s`);
  return job;
}

el('runBtn').addEventListener('click', async () => {
  if (runInProgress) return;
  if (!hasValidApiKey()) {
    showRunError(new Error('Enter a valid DCP identity API key first.'));
    return;
  }
  const deliverables = selectedDeliverables();
  if (!inputBytes || !deliverables.length) return;

  runInProgress = true;
  hideRunError();
  hideNofunds();
  el('runBtn').disabled = true;
  if (el('runGithubBtn')) el('runGithubBtn').disabled = true;
  el('outputsSection').classList.add('hidden');
  el('outputPreview')?.pause();
  el('outputPreviewPanel')?.classList.add('hidden');
  el('fleetBar').style.width = '0%';
  try {
    const uniqueFormats = dedupeFormats(deliverables).map((format) => ({
      ...format,
      sourceId: sourceIdForFormat(format),
    }));
    el('statUnique').textContent = String(uniqueFormats.length);
    el('statAliases').textContent = String(deliverables.length);
    el('preprocessingStatus').classList.remove('hidden');
    el('preprocessingStatus').textContent = 'Slicing source video(s) at keyframes…';
    const targetFrames = CONFIG.dispatch?.target_chunk_frames || 90;
    const usedSourceIds = new Set(uniqueFormats.map((format) => format.sourceId));
    const sourcePlans = [];
    if (usedSourceIds.has('primary')) {
      const primaryDuration = inputSourceDurationSec || inputDurationSec;
      const sliced = await sliceSource('primary', inputBytes, targetFrames);
      sourcePlans.push(attachDirectorsCutProgram(sliced, primaryDuration));
    }
    if (usedSourceIds.has('vertical')) {
      const verticalDuration = verticalSourceDurationSec || verticalInputDurationSec;
      const sliced = await sliceSource('vertical', verticalInputBytes, targetFrames);
      sourcePlans.push(attachDirectorsCutProgram(sliced, verticalDuration));
    }
    for (const source of sourcePlans) {
      const programSecs = Array.isArray(source.programSegments)
        ? source.programSegments.reduce((sum, seg) => sum + (Number(seg.durationSec) || 0), 0)
        : 0;
      const slicedDuration = programSecs > 0
        ? programSecs
        : (Array.isArray(source.durations)
          ? source.durations.reduce((sum, duration) => sum + duration, 0)
          : 0);
      if (slicedDuration > 0) {
        if (source.id === 'vertical') verticalInputDurationSec = slicedDuration;
        else inputDurationSec = slicedDuration;
      }
    }
    const maxDistribution = el('maxDistributionToggle').checked;
    const exactSliceCount = sourcePlans.reduce((total, source) => {
      const formatCount = uniqueFormats.filter((format) => format.sourceId === source.id).length;
      const pieces = source.programSegments?.length || source.chunks.length;
      return total + (maxDistribution ? pieces * formatCount : pieces);
    }, 0);
    updateCostEstimate(exactSliceCount);
    el('preprocessingStatus').textContent = 'Dispatching to DCP…';

    const { bySignature, workerCommentsBySignature } = await dispatchJob(
      sourcePlans,
      uniqueFormats,
      maxDistribution,
      inputBaseName,
    );
    el('preprocessingStatus').textContent = 'Assembling MP4 masters…';
    lastOutputs = await assembleMasters(
      bySignature,
      uniqueFormats,
      deliverables,
      workerCommentsBySignature,
    );
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

el('runGithubBtn')?.addEventListener('click', async () => {
  if (runInProgress || !inputBytes) return;
  const githubClient = window.xframeGithubTranscode;
  if (!githubClient) {
    showRunError(new Error('GitHub transcode client failed to load.'));
    return;
  }

  const creds = await githubClient.openGithubTranscodeDialog(CONFIG, el);
  if (!creds) return;

  if (!hasValidApiKey()) {
    showRunError(new Error('Enter a valid DCP identity API key first.'));
    return;
  }

  runInProgress = true;
  hideRunError();
  hideNofunds();
  el('runBtn').disabled = true;
  el('runGithubBtn').disabled = true;
  el('preprocessingStatus').classList.remove('hidden');
  el('preprocessingStatus').textContent = 'Uploading video to GitHub…';

  try {
    const videoPath = await githubClient.uploadVideoToGithub({
      config: CONFIG,
      token: creds.token,
      owner: creds.owner,
      repo: creds.repo,
      branch: creds.branch,
      bytes: inputBytes,
      baseName: inputBaseName,
    });
    log(`Uploaded ${videoPath} to ${creds.owner}/${creds.repo}`);

    el('preprocessingStatus').textContent = 'Triggering GitHub Actions workflow…';
    await githubClient.dispatchGithubWorkflow({
      config: CONFIG,
      token: creds.token,
      owner: creds.owner,
      repo: creds.repo,
      branch: creds.branch,
      videoPath,
    });
    log(`Workflow dispatched for ${videoPath}`);

    el('preprocessingStatus').textContent = 'Dispatching DCP GitHub runner slice…';
    await dispatchGithubRunnerJob({
      owner: creds.owner,
      repo: creds.repo,
      token: creds.token,
      videoPath,
      branch: creds.branch,
      inputBaseName,
      linkedinAccessToken: creds.linkedinAccessToken,
      linkedinAuthorUrn: creds.linkedinAuthorUrn,
      linkedinPostText: creds.linkedinPostText,
    });
    el('preprocessingStatus').textContent =
      `GitHub path complete — uploaded ${videoPath} and finished runner slice.`;
  } catch (err) {
    log(`GitHub transcode failed: ${err.message || err}`);
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
