#!/usr/bin/env node
/**
 * Publish xframe/package as DCP package ffmpeg-dcp-social-v2.
 *
 * Usage:
 *   node package/publish.js [--apiKey=0x…]
 *
 * Requires package/ffmpeg-wasm.js (from build-bravojs-bundle.js).
 */
'use strict';

const path = require('path');
const fs = require('fs');

function parseArgs(argv) {
  const out = { apiKey: process.env.DCP_API_KEY || '' };
  for (const arg of argv) {
    if (arg.startsWith('--apiKey=')) out.apiKey = arg.slice('--apiKey='.length);
  }
  return out;
}

async function main() {
  const { apiKey } = parseArgs(process.argv.slice(2));
  if (!/^0x[0-9a-fA-F]{64}$/.test(apiKey)) {
    throw new Error('Pass a DCP identity key via --apiKey=0x… or DCP_API_KEY');
  }
  const pkgDir = __dirname;
  const bundlePath = path.join(pkgDir, 'ffmpeg-wasm.js');
  const manifestPath = path.join(pkgDir, 'package.dcp');

  if (!fs.existsSync(bundlePath)) {
    throw new Error('Missing package/ffmpeg-wasm.js — run: node package/build-bravojs-bundle.js');
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Missing package/package.dcp');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`Publishing ${manifest.name}@${manifest.version} (${(fs.statSync(bundlePath).size / (1024 * 1024)).toFixed(1)} MB)…`);

  await require('dcp-client').init('https://scheduler.distributed.computer');
  const identity = require('dcp/identity');
  const { publish } = require('dcp/publish');

  await identity.set(apiKey);
  const result = await publish(manifestPath);
  console.log('Published:', typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err?.message || err);
    if (err?.code) console.error('code:', err.code);
    process.exit(1);
  });
