'use strict';

/**
 * xFrame browser worker runtime.
 * Simplified dcp.live-style participant page driven by concepts in #app-config.
 * Identity + comment are persisted locally; logs use identity; sandboxes receive
 * dcpWorkerContext.comment as
 * { text: "<identity>: <comment>", language, demoCommentIndex? }.
 */

const CONFIG = JSON.parse(document.getElementById('app-config').textContent);
const el = (id) => document.getElementById(id);

const COMMENT_KEY = CONFIG.comment?.storage_key || 'xframe.worker.comment';
const COMMENT_MAX = Math.max(1, Number(CONFIG.comment?.max_length) || 280);
const IDENTITY_KEY = CONFIG.identity?.storage_key || 'xframe.worker.identity';
const IDENTITY_MAX = Math.max(1, Number(CONFIG.identity?.max_length) || 40);
const IDENTITY_DEFAULT = String(CONFIG.identity?.default || '(anonymous)');
const LANGUAGE_KEY = CONFIG.language?.storage_key || 'xframe.worker.language';
const DEFAULT_LANGUAGE = String(CONFIG.language?.default || 'en-US');
const DEFAULTS = CONFIG.defaults || {};
const DEMO_COMMENTS = Array.isArray(CONFIG.demo_comments) ? CONFIG.demo_comments : [];

let worker = null;
let identityKeystore = null;
let starting = false;
let stopping = false;
let activeSandboxes = 0;
/** @type {null | (() => void)} */
let unpatchWorker = null;
/** Mutable so sandbox creation (after start) sees the resolved worker id. */
const sandboxContextRef = { comment: { text: '', language: DEFAULT_LANGUAGE }, identity: '', workerId: '' };

function log(msg) {
  const logEl = el('log');
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(msg);
}

function getWorkerIdentity() {
  const raw = String(el('workerIdentity').value || '').trim().slice(0, IDENTITY_MAX);
  return raw || IDENTITY_DEFAULT;
}

function getComment() {
  return String(el('workerComment').value || '').trim().slice(0, COMMENT_MAX);
}

/** Platform-facing comment: "<identity>: <comment>". */
function platformComment() {
  return `${getWorkerIdentity()}: ${getComment()}`.slice(0, IDENTITY_MAX + COMMENT_MAX + 2);
}

function standardDemoCommentIndex(comment = getComment()) {
  const normalized = String(comment || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  for (let index = 1; index <= DEMO_COMMENTS.length; index += 1) {
    if (demoCommentByIndex(index)?.quote === normalized) return index;
  }
  return null;
}

function getCommentLanguage() {
  const select = el('workerCommentLanguage');
  return String(select?.value || DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE;
}

/** Platform-facing comment payload for sandbox context and DCP results. */
function platformCommentPayload() {
  const payload = {
    text: platformComment(),
    language: getCommentLanguage(),
  };
  const demoCommentIndex = standardDemoCommentIndex();
  if (demoCommentIndex != null) payload.demoCommentIndex = demoCommentIndex;
  return payload;
}

function saveWorkerFields() {
  try {
    localStorage.setItem(IDENTITY_KEY, getWorkerIdentity());
  } catch (_) { /* ignore */ }
  try {
    localStorage.setItem(COMMENT_KEY, getComment());
  } catch (_) { /* ignore */ }
  try {
    localStorage.setItem(LANGUAGE_KEY, getCommentLanguage());
  } catch (_) { /* ignore */ }
}

function collectSpeechLanguages() {
  if (!('speechSynthesis' in window)) return [DEFAULT_LANGUAGE];
  const langs = new Set();
  for (const voice of speechSynthesis.getVoices()) {
    if (voice.lang) langs.add(voice.lang);
  }
  if (!langs.size) langs.add(DEFAULT_LANGUAGE);
  return [...langs].sort((a, b) => a.localeCompare(b));
}

function resolveLanguageSelection(langs, preferred) {
  const want = String(preferred || DEFAULT_LANGUAGE).trim();
  if (langs.includes(want)) return want;
  const base = want.split(/[-_]/)[0];
  const partial = langs.find((tag) => tag === base || tag.startsWith(`${base}-`) || tag.startsWith(`${base}_`));
  return partial || langs[0] || DEFAULT_LANGUAGE;
}

function populateLanguageSelect(preferred) {
  const select = el('workerCommentLanguage');
  if (!select) return;
  const langs = collectSpeechLanguages();
  const selected = resolveLanguageSelection(langs, preferred);
  select.innerHTML = '';
  for (const lang of langs) {
    const option = document.createElement('option');
    option.value = lang;
    option.textContent = lang;
    if (lang === selected) option.selected = true;
    select.appendChild(option);
  }
}

function loadCommentLanguage(params) {
  const fromUrl = params.get('language');
  if (fromUrl != null && String(fromUrl).trim()) {
    populateLanguageSelect(String(fromUrl).trim());
    return;
  }
  let saved = DEFAULT_LANGUAGE;
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY);
    if (stored != null && String(stored).trim()) saved = String(stored).trim();
  } catch (_) { /* ignore */ }
  populateLanguageSelect(saved);
}

