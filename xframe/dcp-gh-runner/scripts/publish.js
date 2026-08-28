#!/usr/bin/env node
'use strict';

/**
 * Optional: register dcp-gh-runner globally via deployPackage.
 * Transcoder jobs already attach the bundle through job.requires — publish is not required.
 */

const path = require('path');
const fs = require('fs');

async function main() {
  const { apiKey } = (() => {
    const out = { apiKey: process.env.DCP_API_KEY || '' };
    for (const arg of process.argv.slice(2)) {
      if (arg.startsWith('--apiKey=')) out.apiKey = arg.slice('--apiKey='.length);
    }
    return out;
  })();

  if (!/^0x[0-9a-fA-F]{64}$/.test(apiKey)) {
    throw new Error('Pass a DCP identity key via --apiKey=0x… or DCP_API_KEY');
  }

  const pkgDir = path.join(__dirname, '..');
  const bundlePath = path.join(pkgDir, 'dcpGhRunner.js');
  const manifestPath = path.join(pkgDir, 'package.dcp');
  if (!fs.existsSync(bundlePath)) {
    throw new Error('Missing dcpGhRunner.js — run: npm run build');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`Publishing ${manifest.name}@${manifest.version} (${(fs.statSync(bundlePath).size / 1024).toFixed(1)} KB)…`);

  await require('dcp-client').init('https://scheduler.distributed.computer');
  const identity = require('dcp/identity');
  const { publish } = require('dcp/publish');
  await identity.set(apiKey);
  const result = await publish(manifestPath);
  console.log('Published:', typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
