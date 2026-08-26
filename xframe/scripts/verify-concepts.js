'use strict';

/** Lightweight checks over the compiled concept tree + HTML config. */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const tree = JSON.parse(fs.readFileSync(path.join(root, 'output', 'dcp-transcoding.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'output', 'dcp-transcoding.html'), 'utf8');
const concepts = tree._concepts;
const cfg = JSON.parse(html.match(/id="app-config"[^>]*>([\s\S]*?)<\/script>/)[1]);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(Object.keys(cfg.platforms).length === 5, 'expected 5 platforms');
assert(
  cfg.platforms.instagram.placements.feed.format.signature ===
    cfg.platforms.facebook.placements.feed.format.signature,
  'IG/FB feed signatures must match',
);
assert(
  cfg.platforms.instagram.placements.reels.format.signature ===
    cfg.platforms.facebook.placements.reels.format.signature,
  'IG/FB reels signatures must match',
);
assert(cfg.platforms.youtube.placements.feed.format.width === 1920, 'yt feed width');
assert(cfg.timing.social_default.output_fps === 30, '30 fps');
assert(cfg.dispatch.dedupe_identical_formats === true, 'dedupe enabled');
assert(cfg.dcp_package === 'ffmpeg-dcp-social/ffmpeg-wasm.js', 'distinct package name');
assert(cfg.bank?.operation === 'viewAccount', 'bank.operation must be viewAccount');
assert(cfg.bank?.balance_field === 'payload.balance', 'bank.balance_field must be payload.balance');
assert(html.includes('dcp-bank-account.js'), 'HTML must load dcp-bank-account.js');

// Dedupe simulation
const selected = [
  cfg.platforms.instagram.placements.feed,
  cfg.platforms.facebook.placements.feed,
  cfg.platforms.youtube.placements.feed,
];
const sigs = new Set(selected.map((p) => p.format.signature));
assert(sigs.size === 2, `expected 2 unique sigs among IG+FB+YT feed, got ${sigs.size}`);

console.log('verify-concepts: OK');
