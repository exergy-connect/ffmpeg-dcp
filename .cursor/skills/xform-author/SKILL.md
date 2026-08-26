---
name: xform-author
description: Authors and edits xForm .xp / .xpt semantic documents—front matter concepts, shapes (_attributes), opaque Jinja body segments, includes, templates, and _capability contracts. Use when creating or modifying .xp files, defining concepts or shapes, writing slide/lab content, structuring a concept tree, or declaring capability transformations and executors. For compiling outputs, use the xform-run skill.
---

# Create `.xp` documents

Author **structured semantic documents** for xForm. Prefer meaning and concept
structure over presentation strings. Compile with the **xform-run** skill.

## File shape

Every `.xp` / `.xpt` is a stream of YAML-style documents delimited by whole-line
`---` (or `...`).

1. **Front matter** (first document) — top-level keys are **concepts** (shapes,
   bindings, data). Exception: compiler-owned `_assert`.
2. **Body segments** (later documents) — opaque Jinja-rendered content. YAML-like
   text in a body is not parsed as a concept instance or validated as a shape.
3. Optional **segment header**: YAML keys, then a line that is exactly `===`,
   then the segment body. Header keys are local to that segment. `_id` names
   the segment for `include(..., segments=...)`.

```yaml
---
greeting: Hello
note:
  _attributes:
    label: _string
    _content: _string
---
===
{{ greeting }}
```

| Extension | Role |
|-----------|------|
| `.xp` | Document sources |
| `.xpt` | Templates (implicit `_templates` or `{% include %}`) |
| `.json` | Runtime concept bindings (compile-time merge) |
| `.js` | Jinja filter modules |

## Concepts and shapes

- **User concepts** describe domain meaning. Names must not start with `_`.
- **Framework concepts** use the reserved leading `_` (`_document`, `_templates`,
  `_realizations`, `_attributes`, `_content`, `_assert`, `_capability`, …).
- **Shapes** declare allowed directive fields via `_attributes` (type name,
  enum list, `{ _type?, _required? }`, `{ _concept? }`, or
  `{ _dict: Shape }` for a named set of Shape instances). Optional `_format`:
  `content` | `xml` | `binary`.
- **Collections:** `[Shape]` = ordered list of Shape; `{ _dict: Shape }` =
  dict/set keyed by name whose values are Shape.
- Put semantic instances in front matter (usually with `_concept`) or create
  them through filters/capabilities. Do not rely on YAML-looking body text to
  mutate the concept tree.

`_required` is enforced only at finalization (`--final`), not at first parse.
Unresolved Jinja may remain until a target forces resolution.

## Concept hierarchy

Model hierarchy with **nested concepts and attributes**, not with `_` in names.

**Anti-pattern:** encode a path in a flat name (`network_interface_vlan`,
`slide_title_style`). Underscores do not create parent/child structure — they
only make a longer identifier. Hierarchy belongs in the concept tree (nested
bindings, attributes, and `_concept` relationships).

```yaml
# Prefer
network:
  interface:
    vlan: …

# Avoid
network_interface_vlan: …
```

Compound instance labels (`small_turtle`) are fine when they name one thing,
not a fake hierarchy.

## Capabilities

Declare a semantic transition at any dotted path below `_capability`. A contract
is a named mapping with `_input`, `_output`, or `_realization`; namespace mappings need none of
them. `_document._final` or CLI `--target` selects a dotted path.

### Pure Jinja realization

Use `_realization.jinja` for an in-process transformation. During realization the
declared input concept is also available as `_input`. Fully resolved Jinja
fields inside it are materialized plain scalars, arrays, and objects before a
filter sees them.

```yaml
---
_capability:
  graph:
    render:
      _input: graph
      _output: graph_svg
      _realization:
        jinja: "{{ _input | to_svg_graph }}"

graph:
  series: "{{ awards | awards_to_depth_series }}"

_document:
  _final: graph.render
---
===
{{ graph_svg | default('') }}
```

Do not unwrap `_raw` / `_value` in user filters. Resolved bindings are
materialized at filter and capability boundaries; unresolved bindings remain
deferred.

### External executor alternatives

Named mappings under `_realization` are replaceable realizations. Capability attributes
(`_realization`, `_commands`, `_assert`, …) inherit down the YAML tree:
resolve at the current node, then walk parents until found; a child that
redeclares the key replaces the whole value. Declare `_realization` on a
namespace to share realizations with every child contract.

