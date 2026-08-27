'use strict';

/**
 * Stage browser assets next to the xForm --final html output.
 * Runtime JSON is {{ app | _resolve(unwrap=true) | to_json }} in html.xpt.
 *
 * Usage:
 *   node scripts/build-html.js                 # dcp-transcoding (default)
 *   node scripts/build-html.js worker          # worker page
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outputDir = path.join(root, 'output');
const basename = process.argv[2] || 'dcp-transcoding';
const treePath = path.join(outputDir, `${basename}.json`);
const outPath = path.join(outputDir, `${basename}.html`);

if (!fs.existsSync(outPath)) {
  throw new Error(`Missing ${outPath}; compile with --final html first`);
}
if (!fs.existsSync(treePath)) {
  throw new Error(`Missing ${treePath}; compile with --tree first`);
}

const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
const concepts = tree._concepts || tree.concepts || tree;
const app = concepts.app || {};

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

let html = fs.readFileSync(outPath, 'utf8');
html = html.replace(
  /(<p class="build-stamp"[^>]*>)[\s\S]*?(<\/p>)/,
  `$1${buildStamp()}$2`,
);
fs.writeFileSync(outPath, html);

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

if (basename === 'worker') {
  const runtimeScript = app.runtime_script || 'worker.js';
  stageAsset(path.join(root, runtimeScript), runtimeScript);
  stageAsset(path.join(root, 'exergy_connect_logo.png'), 'exergy_connect_logo.png');
  stageAsset(path.join(root, '..', 'favicon.ico'), 'favicon.ico');
  console.log(`Wrote ${outPath} (${html.length} bytes)`);
  console.log(`Staged worker runtime under ${outputDir}`);
  process.exit(0);
}

const runtimeScript = app.runtime_script || 'dcp-transcoding.js';
stageAsset(path.join(root, runtimeScript), runtimeScript);
stageAsset(path.join(root, app.bank_script || 'dcp-bank-account.js'), app.bank_script || 'dcp-bank-account.js');
stageAsset(path.join(root, app.worker_script || 'ffmpeg-worker.js'), app.worker_script || 'ffmpeg-worker.js');
stageAsset(path.join(root, app.deploy_worker_script || 'dcp-deploy-worker.js'), app.deploy_worker_script || 'dcp-deploy-worker.js');
stageAsset(path.join(root, 'exergy_connect_logo.png'), 'exergy_connect_logo.png');
stageAsset(path.join(root, '..', 'favicon.ico'), 'favicon.ico');

const wasmGlue = path.join(root, app.wasm_glue || 'ffmpeg-wasm/dcp-transcode-glue.js');
const wasmBinary = path.join(root, app.wasm_binary || 'ffmpeg-wasm/dcp-transcode.wasm');
const allowMissingWasm = process.env.ALLOW_MISSING_WASM === '1';
if (!fs.existsSync(wasmGlue) || !fs.existsSync(wasmBinary)) {
  const msg = `Missing canonical WASM under xframe/ffmpeg-wasm/ (${wasmGlue}, ${wasmBinary})`;
  if (allowMissingWasm) console.warn(msg);
  else throw new Error(msg);
} else {
  console.log(`Using checked-in WASM: ${path.relative(root, wasmBinary)}`);
}

const stagedWasmDir = path.join(outputDir, 'ffmpeg-wasm');
if (fs.existsSync(stagedWasmDir)) {
  fs.rmSync(stagedWasmDir, { recursive: true, force: true });
  console.log('Removed staged output/ffmpeg-wasm/ (use xframe/ffmpeg-wasm/ instead)');
}

console.log(`Wrote ${outPath} (${html.length} bytes)`);
console.log(`Staged browser runtime under ${outputDir}`);
