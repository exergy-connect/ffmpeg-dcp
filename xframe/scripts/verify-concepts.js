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
assert(
  typeof cfg.worker_invite?.url === 'string' && cfg.worker_invite.url.endsWith('/worker.html'),
  'app.worker_invite.url must point at public worker.html',
);
assert(
  cfg.worker_invite?.demo_audio_base === 'crazyOnes/audio/gemini',
  'worker demo audio base must point at generated Crazy Ones clips',
);
assert(
  JSON.stringify(cfg.worker_invite?.demo_audio_slides) ===
    JSON.stringify(['non-conformists', 'impact', 'visionaries', 'the-ones-who-do']),
  'worker demo audio slide order must match demoCommentIndex 1..4',
);
assert(
  JSON.stringify(cfg.worker_invite?.demo_audio_locales) ===
    JSON.stringify(['en-US', 'fr-FR', 'es-ES', 'de-DE', 'nl-NL']),
  'worker demo audio locales must list each generated language once',
);
assert(
  fs.readFileSync(path.join(root, 'dcp-transcoding.js'), 'utf8').includes(
    "require('ffmpeg-dcp-social/ffmpeg-wasm.js')",
  ),
  'work function must require the fully-qualified ffmpeg-dcp-social package id',
);
assert(html.includes('id="stageCutBtn"'), 'HTML must include director’s cut staging button');
assert(html.includes('id="cutDialog"'), 'HTML must include director’s cut dialog');
assert(html.includes('id="cutAddSliceBtn"'), 'HTML must include add-slice control');
assert(html.includes('id="cutSliceList"'), 'HTML must include cut slice list');
assert(html.includes('id="cutSaveBtn"'), 'HTML must include cut save control');
assert(html.includes('id="readOutCommentsToggle"'), 'HTML must include Read out comments toggle');
assert(
  fs.readFileSync(path.join(root, 'dcp-transcoding.js'), 'utf8').includes('DIRECTORS_CUT_STORAGE_PREFIX'),
  'runtime must persist director’s cut programs',
);
assert(
  fs.readFileSync(path.join(root, 'ffmpeg-worker.js'), 'utf8').includes('stageDirectorsCut'),
  'worker must expose stageDirectorsCut',
);
const workerRuntime = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
assert(
  workerRuntime.includes('standardDemoCommentIndex') &&
    workerRuntime.includes('payload.demoCommentIndex = demoCommentIndex'),
  'browser worker must include the inferred demo comment index',
);
const transcoderRuntime = fs.readFileSync(path.join(root, 'dcp-transcoding.js'), 'utf8');
assert(
  transcoderRuntime.includes('demoCommentAudioUrl') &&
    transcoderRuntime.includes('reserveDemoAudioLocale') &&
    transcoderRuntime.includes('workerPlaybackLanguage') &&
    transcoderRuntime.includes('playWorkerCommentFromCell') &&
    transcoderRuntime.includes('finishCommentAutoplay') &&
    transcoderRuntime.includes('speakCommentWithBrowser'),
  'web UI must rotate demo WAV languages, update flags, support replay, and fall back to browser speech',
);
assert(
  fs.readFileSync(path.join(root, 'src/dcp-transcode.c'), 'utf8').includes('extract_time_range'),
  'WASM source must define extract_time_range',
);

// Dedupe simulation
const selected = [
  cfg.platforms.instagram.placements.feed,
  cfg.platforms.facebook.placements.feed,
  cfg.platforms.youtube.placements.feed,
];
const sigs = new Set(selected.map((p) => p.format.signature));
assert(sigs.size === 2, `expected 2 unique sigs among IG+FB+YT feed, got ${sigs.size}`);

console.log('verify-concepts: OK');