`_realization` may bind concept `_realizations`: `_realization: storage_implementation`
or named Jinja refs into that catalog. Use `_realizations` (not `_templates`) for
capability backend catalogs; keep `_templates` for document/style selection.
expands every template id under that concept, or name slots explicitly with
`{{ storage_implementation['neo4j'] }}`. `.xpj` templates become javascript
realizations. Prefer one with
CLI `--with <capability.path>=<name>` (e.g. `--with persist.store=neo4j`, or
`--with persist=neo4j` for every capability under that prefix). `_document._executor`
is a global fallback. `which()` resolves an
executable on `PATH`. `_version` output and resolved `_env` participate in the
approval identity.

Scope-local string fields (non-`_` keys) merge root→leaf independently — closer
names win — because they are not a single attribute map.

`_input` may be a type/concept name, or a mapping with optional `_content` (the
default `_input` binding) plus ambient parts resolved from the concept tree by
name. Omit `_content` for nullary ops used as values (`{{ persist.list | to_json }}`):
`_input: { _content: _string, $persistence: persistence }` exposes `{{ _input }}`
and `{{ $persistence.url }}` / `_xform.concepts.persistence`. Parameter names must
differ from the concept they bind (prefer `$concept` when the names would collide).

```yaml
_capability:
  tools:
    _commands:
      node:
        _command: "{{ which('node') }}"
        _version: "{{ _command }} --version"
        _env:
          NODE_OPTIONS: "--no-warnings"
          HTTPS_PROXY:                 # null: pass through the OS value
        _install: "installer-command" # optional approved bootstrap
    uppercase:
      _input: _string
      _output: _string
      _assert:
        - test: "{{ _input | length > 0 }}"
          message: input must not be empty
      _realization:
        node:
          _args: "-p process.argv[1].toUpperCase() '{{ _input }}'"
        portable:
          jinja: "{{ _input | upper }}"
```

`_args` composes with the same-named inherited `_commands` alias and avoids a
self-reference such as `_command: "{{ _command }} …"`. An executor may instead
author `_command` directly and may override `_version`.

### Dependencies, locals, and filter invocation

- `_depends._capability` walks another declared capability path; the leaf value
  becomes that dependency's input. Pure-Jinja dependencies can run during plan.
- Non-underscore string fields on capability/namespace nodes are realization-
  local bindings. Locals, `_assert`, and `_commands` inherit down the path;
  nearer scopes override aliases/locals.
- A capability is callable as a dotted Jinja filter. The piped value binds to
  its declared input: `{{ greeting | text.uppercase | _final() }}`.
  Named arguments bind ambient `_input` parts (when the contract declares them):
  `{{ prompt | llm.complete($llm=gemini.gpt-4o) }}`.
- `_id` on a capability package indexes it for device `_capabilities` lookup.
- Successful command execution binds `_output` only after approval/run, with
  `_result`, `_approval._source`, `_command`, `_exitcode`, `_exectime`, and
  `executedAt`. Pure Jinja realization binds its native result directly.

### API export

Set `_api: _true` on a contract to export a change workflow. After **Deploy
API**, callers use `GET|POST /api/<app>/<capability…>`; POST body binds to
`_input` and the realized `_output` is returned. App name is top-level `_id`,
otherwise the `.xp` basename. Ordinary compile does not install routes. See
`examples/api/`.

### Process environment (`_env`)

The compiler binds a built-in **`_env`** concept from `process.env` (string
values) for Jinja and concept fields: `{{ _env.OPENROUTER_API_KEY }}`. This is
**not** the same as capability `_commands.<alias>._env` (spawn env policy for
external executors).

## Composition patterns

- **Concept templates:** declare `style._templates:
  file://./templates/style/`, then bind `_document.style: title` to load
  `templates/style/title.xpt`; authored root fields deep-merge over defaults.
- **Capability realizations:** declare `storage_implementation._realizations`
  over `impl/*.xpj`, then bind persist `_realization` from that catalog.
- **Includes:** `{% include "….xpt" %}` or
  `{{ include("other.xp", segments=["title"]) }}`.
- **Assertions:** `_assert: [{ test: "{{ … }}", message: "…" }]` in front matter
  or a segment header (not as bare body text).

## Minimal checklist

- [ ] Front matter closed with `---` / `...` before body segments
- [ ] Shapes use `_attributes`; semantic instances live outside opaque bodies
- [ ] Hierarchy is nested concepts, not underscore-joined names
- [ ] User concept names do not start with `_`
- [ ] Compile with the **xform-run** skill when the user wants output
