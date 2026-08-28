function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function githubApi(path, token, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 280)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function putFile({ token, owner, repo, branch, path, message, bytes }) {
  await githubApi(
    `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    token,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: bytesToBase64(bytes),
        branch,
      }),
    },
  );
}

/**
 * Commit MP4 + LinkedIn metadata JSON and trigger post-to-linkedin workflow.
 * @param {Uint8Array} mp4Bytes
 * @param {object} options
 */
export async function publishViaGithubCommit(mp4Bytes, options = {}) {
  const token = options.githubToken || options.token;
  const owner = options.githubOwner || options.owner;
  const repo = options.githubRepo || options.repo;
  const branch = options.branch || 'main';
  const uploadPrefix = String(options.uploadPrefix || 'docs/uploads').replace(/^\/+|\/+$/g, '');
  const postPrefix = String(options.postMetadataPrefix || 'xframe/posts/linkedin').replace(/^\/+|\/+$/g, '');
  const text = String(options.postText || options.linkedinPostText || 'Video prepared by DCP Social Media Transcoder').trim();

  if (!token || !owner || !repo) {
    throw new Error('GitHub commit publish requires token, owner, and repo');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const videoRel = `${uploadPrefix}/${stamp}-linkedin.mp4`;
  const metaRel = `${postPrefix}/${stamp}.json`;

  await putFile({
    token,
    owner,
    repo,
    branch,
    path: videoRel,
    message: `dcpGhRunner: upload LinkedIn master ${stamp}`,
    bytes: mp4Bytes,
  });

  const metadata = new TextEncoder().encode(JSON.stringify({
    text,
    video: videoRel,
  }, null, 2));

  await putFile({
    token,
    owner,
    repo,
    branch,
    path: metaRel,
    message: `dcpGhRunner: LinkedIn post metadata ${stamp}`,
    bytes: metadata,
  });

  await githubApi(
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent('post-to-linkedin.yml')}/dispatches`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: branch,
        inputs: { metadata_path: metaRel },
      }),
    },
  );

  return { path: 'github', videoRel, metaRel };
}