function demoCommentByIndex(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > DEMO_COMMENTS.length) return null;
  const entry = DEMO_COMMENTS[n - 1];
  if (!entry || entry.quote == null) return null;
  return {
    index: n,
    title: String(entry.title || '').trim(),
    quote: String(entry.quote).replace(/\s+/g, ' ').trim().slice(0, COMMENT_MAX),
  };
}

function setDemoHint(text) {
  const hint = el('demoCommentHint');
  if (!hint) return;
  hint.textContent = text || '';
}

function loadWorkerFields() {
  const params = queryParams();
  loadCommentLanguage(params);

  const identityFromUrl = params.get('identity');
  if (identityFromUrl != null) {
    el('workerIdentity').value = String(identityFromUrl).trim().slice(0, IDENTITY_MAX) || IDENTITY_DEFAULT;
  } else {
    try {
      const savedId = localStorage.getItem(IDENTITY_KEY);
      el('workerIdentity').value = savedId != null && String(savedId).trim()
        ? String(savedId).trim().slice(0, IDENTITY_MAX)
        : IDENTITY_DEFAULT;
    } catch (_) {
      el('workerIdentity').value = IDENTITY_DEFAULT;
    }
  }

  const demo = demoCommentByIndex(params.get('demoCommentIndex'));
  if (demo) {
    el('workerComment').value = demo.quote;
    setDemoHint(`Demo ${demo.index}/4 · ${demo.title}`);
    saveWorkerFields();
    return;
  }
  setDemoHint('');
  const fromUrl = params.get('comment') ?? params.get('workerComment');
  if (fromUrl != null) {
    el('workerComment').value = String(fromUrl).trim().slice(0, COMMENT_MAX);
    saveWorkerFields();
    return;
  }
  try {
    const saved = localStorage.getItem(COMMENT_KEY);
    if (saved != null) el('workerComment').value = String(saved).slice(0, COMMENT_MAX);
  } catch (_) { /* ignore */ }
}

function labelPrefix() {
  const identity = getWorkerIdentity();
  const id = worker?.id || identityKeystore?.address || '—';
  return `[${identity} · ${id}]`;
}

function diag(msg, detail) {
  let text = `${labelPrefix()} ${msg}`;
  if (detail !== undefined) {
    try {
      text += ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    } catch (_) {
      text += ` ${String(detail)}`;
    }
  }
  log(text);
}

