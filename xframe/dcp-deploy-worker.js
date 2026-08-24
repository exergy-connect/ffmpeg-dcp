'use strict';

/**
 * Pure-data prep for the xFrame social transcoder.
 * Builds a DCP inputSet of (chunk, formatIndexes) units without touching dcp-client.
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
  const { chunks, formatCount, maxDistribution } = data;
  const chunkBase64ByIndex = chunks.map((c) => bytesToBase64(c));
  let inputSet;
  if (maxDistribution) {
    inputSet = [];
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      for (let formatIndex = 0; formatIndex < formatCount; formatIndex++) {
        inputSet.push({
          chunkIndex,
          formatIndexes: [formatIndex],
          chunkBase64: chunkBase64ByIndex[chunkIndex],
        });
      }
    }
  } else {
    const allIndexes = Array.from({ length: formatCount }, (_, i) => i);
    inputSet = chunkBase64ByIndex.map((chunkBase64, chunkIndex) => ({
      chunkIndex,
      formatIndexes: allIndexes,
      chunkBase64,
    }));
  }
  postMessage({ inputSet });
};
