import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline } from '../src/pipeline.js';
import { transcodeVideoFromUrl } from '../src/transcode.js';
import { publishViaGithubCommit } from '../src/linkedin/github-commit.js';

describe('runPipeline', () => {
  it('requires github credentials', async () => {
    await assert.rejects(
      () => runPipeline({ github: { token: '', owner: 'o', repo: 'r' } }),
      /github\.token/,
    );
  });
});

describe('transcodeVideoFromUrl (mocked)', () => {
  it('downloads and transcodes via stub WASM module', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async arrayBuffer() {
        return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]).buffer;
      },
    });

    const fakeMp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    const createFfmpegModule = async () => ({
      FS: {
        writeFile() {},
        readFile() {
          return fakeMp4;
        },
        unlink() {},
      },
      ccall(name) {
        if (name === 'transcode_social_segment' || name === 'remux_to_mp4') return 0;
        return -1;
      },
    });

    try {
      const out = await transcodeVideoFromUrl('https://example.test/in.webm', {
        createFfmpegModule,
        log: () => {},
      });
      assert.deepEqual(out, fakeMp4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('publishViaGithubCommit (mocked)', () => {
  /** @type {typeof fetch} */
  let originalFetch;
  /** @type {Array<{url: string, init?: RequestInit}>} */
  let calls;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/contents/')) {
        return { ok: true, status: 200, json: async () => ({ content: {} }) };
      }
      if (String(url).includes('/dispatches')) {
        return { ok: true, status: 204, json: async () => null };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('commits MP4 + metadata and dispatches workflow', async () => {
    const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    const result = await publishViaGithubCommit(mp4, {
      token: 'gh_test',
      owner: 'exergy-connect',
      repo: 'ffmpeg-dcp',
      branch: 'main',
      postText: 'Hello LinkedIn',
    });

    assert.equal(result.path, 'github');
    assert.match(result.videoRel, /^docs\/uploads\/.+-linkedin\.mp4$/);
    assert.match(result.metaRel, /^xframe\/posts\/linkedin\/.+\.json$/);

    const puts = calls.filter((c) => c.init?.method === 'PUT');
    assert.equal(puts.length, 2);
    const dispatch = calls.find((c) => c.url.includes('/dispatches'));
    assert.ok(dispatch);
    const body = JSON.parse(String(dispatch.init.body));
    assert.equal(body.inputs.metadata_path, result.metaRel);
  });
});
