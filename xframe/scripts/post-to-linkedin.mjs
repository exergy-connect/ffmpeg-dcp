#!/usr/bin/env node
/**
 * Publish LinkedIn video posts from local metadata JSON.
 *
 * Usage:
 *   node xframe/scripts/post-to-linkedin.mjs [--dry-run] <metadata.json> [...]
 *
 * Env:
 *   LINKEDIN_ACCESS_TOKEN  (required unless --dry-run)
 *   LINKEDIN_AUTHOR_URN    (required unless --dry-run) urn:li:person:… or urn:li:organization:…
 *   LINKEDIN_API_VERSION   (optional) YYYYMM, default 202608
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_TEXT_CHARS = 1200;
const DEFAULT_API_VERSION = '202608';
const API_BASE = 'https://api.linkedin.com/rest';
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const paths = argv.filter((a) => a !== '--dry-run' && !a.startsWith('-'));
  if (!paths.length) {
    fail('Usage: node xframe/scripts/post-to-linkedin.mjs [--dry-run] <metadata.json> [...]');
  }
  return { dryRun, paths };
}

function linkedInHeaders(token, apiVersion, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'Linkedin-Version': apiVersion,
    'X-Restli-Protocol-Version': '2.0.0',
    ...extra,
  };
}

function assertAuthorUrn(urn) {
  if (!/^urn:li:(person|organization):\S+$/.test(urn)) {
    fail(
      `LINKEDIN_AUTHOR_URN must be urn:li:person:… or urn:li:organization:… (got ${JSON.stringify(urn)})`,
    );
  }
}

function loadMetadata(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) fail(`Metadata file not found: ${filePath}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    fail(`Invalid JSON in ${filePath}: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${filePath}: root must be a JSON object`);
  }
  const text = raw.text;
  if (typeof text !== 'string' || !text.trim()) {
    fail(`${filePath}: "text" must be a non-empty string`);
  }
  if (text.length > MAX_TEXT_CHARS) {
    fail(`${filePath}: "text" exceeds ${MAX_TEXT_CHARS} characters (${text.length})`);
  }
  const video = raw.video;
  if (typeof video !== 'string' || !video.trim()) {
    fail(`${filePath}: "video" must be a non-empty string`);
  }
  return { abs, text: text.trim(), video: video.trim(), visibility: raw.visibility || 'PUBLIC' };
}

function resolveVideoPath(videoRel) {
  if (path.isAbsolute(videoRel)) {
    fail(`video path must be repo-relative (got absolute: ${videoRel})`);
  }
  const normalized = path.posix.normalize(videoRel.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    fail(`video path must stay within the repo (got ${videoRel})`);
  }
  if (!normalized.toLowerCase().endsWith('.mp4')) {
    fail(`video path must end in .mp4 (got ${videoRel})`);
  }
  const abs = path.resolve(REPO_ROOT, normalized);
  if (!abs.startsWith(REPO_ROOT + path.sep) && abs !== REPO_ROOT) {
    fail(`video path escapes repository root: ${videoRel}`);
  }
  if (!fs.existsSync(abs)) {
    fail(`video file not found: ${normalized}`);
  }
  const st = fs.statSync(abs);
  if (!st.isFile()) fail(`video path is not a file: ${normalized}`);
  return { rel: normalized, abs, size: st.size };
}

async function readJsonResponse(res) {
  const body = await res.text();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

async function linkedInFetch(url, { token, apiVersion, method = 'GET', body, headers = {} }) {
  const res = await fetch(url, {
    method,
    headers: linkedInHeaders(token, apiVersion, headers),
    body,
  });
  const json = await readJsonResponse(res);
  if (!res.ok) {
    const detail = typeof json === 'object' ? JSON.stringify(json) : String(json);
    fail(`LinkedIn ${method} ${url} → ${res.status}: ${detail}`);
  }
  return { res, json };
}

async function initializeVideoUpload({ token, apiVersion, authorUrn, fileSizeBytes }) {
  const { json } = await linkedInFetch(`${API_BASE}/videos?action=initializeUpload`, {
    token,
    apiVersion,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initializeUploadRequest: {
        owner: authorUrn,
        fileSizeBytes,
        uploadThumbnail: false,
      },
    }),
  });
  const value = json?.value;
  if (!value?.video || !value?.uploadInstructions?.length) {
    fail(`initializeUpload missing video/uploadInstructions: ${JSON.stringify(json)}`);
  }
  return value;
}

async function uploadVideoParts(absPath, uploadInstructions) {
  const fd = fs.openSync(absPath, 'r');
  const etags = [];
  try {
    for (const part of uploadInstructions) {
      const first = Number(part.firstByte);
      const last = Number(part.lastByte);
      if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) {
        fail(`Invalid upload instruction byte range: ${JSON.stringify(part)}`);
      }
      const len = last - first + 1;
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, first);
      if (read !== len) {
        fail(`Short read for bytes ${first}-${last}: got ${read}`);
      }
      const res = await fetch(part.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(len),
        },
        body: buf,
      });
      if (!res.ok) {
        const text = await res.text();
        fail(`Part upload ${first}-${last} → ${res.status}: ${text}`);
      }
      const etag = res.headers.get('etag') || res.headers.get('ETag');
      if (!etag) fail(`Part upload ${first}-${last} missing ETag header`);
      // LinkedIn expects the ETag header values (typically quoted).
      etags.push(etag);
      console.log(`Uploaded bytes ${first}-${last} (${etags.length}/${uploadInstructions.length})`);
    }
  } finally {
    fs.closeSync(fd);
  }
  return etags;
}

async function finalizeVideoUpload({ token, apiVersion, videoUrn, uploadToken, uploadedPartIds }) {
  await linkedInFetch(`${API_BASE}/videos?action=finalizeUpload`, {
    token,
    apiVersion,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      finalizeUploadRequest: {
        video: videoUrn,
        uploadToken: uploadToken || '',
        uploadedPartIds,
      },
    }),
  });
}

function encodeUrnForPath(urn) {
  return encodeURIComponent(urn);
}

async function waitForVideoAvailable({ token, apiVersion, videoUrn }) {
  const url = `${API_BASE}/videos/${encodeUrnForPath(videoUrn)}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { json } = await linkedInFetch(url, { token, apiVersion });
    const status = json?.status;
    console.log(`Video ${videoUrn} status: ${status}`);
    if (status === 'AVAILABLE') return;
    if (status === 'PROCESSING_FAILED') {
      fail(`Video processing failed: ${JSON.stringify(json)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  fail(`Timed out waiting for video AVAILABLE (${POLL_TIMEOUT_MS}ms): ${videoUrn}`);
}

async function createVideoPost({ token, apiVersion, authorUrn, text, videoUrn, visibility }) {
  const { res } = await linkedInFetch(`${API_BASE}/posts`, {
    token,
    apiVersion,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: authorUrn,
      commentary: text,
      visibility,
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: {
        media: {
          id: videoUrn,
        },
      },
    }),
  });
  const postUrn =
    res.headers.get('x-restli-id') ||
    res.headers.get('X-RestLi-Id') ||
    res.headers.get('location') ||
    '(unknown post urn)';
  return postUrn;
}

async function processOne(metaPath, { dryRun, token, apiVersion, authorUrn }) {
  console.log(`\n=== ${metaPath} ===`);
  const meta = loadMetadata(metaPath);
  const video = resolveVideoPath(meta.video);
  console.log(`text: ${meta.text.length} chars`);
  console.log(`video: ${video.rel} (${video.size} bytes)`);

  if (dryRun) {
    console.log('dry-run: schema and paths OK; skipping LinkedIn API');
    return { dryRun: true, video: video.rel };
  }

  const init = await initializeVideoUpload({
    token,
    apiVersion,
    authorUrn,
    fileSizeBytes: video.size,
  });
  console.log(`Initialized upload: ${init.video}`);
  const etags = await uploadVideoParts(video.abs, init.uploadInstructions);
  await finalizeVideoUpload({
    token,
    apiVersion,
    videoUrn: init.video,
    uploadToken: init.uploadToken,
    uploadedPartIds: etags,
  });
  console.log('Finalize submitted; waiting for AVAILABLE…');
  await waitForVideoAvailable({ token, apiVersion, videoUrn: init.video });
  const postUrn = await createVideoPost({
    token,
    apiVersion,
    authorUrn,
    text: meta.text,
    videoUrn: init.video,
    visibility: meta.visibility,
  });
  console.log(`Posted: ${postUrn}`);
  return { postUrn, videoUrn: init.video };
}

async function main() {
  const { dryRun, paths } = parseArgs(process.argv.slice(2));
  const apiVersion = process.env.LINKEDIN_API_VERSION || DEFAULT_API_VERSION;
  let token = '';
  let authorUrn = '';

  if (!dryRun) {
    token = process.env.LINKEDIN_ACCESS_TOKEN || '';
    authorUrn = process.env.LINKEDIN_AUTHOR_URN || '';
    if (!token) fail('LINKEDIN_ACCESS_TOKEN is required (or pass --dry-run)');
    if (!authorUrn) fail('LINKEDIN_AUTHOR_URN is required (or pass --dry-run)');
    assertAuthorUrn(authorUrn);
  }

  const results = [];
  for (const p of paths) {
    results.push(await processOne(p, { dryRun, token, apiVersion, authorUrn }));
  }
  console.log(`\nDone: ${results.length} metadata file(s).`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
