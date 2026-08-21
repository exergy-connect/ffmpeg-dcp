'use strict';

/**
 * dcp-deploy-worker.js
 *
 * Pure-data prep offloaded from the main thread: base64-encodes each raw
 * chunk and assembles the inputSet DCP will dispatch, then hands it back
 * via postMessage. That's it -- no dcp-client here.
 *
 * dcp-client cannot run inside a Worker: its loader does document.write()
 * to inject dcp-config.js, and its wallet-picker UI does direct DOM
 * manipulation, neither of which exist in a WorkerGlobalScope (no
 * document/window, only self). Confirmed directly (2026-08-20): importing
 * it via importScripts() here used to fail every time -- the script's own
 * early code (console banner) ran fine, then it threw partway through
 * once it touched `document`, and Chromium reported that as a generic
 * "importScripts ... failed to load" NetworkError rather than the real
 * ReferenceError, which is what made this look like a network/CORS
 * problem at first. identity.set()/wallet.get()/compute.for()/job.exec()
 * all live in app.js now, on the main thread, where dcp-client already
 * loads via a normal <script> tag.
 */

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

onmessage = ({ data }) => {
  if (data.cmd !== 'prepare') return;
  const { chunks, renditionGroups, maxDistribution } = data;

  let inputSet;
  if (maxDistribution) {
    const chunkBase64ByIndex = chunks.map((c) => bytesToBase64(c));
    inputSet = [];
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      for (const renditionIndexes of renditionGroups) {
        inputSet.push({ chunkIndex, renditionIndexes, chunkBase64: chunkBase64ByIndex[chunkIndex] });
      }
    }
  } else {
    inputSet = chunks.map((c, chunkIndex) => ({ chunkIndex, chunkBase64: bytesToBase64(c) }));
  }

  postMessage({ inputSet });
};