function setStatus(state, label) {
  const pill = el('statusPill');
  pill.dataset.state = state;
  pill.textContent = label;
  const btn = el('toggleBtn');
  const lockFields = state === 'running' || state === 'starting' || state === 'stopping';
  el('workerComment').disabled = lockFields;
  el('workerIdentity').disabled = lockFields;
  const langSelect = el('workerCommentLanguage');
  if (langSelect) langSelect.disabled = lockFields;
  if (state === 'running') {
    btn.textContent = 'Stop';
    btn.classList.remove('primary');
    btn.classList.add('stop');
    btn.disabled = false;
  } else if (state === 'starting' || state === 'stopping') {
    btn.disabled = true;
  } else {
    btn.textContent = 'Start';
    btn.classList.add('primary');
    btn.classList.remove('stop');
    btn.disabled = false;
  }
}

function updateSandboxCount() {
  el('sandboxCount').textContent = String(Math.max(0, activeSandboxes));
}

function queryParams() {
  return new URLSearchParams(window.location.search);
}

/**
 * DCP's BrowserEvaluator is invoked as `new SandboxConstructor({ name })` and
 * itself does `new Worker(blobURL)` where the blob is `importScripts(...sandbox…)`.
 *
 * Browser sandboxes later run access-lists on `applyRequirements`, which replaces
 * every non-allowlisted configurable global with a getter that returns undefined.
 * Defining `dcpWorkerContext` as non-configurable makes that pass skip our value.
 * We also attach the same payload onto allowlisted `self.work` when bootstrap
 * assigns it, as a second channel the work function can read.
 */
function patchWorkerForContext(contextRef) {
  if (unpatchWorker) unpatchWorker();
  const RealWorker = window.Worker;

  function ContextInjectingWorker(scriptURL, options) {
    const payload = contextRef.comment && typeof contextRef.comment === 'object'
      ? contextRef.comment
      : { text: String(contextRef.comment || ''), language: DEFAULT_LANGUAGE };
    const ctx = {
      identity: String(contextRef.identity || IDENTITY_DEFAULT).slice(0, IDENTITY_MAX),
      comment: {
        text: String(payload.text || '').slice(0, IDENTITY_MAX + COMMENT_MAX + 2),
        language: String(payload.language || DEFAULT_LANGUAGE).slice(0, 35),
        ...(Number.isInteger(payload.demoCommentIndex)
          ? { demoCommentIndex: payload.demoCommentIndex }
          : {}),
      },
      workerId: String(contextRef.workerId || ''),
    };
    // Always importScripts an absolute URL. Relative sandbox paths like
    // "src/…" resolve against the page (GitHub Pages) inside a blob worker and
    // make BravoJS treat package loads as /packages/src/package.dcp.
    let absoluteScriptURL;
    try {
      absoluteScriptURL = new URL(String(scriptURL), window.location.href).href;
    } catch (_) {
      absoluteScriptURL = String(scriptURL);
    }
    const code = `
(function (ctx, scriptURL) {
  var realDefineProperty = Object.defineProperty;
  function installContext() {
    try {
      realDefineProperty(self, 'dcpWorkerContext', {
        value: ctx,
        writable: false,
        enumerable: true,
        configurable: false
      });
    } catch (e1) {
      try { self.dcpWorkerContext = ctx; } catch (e2) {}
    }
    // Hang ctx on allowlisted callables — access-lists leave these alone.
    try { if (typeof self.progress === 'function') self.progress.xframeContext = ctx; } catch (e3) {}
    try { if (typeof self.require === 'function') self.require.xframeContext = ctx; } catch (e4) {}
    try {
      if (self.work && typeof self.work === 'object') self.work.xframeContext = ctx;
    } catch (e5) {}
  }
  Object.defineProperty = function (obj, prop, desc) {
    if (prop === 'dcpWorkerContext' && obj && (obj === self || obj === globalThis)) {
      return realDefineProperty(obj, prop, {
        configurable: false,
        enumerable: true,
        get: function () { return ctx; },
        set: function () {}
      });
    }
    return realDefineProperty(obj, prop, desc);
  };
  var workValue;
  try {
    realDefineProperty(self, 'work', {
      configurable: true,
      enumerable: true,
      get: function () { return workValue; },
      set: function (value) {
        workValue = value;
        if (value && typeof value === 'object') {
          try {
            realDefineProperty(value, 'xframeContext', {
              value: ctx,
              writable: false,
              enumerable: true,
              configurable: false
            });
          } catch (e6) {
            try { value.xframeContext = ctx; } catch (e7) {}
          }
        }
      }
    });
  } catch (e8) {}
  // Re-apply after every inbound message (incl. applyRequirements).
  try {
    var realAdd = self.addEventListener.bind(self);
    self.addEventListener = function (type, listener, options) {
      if (type !== 'message' || typeof listener !== 'function') {
        return realAdd(type, listener, options);
      }
      return realAdd(type, function (event) {
        var ret = listener.apply(this, arguments);
        installContext();
        return ret;
      }, options);
    };
  } catch (e9) {}
  installContext();
  importScripts(scriptURL);
  installContext();
})(${JSON.stringify(ctx)}, ${JSON.stringify(absoluteScriptURL)});
`;
    const blobURL = URL.createObjectURL(
      new Blob([code], { type: 'application/javascript' }),
    );
    const w = new RealWorker(blobURL, options);
    const terminate = w.terminate.bind(w);
    w.terminate = function terminateInjectingWorker() {
      try { URL.revokeObjectURL(blobURL); } catch (_) { /* ignore */ }
      return terminate();
    };
    return w;
  }
  ContextInjectingWorker.prototype = RealWorker.prototype;

  window.Worker = ContextInjectingWorker;
  unpatchWorker = () => {
    if (window.Worker === ContextInjectingWorker) window.Worker = RealWorker;
    unpatchWorker = null;
  };
  return unpatchWorker;
}

