'use strict';

/**
 * Build output/dcp-transcoding.html from the xForm compile tree + HTML shell.
 * Usage: node scripts/build-html.js
 * (run after: node …/xform.min.js dcp-transcoding.xp)
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outputDir = path.join(root, 'output');
const treePath = path.join(outputDir, 'dcp-transcoding.json');
const templatePath = path.join(root, 'templates', '_final', 'html.xpt');
const outPath = path.join(outputDir, 'dcp-transcoding.html');

function deepGet(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function unwrap(value) {
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, '_payload')) return unwrap(value._payload);
    if (Object.prototype.hasOwnProperty.call(value, '_value')) return unwrap(value._value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '_concept' || k === '_id' || k === '_attributes' || k === '_content' ||
          k === '_raw' || k === '_provenance') continue;
      out[k] = unwrap(v);
    }
    return out;
  }
  return value;
}

function resolveFormatRefs(platforms, formats) {
  const out = structuredClone(platforms);
  for (const p of Object.values(out)) {
    for (const pl of Object.values(p.placements || {})) {
      if (pl.format && typeof pl.format === 'object' && pl.format.width) continue;
      const match = Object.values(formats).find((f) => f && f.id === pl.id);
      if (match) pl.format = match;
    }
  }
  return out;
}

const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
const concepts = tree._concepts || tree.concepts || tree;
const formats = unwrap(concepts.formats || {});
const platforms = resolveFormatRefs(unwrap(concepts.platforms || {}), formats);
const app = unwrap(concepts.app || {});
const input = unwrap(concepts.input || {});
const timing = unwrap(deepGet(concepts, 'timing.social_default') || concepts.timing || {});
const color = unwrap(deepGet(concepts, 'color.sdr_bt709') || concepts.color || {});
const framing = unwrap(concepts.framing || {});
const dispatch = unwrap(concepts.dispatch || {});

const config = {
  title: app.title,
  tagline: app.tagline,
  defaultFraming: app.default_framing || 'cover',
  runtimeScript: app.runtime_script || 'dcp-transcoding.js',
  workerScript: app.worker_script || 'ffmpeg-worker.js',
  deployWorkerScript: app.deploy_worker_script || 'dcp-deploy-worker.js',
  wasmGlue: app.wasm_glue,
  wasmBinary: app.wasm_binary,
  dcpPackage: app.dcp_package || 'ffmpeg-wasm-social/ffmpeg-wasm.js',
  input,
  timing,
  color,
  framing,
  dispatch,
  platforms,
  formats,
};

function buildStamp() {
  const now = new Date();
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  let rev = '';
  try {
    rev = require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch { /* not a git checkout */ }
  return rev ? `${iso} · ${rev}` : iso;
}

const stamp = buildStamp();
config.build = { stamp, builtAt: stamp };

let tpl = fs.readFileSync(templatePath, 'utf8');
if (tpl.startsWith('---')) {
  const end = tpl.indexOf('\n---', 3);
  if (end >= 0) {
    tpl = tpl.slice(end + 4);
    if (tpl.startsWith('\n===\n')) tpl = tpl.slice(5);
    else if (tpl.startsWith('===\n')) tpl = tpl.slice(4);
  }
}

tpl = tpl
  .replace(/\{\{\s*app\.title[^}]*\}\}/g, app.title || 'DCP Social Media Transcoder')
  .replace(/\{\{\s*app\.tagline[^}]*\}\}/g, app.tagline || '')
  .replace(/\{\{\s*build\.stamp\s*\}\}/g, stamp)
  .replace(/\{\{[\s\S]*?\|\s*tojson\s*\}\}/, JSON.stringify(config, null, 2));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, tpl);

function stageAsset(sourcePath, outputRelativePath, { allowMissing = false } = {}) {
  if (!fs.existsSync(sourcePath)) {
    if (allowMissing) {
      console.warn(`Missing optional build artifact: ${sourcePath}`);
      return;
    }
    throw new Error(`Missing runtime asset: ${sourcePath}`);
  }
  const destination = path.join(outputDir, outputRelativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(sourcePath, destination);
}

stageAsset(path.join(root, app.runtime_script || 'dcp-transcoding.js'), config.runtimeScript);
stageAsset(path.join(root, app.worker_script || 'ffmpeg-worker.js'), config.workerScript);
stageAsset(path.join(root, app.deploy_worker_script || 'dcp-deploy-worker.js'), config.deployWorkerScript);
stageAsset(path.join(root, 'exergy_connect_logo.png'), 'exergy_connect_logo.png');
stageAsset(path.join(root, '..', 'favicon.ico'), 'favicon.ico');

const allowMissingWasm = process.env.ALLOW_MISSING_WASM === '1';
stageAsset(path.join(root, app.wasm_glue), config.wasmGlue, { allowMissing: allowMissingWasm });
stageAsset(path.join(root, app.wasm_binary), config.wasmBinary, { allowMissing: allowMissingWasm });

console.log(`Wrote ${outPath} (${tpl.length} bytes)`);
console.log(`Staged browser runtime under ${outputDir}`);
console.log(`Platforms: ${Object.keys(platforms).join(', ')}`);
const ig = platforms.instagram?.placements?.feed?.format?.signature;
const fb = platforms.facebook?.placements?.feed?.format?.signature;
console.log(`IG/FB feed signatures equal: ${ig === fb} (${ig})`);
