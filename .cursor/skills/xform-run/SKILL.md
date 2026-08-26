---
name: xform-run
description: Compiles composable .xp semantic documents into deterministic outputs (compile-tree JSON, finalized HTML/YAML/text, multi-file artifacts). Supports Jinja concepts/templates, .json runtime bindings, .js filter modules, capability realization, and CLI overrides. Also sets up new projects with a Dev Container using ghcr.io/exergy-connect/experiments/xform:latest. Use when compiling .xp decks or labs, scaffolding an xForm project/devcontainer, running the xform script, or finalizing structured documents. For authoring .xp files, use the xform-author skill.
---

# xForm

Compile **structured `.xp` documents** into deterministic artifacts. Concepts,
templates, and Jinja evaluation produce a compile tree (JSON by default) or a
finalized output (`--final`).

Requires **Node.js ≥24** (or the published controller image below).

To **write or edit** `.xp` / `.xpt` sources, use the **xform-author** skill.

## When to use

- User wants to **compile** an `.xp` document, deck, lab, or framework.
- User wants to **scaffold a new project** with an xForm Dev Container.
- User mentions **xForm**, **xform**, compile trees, or `--final html`.
- User wants concept YAML/JSON output under `output/`.
- User wants to apply a final template (`templates/_final/<ext>.xpt`).

## New project (Dev Container)

When starting a **new project** (or adding a container to an existing one), create
`.devcontainer/devcontainer.json` that pulls the published image. Do **not**
build from `xform/Dockerfile` unless the user is developing the compiler itself.

```json
{
  "name": "xform",
  "image": "ghcr.io/exergy-connect/experiments/xform:latest",
  "remoteUser": "node",
  "runArgs": ["--privileged"],
  "workspaceFolder": "/workspaces/${localWorkspaceFolderBasename}",
  "workspaceMount": "source=${localWorkspaceFolder},target=/workspaces/${localWorkspaceFolderBasename},type=bind",
  "forwardPorts": [42042],
  "portsAttributes": {
    "42042": {
      "label": "xForm Lab UI",
      "onAutoForward": "notify"
    }
  },
  "containerEnv": {
    "XFORM_WORKSPACE": "/tmp/xform-ws"
  },
  "postStartCommand": "sudo /usr/local/bin/docker-entrypoint.sh true && (curl -sf http://127.0.0.1:42042/ >/dev/null || (cd /app && nohup node server/index.js >/tmp/xform-server.log 2>&1 &))"
}
```

Notes:

- `--privileged` is required so the image entrypoint can start in-container
  `dockerd` (Containerlab / lab deploy).
- Dev Containers override the image `ENTRYPOINT`/`CMD` by default. `postStart`
  starts `dockerd` via `docker-entrypoint.sh`, then brings up the lab UI if it
  is not already listening on 42042.
- Do **not** add the `docker-in-docker` feature; it conflicts with the image’s
  own `dockerd`.
- Leave `XFORM_ROOT` / `XFORM_EXAMPLES` unset so the baked `/app` and `/examples`
  are used. `xform` is already on `PATH`.
- After writing the file, reopen the folder in the container (VS Code / Cursor
  **Dev Containers**, or Codespaces).
- Compile with `xform <source>... [options]` (same flags as below). Lab UI:
  http://127.0.0.1:42042/

## How to run

**Inside the Dev Container / published image:**

```bash
xform <source>... [options]
```

The CLI is the published GitHub Action bundle. After `install-skills.sh`:

```bash
node .cursor/skills/xform-run/scripts/xform.min.js <source>... [options]
```

In the xFrame.ai repository:

```bash
node actions/xform/xform.min.js <source>... [options]
```

**Sources:** `*.xp` documents, `*.json` concept bindings, `*.js` filter modules,
directories, or `dir/*.ext` patterns (recursive filesystem order by default).

**Default:** write the full compile tree as JSON to `output/<document>.json`.

### Options

| Option | Description |
|--------|-------------|
| `<source>...` | One or more sources (positional). |
| `-h, --help` | Show CLI help (all options) and exit. |
| `-o, --output <file>` | Override the compile-tree JSON path. |
| `--tree` | Write the full compile tree as JSON (default behavior). |
| `--final <extension>` | Apply `templates/_final/<extension>.xpt` (or `_final._templates`); write `output/<document>.<extension>`. Segment-stream finals write each segment's `_document._output` under `output/`. |
| `--with name=value` | Override a root-scope variable (repeatable; supports `company.name=X`). Capability paths prefer a realization: `--with persist.store=neo4j` or `--with persist=neo4j`. |
| `--env name` | Include an OS environment variable in root scope (repeatable). |
| `--keep-segment-separators` | With `--final`, join segments with `---` (default: blank line). |
| `--no-recurse` | Do not recurse into subdirectories when expanding dirs/patterns. |
| `--skip-symlinks` | Do not follow or include symlinks when expanding dirs/patterns. |
| `--target <capability>` | Realize this capability path (overrides `_document._final`). |
| `--no-execute` | Emit the `_execution` plan only (do not realize / run commands). |
| `--dryrun` | Print `_command` lines without spawning. |
| `--approval <hash\|interactive>` | Approve an execution hash, or prompt Y/N (TTY). |
| `--auto-approve` | Run capability commands without approval. |
| `--approve-any-version` | Omit `_version` from approval hashes. |
| `--approval-store <path>` | Override approval store root (default `~/.xform/approvals/`). |
| `--watch` | Rebuild on input/template changes. |

### Jinja-only compile

```bash
node actions/xform/xform.min.js compile <template> [runtime.json ...] [filters.js ...] [--final] [-o output]
```

### Examples

```bash
# Compile tree JSON
node actions/xform/xform.min.js deck.xp

# Final HTML
node actions/xform/xform.min.js deck.xp --final html

# Bindings + filters
node actions/xform/xform.min.js deck.xp runtime.json filters.js --final html -o out/deck.html
```

## GitHub Action

```yaml
- uses: exergy-connect/xFrame.ai/actions/xform@main
  with:
    sources: path/to/document.xp
    materialization: html
```

## Directory layout

- `skills/xform-run/SKILL.md` — this skill (compile / CLI)
- `actions/xform/xform.min.js` — minified CLI bundle (published with the GitHub Action; copied into this skill on install)
- `skills/xform-author/SKILL.md` — authoring `.xp` documents
