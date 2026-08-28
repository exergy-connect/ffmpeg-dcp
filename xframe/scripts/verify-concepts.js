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
assert(
  cfg.platforms.linkedin.post.max_characters === 1200,
  'LinkedIn organic post body is 1200 characters',
);
assert(html.includes('1200 characters'), 'HTML must surface the LinkedIn post character limit');
assert(cfg.timing.social_default.output_fps === 30, '30 fps');
assert(cfg.dispatch.dedupe_identical_formats === true, 'dedupe enabled');
assert(cfg.dcp_package === 'ffmpeg-dcp-social-v2/ffmpeg-wasm.js', 'distinct package name with extract build');
assert(cfg.bank?.operation === 'viewAccount', 'bank.operation must be viewAccount');
assert(cfg.bank?.balance_field === 'payload.balance', 'bank.balance_field must be payload.balance');
assert(html.includes('dcp-bank-account.js'), 'HTML must load dcp-bank-account.js');
assert(
  typeof cfg.worker_invite?.url === 'string' && cfg.worker_invite.url.endsWith('/worker.html'),
  'app.worker_invite.url must point at public worker.html',
);
assert(
  cfg.worker_invite?.demo_audio_base == null
    && cfg.worker_invite?.demo_audio_slides == null
    && cfg.worker_invite?.demo_audio_locales == null,
  'worker invite must not carry Crazy Ones demo audio catalog',
);
assert(
  JSON.stringify(cfg.audience?.messages?.map((msg) => msg.id)) ===
    JSON.stringify(['non-conformists', 'dcp-boring', 'from-target', 'desjardins-fridge']),
  'audience catalog ids must come from demoMessages.xp',
);
assert(
  fs.readFileSync(path.join(root, 'dcp-transcoding.js'), 'utf8').includes(
    "ffmpeg-dcp-social-v2/ffmpeg-wasm.js",
  ),
  'work function must pin ffmpeg-dcp-social-v2 (extract_time_range fleet build)',
);
assert(html.includes('id="stageCutBtn"'), 'HTML must include director’s cut staging button');
assert(html.includes('id="cutDialog"'), 'HTML must include director’s cut dialog');
assert(html.includes('id="cutAddSliceBtn"'), 'HTML must include add-slice control');
assert(html.includes('id="cutSliceList"'), 'HTML must include cut slice list');
assert(html.includes('id="cutSaveBtn"'), 'HTML must include cut save control');
assert(html.includes('id="readOutCommentsToggle"'), 'HTML must include Read out comments toggle');
assert(html.includes('id="emulateAudienceToggle"'), 'HTML must include Emulate audience toggle');
assert(cfg.audience?.chance_percent === 25, 'audience emulation floor chance must be 25%');
assert(
  Array.isArray(cfg.audience?.messages) && cfg.audience.messages.length === 4,
  'audience catalog must include the four demo messages',
);
assert(
  cfg.audience?.audio_base === 'demoMessages/audio/gemini',
  'audience demo audio must point at generated demoMessages clips',
);
assert(
  fs.readFileSync(path.join(root, 'dcp-transcoding.js'), 'utf8').includes('DIRECTORS_CUT_STORAGE_PREFIX'),
  'runtime must persist director’s cut programs',
);
assert(
  fs.readFileSync(path.join(root, 'dcp-transcoding.js'), 'utf8').includes('mapDirectorsCutToProgram'),
  'runtime must map director’s cut onto DCP program segments',
);
assert(
  fs.readFileSync(path.join(root, 'dcp-deploy-worker.js'), 'utf8').includes('programSegments'),
  'deploy worker must emit programSegments',
);
assert(
  fs.readFileSync(path.join(root, 'ffmpeg-worker.js'), 'utf8').includes('extractTimeRange'),
  'worker must expose extractTimeRange for boundary trims',
);
const transcoderRuntime = fs.readFileSync(path.join(root, 'dcp-transcoding.js'), 'utf8');
assert(
  transcoderRuntime.includes('maybeEmulateAudienceComment') &&
    transcoderRuntime.includes('audience roll miss') &&
    transcoderRuntime.includes('audience roll hit') &&
    transcoderRuntime.includes('audienceInsertChance') &&
    transcoderRuntime.includes('remainingAudienceSlots') &&
    transcoderRuntime.includes('demoCommentAudioUrl') &&
    transcoderRuntime.includes('reserveDemoAudioLocale') &&
    transcoderRuntime.includes('workerPlaybackLanguage') &&
    transcoderRuntime.includes('playWorkerCommentFromCell') &&
    transcoderRuntime.includes('finishCommentAutoplay') &&
    transcoderRuntime.includes('selectedLinkedInComments') &&
    transcoderRuntime.includes('linkedInPostMaxCharacters') &&
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