function describeWorkerError(err) {
  if (err == null) return String(err);
  if (typeof err === 'string') return err;
  if (err instanceof ErrorEvent || (err && err.isTrusted != null && 'filename' in err)) {
    return {
      message: err.message || '(empty — often a worker script load failure)',
      filename: err.filename || undefined,
      lineno: err.lineno || undefined,
      colno: err.colno || undefined,
      type: err.type || undefined,
    };
  }
  return err.message || err;
}

function parseJobIds(raw) {
  if (raw == null || String(raw).trim() === '') return false;
  const ids = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? ids : false;
}

function parseComputeGroups(raw, fallback) {
  if (raw == null || String(raw).trim() === '') {
    return Array.isArray(fallback) ? fallback.map((g) => ({ ...g })) : [];
  }
  const value = String(raw).trim();
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((g) => g && g.joinKey != null)
          .map((g) => ({ joinKey: String(g.joinKey), joinSecret: String(g.joinSecret || '') }));
      }
    } catch (_) {
      /* fall through to pair form / default */
    }
    return Array.isArray(fallback) ? fallback.map((g) => ({ ...g })) : [];
  }
  const comma = value.indexOf(',');
  if (comma < 0) {
    return Array.isArray(fallback) ? fallback.map((g) => ({ ...g })) : [];
  }
  return [{
    joinKey: value.slice(0, comma).trim(),
    joinSecret: value.slice(comma + 1).trim(),
  }];
}

function parseLeavePublicGroup(raw, fallback) {
  if (raw == null || raw === '') return Boolean(fallback);
  return String(raw) !== 'false';
}

function parseMaxSandboxes(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1) return n;
  const d = Number(fallback);
  return Number.isFinite(d) && d >= 1 ? d : 2;
}

function buildWorkerConfig() {
  const params = queryParams();
  const paymentAddress = params.get('paymentAddress')
    || DEFAULTS.payment_address
    || '';
  const jobIds = parseJobIds(params.get('jobIds'));
  const computeGroups = parseComputeGroups(
    params.get('computeGroups'),
    DEFAULTS.compute_groups || [],
  );
  const leavePublicGroup = parseLeavePublicGroup(
    params.get('leavePublicGroup'),
    DEFAULTS.leave_public_group !== false,
  );
  const maxSandboxes = parseMaxSandboxes(
    params.get('maxSandboxes'),
    DEFAULTS.max_sandboxes,
  );

  const config = {
    paymentAddress,
    leavePublicGroup,
    maxSandboxes,
  };
  if (computeGroups.length) config.computeGroups = computeGroups;
  if (jobIds) config.jobIds = jobIds;
  return config;
}

