# xFrame test utilities

## GitHub Actions runner listener prototype

`runner-listener.js` is a dependency-free Node.js prototype that exercises the
GitHub Actions self-hosted runner listener path without executing jobs:

1. JIT registration via `generate-jitconfig`
2. Runner OAuth authentication (RFC 7523 JWT bearer assertion)
3. Broker session creation
4. Long-poll on the broker message queue
5. Decrypt and print job reference metadata
6. Delete the broker session and exit

The prototype **does not execute** workflow steps. It acquires the queued job,
prints redacted metadata, and completes the job as `skipped` so the run does
not stay locked.

### Prerequisites

- Node.js 18+
- A GitHub token with repository **Administration: write**
- A workflow job targeting labels registered by the JIT runner (`dcp`, `wasm`,
  `video` by default)

### Environment

Create `xframe/test/.env` (ignored by git):

```bash
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=your-org
GITHUB_REPO=your-repo
```

Optional:

```bash
GITHUB_RUNNER_VERSION=2.336.0
```

### Run

From the repository root:

```bash
node --env-file=xframe/test/.env xframe/test/runner-listener.js
```

Register a JIT runner only (no listener):

```bash
node --env-file=xframe/test/.env xframe/test/register-runner.js
```

Include the encoded JIT blob in the registration output:

```bash
node --env-file=xframe/test/.env xframe/test/register-runner.js --show-jit-config
```

### Expected output

After dispatching a matching workflow job, the listener prints non-secret
metadata similar to:

```text
Runner: dcp-...
Runner ID: 21
Labels: [ 'dcp', 'wasm', 'video' ]
Broker URL: https://broker.actions.githubusercontent.com/
Session ID: ...
Message ID: ...
Message type: RunnerJobRequest
Runner request ID: ...
Run service URL: https://...
Billing owner ID: ...
```

Press `Ctrl+C` to abort while long-polling.

### Dispatch a test workflow

A repository workflow targets the same JIT runner labels (`dcp`, `wasm`, `video`):

1. Start the listener: `node --env-file=xframe/test/.env xframe/test/runner-listener.js`
2. Post a test video: commit and push an `.mp4` under `xframe/uploads/`, **or** use
   **Actions → Self-hosted runner test → Run workflow** (optional `video_path` input)

The workflow sets `VIDEO_PATH` and `VIDEO_URL` on the runner job. The listener
should print the broker job reference when the run is queued. The workflow job
itself will stay queued until a real self-hosted runner executes it; this
prototype only observes the job message.

### Tests

```bash
node --test xframe/test/github-runner-client.test.js
```

### Notes

- GitHub’s broker/run-service protocol is internal and may change without notice.
- JIT credentials are single-use and short-lived; generate a fresh runner for
  each attempt.
- If broker polling fails with `400 Bad Request` on a brand-new repository,
  GitHub may require one conventional self-hosted runner registration first
  (see [actions/runner#3823](https://github.com/actions/runner/issues/3823)).

### Files

| File | Role |
| --- | --- |
| `register-runner.js` | JIT registration helper and CLI |
| `github-runner-client.js` | OAuth, broker session, polling, decryption |
| `runner-listener.js` | End-to-end one-shot listener prototype |
| `github-runner-client.test.js` | Mocked protocol unit tests |
