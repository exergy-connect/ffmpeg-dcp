'use strict';

/**
 * Browser-side GitHub upload + workflow dispatch for “Transcode via GitHub”.
 * Token is cached in localStorage (see CONFIG.github.token_storage_key).
 */
(function initGithubTranscodeClient(global) {
  const GITHUB_OWNER_KEY = 'xframe-social:githubOwner';
  const GITHUB_REPO_KEY = 'xframe-social:githubRepo';
  const LINKEDIN_TOKEN_KEY = 'xframe-social:linkedinToken';
  const LINKEDIN_URN_KEY = 'xframe-social:linkedinAuthorUrn';
  const LINKEDIN_POST_KEY = 'xframe-social:linkedinPostText';

  function githubConfig(config) {
    return config?.github || {};
  }

  function tokenStorageKey(config) {
    return githubConfig(config).token_storage_key || 'xframe-social:githubToken';
  }

  function maxUploadBytes(config) {
    const n = Number(githubConfig(config).max_upload_bytes);
    return Number.isFinite(n) && n > 0 ? n : 95_000_000;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function sniffExtension(bytes, baseName) {
    const fromName = String(baseName || '').match(/\.([a-z0-9]+)$/i);
    if (fromName) return fromName[1].toLowerCase();
    if (bytes?.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45) return 'webm';
    if (bytes?.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74) return 'mp4';
    return 'webm';
  }

  function sanitizeUploadBaseName(name) {
    return String(name || 'recording')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'recording';
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

  async function uploadVideoToGithub({
    config,
    token,
    owner,
    repo,
    branch,
    bytes,
    baseName,
  }) {
    const limit = maxUploadBytes(config);
    if (!(bytes?.byteLength > 0)) throw new Error('No video bytes to upload.');
    if (bytes.byteLength > limit) {
      throw new Error(
        `Video is ${(bytes.byteLength / 1_000_000).toFixed(1)} MB; GitHub Contents API limit is about ${(limit / 1_000_000).toFixed(0)} MB.`,
      );
    }

    const gh = githubConfig(config);
    const prefix = String(gh.upload_prefix || 'docs/uploads').replace(/^\/+|\/+$/g, '');
    const ext = sniffExtension(bytes, baseName);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${stamp}-${sanitizeUploadBaseName(baseName)}.${ext}`;
    const path = `${prefix}/${fileName}`;
    const ref = branch || gh.branch || 'main';

    await githubApi(
      `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
      token,
      {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Upload ${fileName} for DCP GitHub transcode`,
        content: bytesToBase64(bytes),
        branch: ref,
      }),
    });

    return path;
  }

  async function dispatchGithubWorkflow({
    config,
    token,
    owner,
    repo,
    branch,
    videoPath,
  }) {
    const gh = githubConfig(config);
    const workflowFile = gh.workflow_file || 'self-hosted-runner-test.yml';
    const ref = branch || gh.branch || 'main';
    await githubApi(
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ref,
          inputs: { video_path: videoPath },
        }),
      },
    );
  }

  function openGithubTranscodeDialog(config, el) {
    return new Promise((resolve) => {
      const dialog = el('githubDialog');
      if (!dialog) {
        resolve(null);
        return;
      }

      const gh = githubConfig(config);
      const tokenInput = el('githubTokenInput');
      const ownerInput = el('githubOwnerInput');
      const repoInput = el('githubRepoInput');
      const linkedinTokenInput = el('linkedinTokenInput');
      const linkedinUrnInput = el('linkedinAuthorUrnInput');
      const linkedinPostInput = el('linkedinPostTextInput');
      const errorEl = el('githubDialogError');

      ownerInput.value = localStorage.getItem(GITHUB_OWNER_KEY) || gh.owner || '';
      repoInput.value = localStorage.getItem(GITHUB_REPO_KEY) || gh.repo || '';
      tokenInput.value = localStorage.getItem(tokenStorageKey(config)) || '';
      if (linkedinTokenInput) {
        linkedinTokenInput.value = localStorage.getItem(LINKEDIN_TOKEN_KEY) || '';
      }
      if (linkedinUrnInput) {
        linkedinUrnInput.value = localStorage.getItem(LINKEDIN_URN_KEY) || '';
      }
      if (linkedinPostInput) {
        linkedinPostInput.value = localStorage.getItem(LINKEDIN_POST_KEY) || '';
      }
      if (errorEl) errorEl.textContent = '';

      const cleanup = () => {
        el('githubDialogCancelBtn')?.removeEventListener('click', onCancel);
        el('githubDialogRunBtn')?.removeEventListener('click', onRun);
        dialog.removeEventListener('cancel', onCancel);
      };

      const onCancel = () => {
        cleanup();
        dialog.close();
        resolve(null);
      };

      const onRun = () => {
        const token = tokenInput.value.trim();
        const owner = ownerInput.value.trim();
        const repo = repoInput.value.trim();
        const linkedinAccessToken = linkedinTokenInput?.value.trim() || '';
        const linkedinAuthorUrn = linkedinUrnInput?.value.trim() || '';
        const linkedinPostText = linkedinPostInput?.value.trim() || '';
        if (!token || !owner || !repo) {
          if (errorEl) errorEl.textContent = 'GitHub token, owner, and repository are required.';
          return;
        }
        localStorage.setItem(tokenStorageKey(config), token);
        localStorage.setItem(GITHUB_OWNER_KEY, owner);
        localStorage.setItem(GITHUB_REPO_KEY, repo);
        if (linkedinAccessToken) localStorage.setItem(LINKEDIN_TOKEN_KEY, linkedinAccessToken);
        else localStorage.removeItem(LINKEDIN_TOKEN_KEY);
        if (linkedinAuthorUrn) localStorage.setItem(LINKEDIN_URN_KEY, linkedinAuthorUrn);
        else localStorage.removeItem(LINKEDIN_URN_KEY);
        if (linkedinPostText) localStorage.setItem(LINKEDIN_POST_KEY, linkedinPostText);
        else localStorage.removeItem(LINKEDIN_POST_KEY);
        cleanup();
        dialog.close();
        resolve({
          token,
          owner,
          repo,
          branch: gh.branch || 'main',
          linkedinAccessToken,
          linkedinAuthorUrn,
          linkedinPostText,
        });
      };

      el('githubDialogCancelBtn')?.addEventListener('click', onCancel);
      el('githubDialogRunBtn')?.addEventListener('click', onRun);
      dialog.addEventListener('cancel', onCancel);
      dialog.showModal();
    });
  }

  global.xframeGithubTranscode = {
    githubConfig,
    tokenStorageKey,
    uploadVideoToGithub,
    dispatchGithubWorkflow,
    openGithubTranscodeDialog,
  };
})(typeof window !== 'undefined' ? window : globalThis);
