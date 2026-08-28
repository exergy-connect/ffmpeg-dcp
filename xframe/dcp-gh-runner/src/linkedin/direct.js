const MAX_TEXT_CHARS = 1200;
const DEFAULT_API_VERSION = '202608';
const API_BASE = 'https://api.linkedin.com/rest';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

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
    throw new Error(`Invalid LINKEDIN_AUTHOR_URN: ${urn}`);
  }
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
    throw new Error(`LinkedIn ${method} ${url} → ${res.status}: ${JSON.stringify(json)}`);
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
    throw new Error(`initializeUpload missing fields: ${JSON.stringify(json)}`);
  }
  return value;
}

async function uploadVideoParts(mp4Bytes, uploadInstructions) {
  const etags = [];
  for (const part of uploadInstructions) {
    const first = Number(part.firstByte);
    const last = Number(part.lastByte);
    const len = last - first + 1;
    const chunk = mp4Bytes.subarray(first, last + 1);
    const res = await fetch(part.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(len),
      },
      body: chunk,
    });
    if (!res.ok) throw new Error(`Part upload ${first}-${last} → ${res.status}`);
    const etag = res.headers.get('etag') || res.headers.get('ETag');
    if (!etag) throw new Error(`Part upload ${first}-${last} missing ETag`);
    etags.push(etag);
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

async function waitForVideoAvailable({ token, apiVersion, videoUrn }) {
  const url = `${API_BASE}/videos/${encodeURIComponent(videoUrn)}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { json } = await linkedInFetch(url, { token, apiVersion });
    if (json?.status === 'AVAILABLE') return;
    if (json?.status === 'PROCESSING_FAILED') {
      throw new Error(`Video processing failed: ${JSON.stringify(json)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for video AVAILABLE: ${videoUrn}`);
}

async function createVideoPost({ token, apiVersion, authorUrn, text, videoUrn, visibility = 'PUBLIC' }) {
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
      content: { media: { id: videoUrn } },
    }),
  });
  return res.headers.get('x-restli-id')
    || res.headers.get('X-RestLi-Id')
    || res.headers.get('location')
    || '(unknown post urn)';
}

/**
 * @param {Uint8Array} mp4Bytes
 * @param {object} options
 */
export async function publishDirectToLinkedIn(mp4Bytes, options = {}) {
  const token = options.accessToken || options.linkedinAccessToken;
  const authorUrn = options.authorUrn || options.linkedinAuthorUrn;
  const apiVersion = options.apiVersion || options.linkedinApiVersion || DEFAULT_API_VERSION;
  const text = String(options.postText || options.linkedinPostText || 'Video prepared by DCP Social Media Transcoder').trim();
  if (!token || !authorUrn) {
    throw new Error('LinkedIn direct publish requires accessToken and authorUrn');
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(`LinkedIn post text exceeds ${MAX_TEXT_CHARS} characters`);
  }
  assertAuthorUrn(authorUrn);

  const init = await initializeVideoUpload({
    token,
    apiVersion,
    authorUrn,
    fileSizeBytes: mp4Bytes.length,
  });
  const etags = await uploadVideoParts(mp4Bytes, init.uploadInstructions);
  await finalizeVideoUpload({
    token,
    apiVersion,
    videoUrn: init.video,
    uploadToken: init.uploadToken,
    uploadedPartIds: etags,
  });
  await waitForVideoAvailable({ token, apiVersion, videoUrn: init.video });
  const postUrn = await createVideoPost({
    token,
    apiVersion,
    authorUrn,
    text,
    videoUrn: init.video,
    visibility: options.visibility || 'PUBLIC',
  });
  return { path: 'direct', postUrn, videoUrn: init.video };
}
