/**
 * @file        build-bravojs-bundle.js
 * @description Bundles the single-threaded dcp-transcode glue + WASM into bravojs
 *              for DCP package `ffmpeg-dcp-social-v2`.
 * @usage       node build-bravojs-bundle.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'ffmpeg-wasm');
const gluePath = path.join(SRC_DIR, 'dcp-transcode-glue.js');
const wasmPath = path.join(SRC_DIR, 'dcp-transcode.wasm');
if (!fs.existsSync(gluePath) || !fs.existsSync(wasmPath)) {
  throw new Error('Missing custom WASM artifacts. Run: bash ffmpeg-wasm/build.sh');
}
const glueSrc = fs.readFileSync(gluePath, 'utf8');
const wasmBytes = fs.readFileSync(wasmPath);
const wasmBase64 = wasmBytes.toString('base64');

const bundle = `/**
 * @file        ffmpeg-wasm.js (published bundle for ffmpeg-dcp-social-v2)
 * @description Embedded single-threaded dcp-transcode WASM API.
 * @usage       job.requires(['ffmpeg-dcp-social-v2/ffmpeg-wasm.js']);
 *              const { createFfmpegModule } = require('ffmpeg-wasm.js');
 */
module.declare([], function (require, exports, module) {
  var moduleShim = { exports: {} };
  (function (module, exports) {
${glueSrc}
  })(moduleShim, moduleShim.exports);
  var createFfmpegModuleRaw = moduleShim.exports;

  var wasmBase64 = "${wasmBase64}";

  function createFfmpegModule(moduleArg) {
    moduleArg = moduleArg || {};
    if (!moduleArg.instantiateWasm) {
      var wasmBytes = Uint8Array.from(atob(wasmBase64), function (c) { return c.charCodeAt(0); });
      moduleArg.instantiateWasm = function (imports, successCallback) {
        WebAssembly.instantiate(wasmBytes, imports).then(function (result) {
          successCallback(result.instance, result.module);
        });
      };
    }
    return createFfmpegModuleRaw(moduleArg);
  }

  exports.createFfmpegModule = createFfmpegModule;
  exports.default = createFfmpegModule;
});
`;

const outPath = path.join(__dirname, 'ffmpeg-wasm.js');
fs.writeFileSync(outPath, bundle);
console.log(`wrote ${outPath} (${(bundle.length / (1024 * 1024)).toFixed(1)} MB)`);
