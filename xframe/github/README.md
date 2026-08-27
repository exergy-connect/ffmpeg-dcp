# GitHub Actions JIT runner

Dependency-free Node.js listener for GitHub Actions self-hosted runner jobs.
Registers a just-in-time (JIT) runner, long-polls the Actions broker, acquires
one job, executes supported shell steps locally, uploads logs, and completes the
job.

This is a **one-shot, Bash-based specialized runner**. It skips action (`uses`)
steps, omits secret workflow variables from the shell environment, and only
executes jobs matched by the built-in `process-video` policy unless a custom
predicate is injected programmatically.

## Requirements

- Node.js **20.6+** (`AbortSignal.any`, `--env-file`)
- `bash` for shell step execution (Linux/macOS)
- GitHub token with repository **Administration: write**
- Workflow jobs targeting JIT runner labels (`dcp`, `wasm`, `video` by default)

## Environment

Create `xframe/github/.env` (or reuse `xframe/test/.env`):

```bash
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=your-org
GITHUB_REPO=your-repo
```

Optional:

```bash
GITHUB_RUNNER_VERSION=2.336.0
```

## Run (bundled CLI)

From the repository root:

```bash
node --env-file=xframe/github/.env xframe/github/dist/github-runner.min.js
```

Register only:

```bash
node --env-file=xframe/github/.env xframe/github/dist/github-runner.min.js register
node --env-file=xframe/github/.env xframe/github/dist/github-runner.min.js register --show-jit-config
```

## Run (source)

During development:

```bash
node --env-file=xframe/github/.env xframe/github/src/cli.js
```

## Build

```bash
cd xframe/github
npm install
npm run build
npm test
npm run smoke
```

The build writes a checked-in, minified ESM bundle:

- `dist/github-runner.min.js`
- `dist/github-runner.min.js.map`

Node built-ins remain external; there are no runtime npm dependencies.

## Dispatch a test workflow

1. Start the listener (bundled or source command above).
2. Push an `.mp4` under `xframe/uploads/`, or run **Actions → Self-hosted runner test**.

See [Self-hosted runner test workflow](../.github/workflows/self-hosted-runner-test.yml).

## Module layout

| Path | Role |
| --- | --- |
| `src/cli.js` | CLI entry (`listen`, `register`) |
| `src/runner.js` | One-shot lifecycle orchestration |
| `src/policy.js` | Workflow execution policy (`process-video`) |
| `src/github/jit-config.js` | JIT decoding and RSA identity |
| `src/github/auth.js` | Runner OAuth |
| `src/github/crypto.js` | Broker message decryption |
| `src/github/broker.js` | Broker session and long-poll |
| `src/github/job.js` | Acquired job parsing and environment |
| `src/github/run-service.js` | Acquire, renew, complete |
| `src/github/logs.js` | Log formatting and upload |
| `src/github/results.js` | Step result construction |
| `src/github/executor.js` | Local Bash step execution |
| `src/github/registration.js` | JIT registration API |

## Limitations

- GitHub broker/run-service schemas are internal and may change.
- JIT credentials are single-use and short-lived.
- Terminal auth/protocol errors fail fast; transient poll errors retry with backoff.
- Not a replacement for the official GitHub Actions runner.

## Tests

```bash
cd xframe/github && npm test
```

Tests run against source modules under `src/` and include CLI/registration coverage.
