# xFrame test utilities

Runner documentation and the maintained implementation live in
[`../github/README.md`](../github/README.md).

## Legacy prototypes

The files in this directory (`github-runner-client.js`, `runner-listener.js`,
`register-runner.js`) are superseded by `xframe/github/`. Prefer the bundled CLI:

```bash
node --env-file=xframe/github/.env xframe/github/dist/github-runner.min.js
```

## Tests

Runner unit tests now live under `xframe/github/test/`:

```bash
cd xframe/github && npm test
```
