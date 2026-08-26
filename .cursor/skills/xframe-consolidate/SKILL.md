---
name: xframe-consolidate
description: Normalizes and consolidates JSON model and data into validated JSON Schema plus consolidated data (optional --js, optional --close-fk-enums, optional --data-include / --data-exclude regex filters). Use when the user wants to consolidate models and data, normalize entity data, validate, generate consolidated.schema.json / consolidated_data.json, close foreign-key fields to enums from loaded data, load a subset of data files by path, or run the consolidate script.
disable-model-invocation: true
---

# Consolidate (xFrame)

Normalize JSON model fragments and JSON data into a **JSON Schema** describing the merged model, plus **consolidated data** with computed fields and a change record. Default flow: load model → emit `consolidated.schema.json` → load data → validate / outliers / computed fields → version tracking → write `consolidated_data.json`. With **`--close-fk-enums`**, the first schema write is deferred until after data load so foreign-key properties get `enum` values from distinct primary keys present in that data; the merged schema then includes `x-fkEnumFromData: true`.

## When to use

- User wants to **consolidate** or **normalize** JSON model and/or data.
- User mentions **xFrame**, **consolidator**, **consolidated.schema.json**, **consolidated_data**, or legacy names **consolidated_model** / **consolidated_data**.
- User has **model/** and **data/** under one project root and wants schema + data JSON output.
- User wants **validation** and a single **JSON Schema** artifact for the merged entity definitions.
- User wants **FK enum closure**: tighten foreign-key fields in the emitted schema to the set of referenced primary keys actually loaded (pass **`--close-fk-enums`**).
- User wants to **load a subset of data JSON** by path under `data/` (pass one or more **`--data-include`** regex patterns; paths are relative to `data/`, POSIX-style, e.g. `^fields/` for only the `fields/` subtree).
- User wants to **skip some data JSON** by path (pass one or more **`--data-exclude`** regexes; applied after `--data-include` when both are set).

## How to run

Requires **Node.js ≥24**. The only path knob is **`--working-dir`** (default **`xframe`**, relative to cwd unless absolute). The consolidator always uses:

| Path | Location |
|------|----------|
| Data | `<working-dir>/data` |
| Model | `<working-dir>/model` |
| Output | `<working-dir>/output` |

The CLI is the published GitHub Action bundle. After `install-skills.sh`:

```bash
node .cursor/skills/xframe-consolidate/scripts/consolidate.min.js --note "<note>" [options]
# optional: --working-dir myproj   # uses myproj/data, myproj/model, myproj/output
```

In the xFrame.ai repository:

```bash
node actions/consolidate/consolidate.min.js --note "<note>" [options]
```

**Required:**

| Argument | Description |
|----------|-------------|
| `--note "<text>"` | **Reason for this run** (required, non-empty). Stored in `change`; describe the real delta (e.g. new entities, field changes, data corrections). Avoid generic *"Consolidate"* / *"Sync"*. |

**Optional:**

| Option | Description |
|--------|-------------|
| `--working-dir <dir>` | Project root containing `data/` and `model/` (default: `xframe`). |
| `--author <name>` | Author on the change record (default: OS username). |
| `--git-commit-hash <hash>` | Commit hash on the change record. |
| `--js` | Also write `consolidated.schema.js` and `consolidated_data.js`: same format as the Python consolidator (base64 gzip payload + `getConsolidatedModel` / `getConsolidatedData` and `…Sync` with pako). |
| `--log-level <level>` | `DEBUG` \| `INFO` \| `WARNING` \| `ERROR` (default `INFO`). |
| `--clean` | Ignore prior `output/*.json` for version tracking and do not infer `--js` from existing files. |
| `--close-fk-enums` | After load + flatten, set JSON Schema `enum` on foreign-key fields from distinct primary-key values **present in the loaded data** for the referenced entity. Replaces any model `enum` on those properties. Defers writing `consolidated.schema.json` until then; output includes `x-fkEnumFromData: true`. Validation still runs explicit **FK existence** checks unless the entity uses `validation: warn` / `skip`. |
| `--data-include <regex>` | Repeatable, or use `--data-include=<regex>`. When any are set, only `.json` files under `data/` whose path **relative to `data/`** matches **at least one** pattern are loaded. Matching uses JavaScript `RegExp` with the same effect as `String.search` on the relative path (forward slashes). Example: `--data-include '^fields/'` loads only `data/fields/...json`. Omitting this flag loads all data JSON as before. |
| `--data-exclude <regex>` | Repeatable, or use `--data-exclude=<regex>`. When any are set, `.json` files whose path **relative to `data/`** matches **any** pattern are skipped (`String.search`). Applied **after** `--data-include` when both are set. Example: `--data-exclude '^scratch/'` omits `data/scratch/...json`. |

## Version

Installed marker: `.cursor/skills/.xframe-latest`

```bash
bash <(curl -fsSL https://exergy-connect.github.io/xFrame.ai/install-skills.sh) [--check|--update]
```

## Directory layout

- `skills/xframe-consolidate/SKILL.md` — this skill
- `actions/consolidate/consolidate.min.js` — minified CLI bundle (published with the GitHub Action; copied into this skill on install)
- **Model directory**: `<working-dir>/model` — one or more `.json` files; each file is a data-model document with `entities: [ … ]`. Merged into one **JSON Schema** (`$defs` per entity).
- **Data directory**: `<working-dir>/data` — `.json` files; each top-level array key is a normalized entity name; elements are records (nested children are hoisted per parent/foreign-key rules).
- **Output** (`<working-dir>/output/`):
  - `consolidated.schema.json` – JSON Schema for the merged model (`$schema` 2020-12, entity defs under `$defs`). With **`--close-fk-enums`**, includes root `x-fkEnumFromData: true` and `enum` on FK properties derived from loaded data.
  - `consolidated_data.json` – wrapper with `version`, `timestamp`, optional `model` metadata, `data` (nested entity tree), and `change`.
  - `consolidation_log.txt` – step log (when not in a browser-like environment).
  - With `--js`: `consolidated.schema.js`, `consolidated_data.js`.

`output/` is created if missing.

## GitHub Action

```yaml
- uses: exergy-connect/xFrame.ai/actions/consolidate@main
  with:
    working-dir: path/to/project
    note: 'Reconsolidate after model or data change'
```

## Example

```bash
node actions/consolidate/consolidate.min.js --note "Add field_reserves composites; update lifecycle dates from source" \
  --author "ci" --git-commit-hash "$(git rev-parse HEAD)" --js
```

**Example with FK enum closure** (schema enums on FK fields match primary keys in the loaded dataset; re-run after data changes):

```bash
node actions/consolidate/consolidate.min.js --note "Reconsolidate with FK enums closed to PKs present in loaded data" \
  --author "ci" --git-commit-hash "$(git rev-parse HEAD)" --js --close-fk-enums
```

## Errors

- Missing `data/` or `model/` under the working directory → exit 1.
- Invalid `--data-include` or `--data-exclude` regex → exit 1.
- Consolidation or I/O failure → logged; exit 1.
- Success → exit 0; paths logged as above.