function formatGroups(config) {
  if (config.leavePublicGroup === false && !(config.computeGroups || []).length) {
    return 'public';
  }
  const keys = (config.computeGroups || []).map((g) => g.joinKey).filter(Boolean);
  if (!keys.length) return config.leavePublicGroup ? '(none)' : 'public';
  return keys.join(', ') + (config.leavePublicGroup ? '' : ' · public');
}

function paintConfig(config) {
  el('paymentAddress').textContent = String(config.paymentAddress || '—');
  el('computeGroups').textContent = formatGroups(config);
  el('jobIds').textContent = Array.isArray(config.jobIds)
    ? config.jobIds.join(', ')
    : 'any';
}

function attachSandboxListeners(sandbox) {
  const sid = sandbox?.id ?? '?';

  sandbox.on('ready', () => {
    diag(`sandbox ${sid} ready`);
  });

  sandbox.on('job', (jobInfo) => {
    const jobId = jobInfo?.id || jobInfo?.address || jobInfo?.jobAddress || '?';
    const name = jobInfo?.name || jobInfo?.public?.name || '';
    diag(`sandbox ${sid} job`, { jobId, name });
  });

  sandbox.on('slice', (sliceNumber) => {
    activeSandboxes = Math.max(activeSandboxes, 1);
    updateSandboxCount();
    diag(`sandbox ${sid} slice start`, { slice: sliceNumber });
  });

  sandbox.on('progress', (value) => {
    const n = Number(value);
    // SandboxHandle progress is typically 0–100; undefined means indeterminate.
    if (Number.isFinite(n)) diag(`sandbox ${sid} progress`, `${n.toFixed(1)}%`);
    else diag(`sandbox ${sid} progress`);
  });

  sandbox.on('metrics', (slice, m) => {
    diag(`sandbox ${sid} metrics`, {
      slice,
      elapsed: m?.elapsed,
      CPU: m?.CPU,
      GPU: m?.GPU,
    });
  });

  sandbox.on('sliceEnd', (sliceNumber) => {
    diag(`sandbox ${sid} slice end`, { slice: sliceNumber });
  });

  sandbox.on('payment', (payment, paymentAccount, sliceNumber) => {
    diag(`sandbox ${sid} payment`, {
      payment,
      paymentAccount,
      slice: sliceNumber,
    });
  });

  sandbox.on('end', () => {
    activeSandboxes = Math.max(0, activeSandboxes - 1);
    updateSandboxCount();
    diag(`sandbox ${sid} ended`);
  });
}

function attachWorkerListeners(w) {
  w.on('connect', (url) => diag('connected', url));
  w.on('disconnect', (url) => diag('disconnected', url));
  w.on('warning', (warn) => diag('warning', warn));
  w.on('error', (err) => {
    diag('error', describeWorkerError(err));
    setStatus('error', 'Error');
  });

  w.on('fetch', (ev) => {
    const jobs = ev?.jobs || {};
    const ids = Object.keys(jobs);
    if (!ids.length) {
      diag('fetch: no work');
      return;
    }
    for (const jobId of ids) {
      const job = jobs[jobId] || {};
      diag('fetch', {
        jobId,
        name: job.name,
        slices: ev?.slices?.[jobId] ?? '?',
      });
    }
  });

  w.on('result', (urlOrError, size, jobAddress, sliceNumber) => {
    if (urlOrError instanceof Error) {
      diag('result error', {
        message: urlOrError.message,
        jobAddress,
        slice: sliceNumber,
      });
      return;
    }
    diag('result sent', {
      bytes: size,
      jobAddress,
      slice: sliceNumber,
      url: urlOrError || 'scheduler',
    });
  });

  w.on('payment', (payment, paymentAccount, jobAddress, slice) => {
    diag('payment', { payment, paymentAccount, jobAddress, slice });
  });

  w.on('sandbox', (sandbox) => {
    activeSandboxes += 1;
    updateSandboxCount();
    diag(`sandbox created ${sandbox?.id ?? '?'}`);
    attachSandboxListeners(sandbox);
  });

  w.on('stop', () => diag('stop requested'));
  w.on('end', () => {
    worker = null;
    activeSandboxes = 0;
    updateSandboxCount();
    if (unpatchWorker) unpatchWorker();
    setStatus('idle', 'Idle');
    stopping = false;
    diag('worker fully stopped');
  });
}

