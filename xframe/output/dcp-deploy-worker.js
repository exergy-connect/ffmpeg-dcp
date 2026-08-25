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

function sniffChunkExt(bytes) {
  if (bytes && bytes.length >= 4 &&
      bytes[0] === 0x1a && bytes[1] === 0x45 &&
      bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'webm';
  }
  return 'ts';
}

onmessage = ({ data }) => {
  if (data.cmd !== 'prepare') return;
  const { chunks, formatCount, maxDistribution, container } = data;
  const chunkBase64ByIndex = chunks.map((c) => bytesToBase64(c));
  const chunkExtByIndex = chunks.map((c) => container || sniffChunkExt(c));
  let inputSet;
  if (maxDistribution) {
    inputSet = [];
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      for (let formatIndex = 0; formatIndex < formatCount; formatIndex++) {
        inputSet.push({
          chunkIndex,
          formatIndexes: [formatIndex],
          chunkBase64: chunkBase64ByIndex[chunkIndex],
          chunkExt: chunkExtByIndex[chunkIndex],
        });
      }
    }
  } else {
    const allIndexes = Array.from({ length: formatCount }, (_, i) => i);
    inputSet = chunkBase64ByIndex.map((chunkBase64, chunkIndex) => ({
      chunkIndex,
      formatIndexes: allIndexes,
      chunkBase64,
      chunkExt: chunkExtByIndex[chunkIndex],
    }));
  }
  postMessage({ inputSet });
};
