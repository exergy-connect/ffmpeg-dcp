'use strict';

/**
 * Pure-data prep for the xFrame social transcoder.
 * Builds a DCP inputSet of (chunk|programSegment, formatIndexes) units without touching dcp-client.
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
  if (bytes && bytes.length >= 8 &&
      bytes[4] === 0x66 && bytes[5] === 0x74 &&
      bytes[6] === 0x79 && bytes[7] === 0x70) {
    return 'mp4';
  }
  return 'ts';
}

function extForChunk(bytes, claimed) {
  const sniffed = sniffChunkExt(bytes);
  // Magic wins: a claimed "ts" must not override VP9-in-MP4.
  if (sniffed === 'webm' || sniffed === 'mp4') return sniffed;
  return claimed || sniffed;
}

function pushUnits(inputSet, baseUnit, formatIndexes, maxDistribution) {
  if (maxDistribution) {
    for (const formatIndex of formatIndexes) {
      inputSet.push({ ...baseUnit, formatIndexes: [formatIndex] });
    }
  } else {
    inputSet.push({ ...baseUnit, formatIndexes });
  }
}

onmessage = ({ data }) => {
  if (data.cmd !== 'prepare') return;
  const { maxDistribution } = data;
  const sourceSets = data.sourceSets || [{
    sourceId: 'primary',
    chunks: data.chunks,
    formatIndexes: Array.from({ length: data.formatCount }, (_, index) => index),
    container: data.container,
  }];
  const inputSet = [];
  for (const source of sourceSets) {
    const { sourceId, chunks, formatIndexes, container, programSegments } = source;
    const chunkBase64ByIndex = chunks.map((chunk) => bytesToBase64(chunk));
    const chunkExtByIndex = chunks.map((chunk) => extForChunk(chunk, container));

    if (Array.isArray(programSegments) && programSegments.length) {
      for (const seg of programSegments) {
        const chunkIndex = seg.chunkIndex;
        if (chunkIndex < 0 || chunkIndex >= chunks.length) {
          throw new Error(
            `program segment ${seg.programIndex} references missing chunk ${chunkIndex}`,
          );
        }
        pushUnits(inputSet, {
          sourceId,
          chunkIndex,
          programIndex: seg.programIndex,
          needsTrim: !!seg.needsTrim,
          trimStartSec: Number(seg.trimStartSec) || 0,
          trimEndSec: Number(seg.trimEndSec) || 0,
          chunkBase64: chunkBase64ByIndex[chunkIndex],
          chunkExt: chunkExtByIndex[chunkIndex],
        }, formatIndexes, maxDistribution);
      }
      continue;
    }

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      pushUnits(inputSet, {
        sourceId,
        chunkIndex,
        programIndex: chunkIndex,
        needsTrim: false,
        trimStartSec: 0,
        trimEndSec: 0,
        chunkBase64: chunkBase64ByIndex[chunkIndex],
        chunkExt: chunkExtByIndex[chunkIndex],
      }, formatIndexes, maxDistribution);
    }
  }
  postMessage({ inputSet });
};