async function ensureIdentity() {
  if (identityKeystore) return identityKeystore;
  const { wallet, identity } = window.dcp;
  identityKeystore = await new wallet.Keystore(null, '');
  await identity.set(identityKeystore);
  return identityKeystore;
}

async function startWorker() {
  if (worker || starting || stopping) return;
  starting = true;
  saveWorkerFields();
  setStatus('starting', 'Starting…');
  try {
    if (!window.dcp?.worker?.DistributiveWorker) {
      throw new Error('dcp.worker.DistributiveWorker is not available yet.');
    }
    await ensureIdentity();
    const config = buildWorkerConfig();
    if (!config.paymentAddress) {
      throw new Error('paymentAddress is required (set via URL or app defaults).');
    }
    paintConfig(config);
    sandboxContextRef.identity = getWorkerIdentity();
    sandboxContextRef.comment = platformCommentPayload();
    sandboxContextRef.workerId = '';
    patchWorkerForContext(sandboxContextRef);
    worker = new window.dcp.worker.DistributiveWorker(config);
    // Force lazy id allocation so logs include a stable opaque worker id.
    const workerId = worker.id;
    sandboxContextRef.workerId = String(workerId || '');
    el('workerId').textContent = String(workerId || identityKeystore.address || '—');
    attachWorkerListeners(worker);
    await worker.start();
    setStatus('running', 'Running');
    diag('worker started', {
      identity: getWorkerIdentity(),
      comment: getComment() || '(none)',
      language: getCommentLanguage(),
      platformComment: platformCommentPayload(),
      demoCommentIndex: demoCommentByIndex(queryParams().get('demoCommentIndex'))?.index || false,
      paymentAddress: String(config.paymentAddress),
      maxSandboxes: config.maxSandboxes,
      leavePublicGroup: config.leavePublicGroup,
      jobIds: config.jobIds || false,
      commentInjected: true,
    });
  } catch (err) {
    worker = null;
    if (unpatchWorker) unpatchWorker();
    setStatus('error', 'Error');
    log(`Start failed: ${err?.message || err}`);
  } finally {
    starting = false;
  }
}

async function stopWorker() {
  if (!worker || stopping) return;
  stopping = true;
  setStatus('stopping', 'Stopping…');
  try {
    await worker.stop(false);
  } catch (err) {
    stopping = false;
    setStatus('error', 'Error');
    diag('stop failed', err?.message || err);
  }
}

el('toggleBtn').addEventListener('click', () => {
  if (worker) stopWorker();
  else startWorker();
});

el('workerIdentity').addEventListener('change', saveWorkerFields);
el('workerIdentity').addEventListener('blur', saveWorkerFields);
el('workerComment').addEventListener('change', saveWorkerFields);
el('workerComment').addEventListener('blur', saveWorkerFields);
el('workerCommentLanguage').addEventListener('change', saveWorkerFields);

if ('speechSynthesis' in window) {
  speechSynthesis.addEventListener('voiceschanged', () => {
    populateLanguageSelect(getCommentLanguage());
  });
}

loadWorkerFields();
paintConfig(buildWorkerConfig());
setStatus('idle', 'Idle');
updateSandboxCount();
log('Ready.');
