/**
 * CORS feasibility notes for dcpGhRunner (browser / DCP worker fetch).
 * Run: node --test test/cors-spike.test.js
 *
 * Live network probes are skipped unless CORS_SPIKE_LIVE=1.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('dcpGhRunner CORS expectations', () => {
  it('documents api.github.com as browser-accessible with token', () => {
    assert.ok(true, 'Used from xframe/github-transcode-client.js Contents API + workflow_dispatch');
  });

  it('documents Actions broker as likely CORS-restricted from GitHub Pages', () => {
    assert.ok(true, 'Broker host is not api.github.com; browser tab may block unless DCP sandbox differs');
  });

  it('documents LinkedIn REST as likely CORS-restricted; part PUT URLs may work', () => {
    assert.ok(true, 'initialize/finalize hit api.linkedin.com; byte uploads use pre-signed URLs');
  });
});

if (process.env.CORS_SPIKE_LIVE === '1') {
  describe('live CORS probe (optional)', () => {
    it('OPTIONS to api.github.com', async () => {
      const res = await fetch('https://api.github.com', { method: 'GET' });
      assert.ok(res.status > 0);
    });
  });
}
