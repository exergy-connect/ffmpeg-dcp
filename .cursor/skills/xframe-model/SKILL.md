---
name: xframe-model
disable-model-invocation: true
description: Create or edit model and data files for xFrame consolidation. Use when authoring entity schemas, model YAML/JSON, data JSON, or any input to the xframe-consolidate skill.
---

# xframe-model

Author **model** files (entity schemas) and **data** files (entity records) for [xFrame](https://github.com/exergy-connect/xFrame). After authoring, run the **xframe-consolidate** skill (or script) to validate and produce `consolidated_model.json` / `consolidated_data.json` under `output/`.

## When to use

- User wants to **define entities**, **model schema**, or **data** for xFrame.
- User is creating or editing files under `model/` or `data/` for consolidation.
- User mentions **xFrame model**, **entity**, **`type`** (field type container), **primary key**, **foreign key**, or **consolidate input**.

## Directory layout

- **model/** – One or more files defining entities and fields (merged into one schema). In this repo’s Python consolidator, **`*.yaml` / `*.yml`** are discovered; JSON with the same logical shape is valid for tooling, docs, and pipelines that accept it.
- **data/** – One or more **JSON** files with entity data, keyed by entity name. Often a single `sample_data.json` with multiple top-level entity keys.

## Version

Installed: `.cursor/skills/.xframe-latest`
```bash
bash <(curl -fsSL https://exergy-connect.github.io/xFrame.ai/install-skills.sh) [--check|--update]
```

## Meta-model rules (YANG / JSON Schema)

These match **`src/xframe/yang/meta-model.yang`** and the exported **`meta-model.yang.json`** (JSON Schema with `x-yang` hints; e.g. under `examples/` in the xYang repo).

| Level | Requirement |
|--------|----------------|
| **Data model** | `name`, **`version`** (`YY.MM.DD.N`, pattern `^\d{2}\.\d{2}\.\d{2}\.\d+$`), `author`, **`description`** |
| **Entity** | `name`, **`description`**, `primary_key`, `fields` (and usually `brief`); optional **`parents`** for hierarchical nesting under a parent’s array field |
| **Field** | `name`, **`description`**, and a **`type`** object (see below) |

Optional: `source` at model, entity, or field level (where the data comes from).

Model files on disk are **unwrapped** (`name`, `version`, `entities`, …); the consolidator wraps them under `data-model` for YANG validation.

## Field types: `type` container (canonical)

Each entity field uses a **`type`** object: exactly one branch of **`definition`**, **`primitive`** (+ optional constraints), **`array`**, or **`composite`**. This is what **`meta-model.yang.json`** describes under `entities[].fields[].type`.

**`foreignKeys`** belong **inside `type`**, next to **`primitive`** or **`definition`**, not as a sibling of `type`. Each `foreignKeys` entry is **`entity`** plus optional **`field`** (alternate key on the referenced entity; must not be the referenced primary key). **Do not** put **`parent_array`** on `foreignKeys` anymore (removed in YANG revision **2026-05-12**; see **`entities[].parents`** below).

xFrame loads this shape and **normalizes** it internally to `field_type` / `item_type` / top-level `foreignKeys` for JSON Schema generation (`convert_yang_type_container_to_legacy` in `metamodel.py`). You may still encounter **`field_type`** + **`item_type`** in docs or legacy files; prefer **`type`** for new authoring.

### Primitives

Allowed **`primitive`** values (typedef `primitive-type-name`): `string`, `integer`, `number`, `boolean`, `array`, `datetime`, `date`, `duration_in_days`, `qualified_string`, `qualified_integer`, `qualified_number`.

```json
"type": { "primitive": "string" }
```

### Arrays

**`type.array`** is an object with exactly one inner branch: **`entity`** (leafref to another entity), **`primitive`** (+ optional `enum`, `min`, `max`, …), or **`composite`** (list of subfields).

```json
"type": {
  "array": {
    "entity": "department"
  }
}
```

```json
"type": {
  "array": {
    "primitive": "string",
    "min": 1,
    "max": 64
  }
}
```

There is **no** `item_type` key in the YANG-shaped JSON; that name appears only on the **normalized** / legacy structure.

### Composite primary keys / structured fields

Subcomponents are full generic-fields: each has **`name`**, **`description`**, and **`type`**.

```json
"type": {
  "composite": [
    {
      "name": "part_a",
      "description": "First segment of the composite key.",
      "type": { "primitive": "string" }
    },
    {
      "name": "part_b",
      "description": "Second segment.",
      "type": { "primitive": "integer" }
    }
  ]
}
```

### Reusable definitions (`field_definitions` on an entity)

```json
"type": { "definition": "positive_number" }
```

Optional **`foreignKeys`** on the same `type` object when the field references another entity by PK type. Do not chain `definition` → `definition` inside `field_definitions` (meta-model `must`).

If an entity has no reusable definitions, **omit** `field_definitions`; do **not** use an empty array `[]` (meta-model treats an empty list as invalid).

### Foreign keys (scalar and composite subfields)

Reference another entity by primary key (default) or by a **`unique`** field named in **`foreignKeys[].field`**.

```json
"type": {
  "primitive": "string",
  "foreignKeys": [{ "entity": "company" }]
}
```

Alternate key (non-PK field on `company` marked `unique: true`):

```json
"foreignKeys": [{ "entity": "company", "field": "external_code" }]
```

The same `foreignKeys` shape applies on a **composite** subfield’s `type` when that subcomponent carries the FK (including composite PKs and composite non-PK fields).

### Entity-level `parents` (hierarchical nesting)

As of **`meta-model.yang`** revision **2026-05-12**, **where** a child nests under a parent is declared on the **child entity**, not on the FK:

- Add **`parents`**: a list of `{ "entity": "<parent_entity>", "parent_array": "<array_field_on_parent>" }`.
- Keep the **materializing FK** on the child: exactly **one** field path on that child must reference the same parent `entity`—either a top-level field, an **inline** composite subfield, or a **one-hop** composite inside a `field_definitions` entry referenced by `type.definition` (YANG counts all three). That FK’s `type` matches the parent’s primary key (or `field` if used); it does **not** repeat `parent_array`.

**`parents.parent_array`** must name a field on the parent entity whose **`type.array.entity`** equals the **child** entity’s `name` (validated in YANG). Prefer a direct **`type.array`** branch on that parent field so the array’s item entity is explicit.

**`entity.index`**: omit **`parents`** on the same entity if you use per-PK sharding `index` (mutually exclusive in YANG).

**Multiple nesting edges**: A child may list several **`parents`** entries (distinct parent **`entity`** values). The consolidator builds the materializing FK field list in **`parents` declaration order** (Python `ConsolidatedModel.parent_fk_map`); nesting then follows that order together with reverse topological processing. See **`tests/integration/composite_fk_parent_array`** and **`tests/integration/basecase`** in the xFrame repo.

Example (department under `company.departments`, FK on `company_id`):

```yaml
# child entity
name: department
primary_key: department_id
parents:
  - entity: company
    parent_array: departments
fields:
  - name: company_id
    description: FK to parent company; nesting uses parents above, not parent_array on foreignKeys.
    type:
      primitive: string
      foreignKeys:
        - entity: company
    required: true
  # ... other fields including type.array -> employee if nested
```

JSON equivalent for `parents`:

```json
"parents": [{ "entity": "company", "parent_array": "departments" }]
```

**Legacy:** Older models and docs may show **`parent_array` inside each `foreignKeys` object**. Replace that with **`parents`** on the child entity and `foreignKeys` entries that only declare **`entity`** (and optional **`field`**) so validation matches current YANG and the Node consolidator meta-model.

### Outliers (sigma flagging)

Inside **`type`** with a numeric or date/datetime **`primitive`**:

```json
"type": {
  "primitive": "integer",
  "outlier": 1.0
}
```

Range `0.1`–`4.0`. Omit `outlier` to disable.

### Enumerations (`enum`)

In **`meta-model.yang.json`**, **`enum`** is a **leaf-list inside `type`**, alongside **`primitive`**, when the primitive is `string`, `integer`, or `number`. xFrame may **hoist** `enum` to the field after load for JSON Schema paths.

**Heuristic:** Only use `enum` when values are a **small, stable** closed set (on the order of fewer than about ten distinct codes), not free text or high-cardinality IDs.

Example (string codes):

```json
{
  "name": "status_cd",
  "description": "Lifecycle status; closed set from source system.",
  "type": { "primitive": "string", "enum": ["A", "P", "C", "X"] },
  "required": true
}
```

Example (integer codes):

```json
{
  "name": "priority",
  "description": "1=low, 2=medium, 3=high.",
  "type": { "primitive": "integer", "enum": [1, 2, 3] },
  "required": true
}
```

You may also place **`enum`** at field level in some pipelines; consolidation normalizes toward the internal shape.

## Model file shape (JSON)

Top-level keys of the file (same as inner `data-model` in the JSON Schema):

```json
{
  "name": "My Model",
  "version": "26.03.29.1",
  "author": "Author Name",
  "description": "Required: what this model is for and main entities.",
  "source": "Optional model-level data source (e.g. URL, Excel file, API endpoint)",
  "entities": [
    {
      "name": "<entity_name>",
      "brief": "Short description",
      "description": "Required: AI-friendly entity description.",
      "source": "Optional entity-level data source",
      "primary_key": "<field_name>",
      "fields": [
        {
          "name": "<field_name>",
          "description": "Required: field semantics and constraints.",
          "type": { "primitive": "string" },
          "required": true,
          "source": "Optional field-level data source",
          "computed": {
            "operation": "add | subtraction | multiplication | division | min | max | average",
            "fields": [
              { "field": "<field_name>" },
              { "field": "<field_name>", "entity": "<entity_name>" }
            ]
          }
        }
      ]
    }
  ]
}
```

Use **`type.foreignKeys`** (inside `type`) for FK scalars instead of a top-level **`foreignKeys`** key in new models. Use **`entities[].parents`** for nesting; do not put **`parent_array`** on `foreignKeys`.

- **parents**: Optional on a child entity; each entry names the parent **`entity`** and the parent’s child-owning **`parent_array`** field. Requires exactly one matching FK path on that child to that parent, per YANG `must` rules.
- **field_definitions**: Include only when you define at least one reusable type; otherwise omit the key (never `[]`).
- **primary_key**: Name of the PK field (string). Composite PK: one field whose **`type`** is **`composite`**.
- **computed**: Defined on the field; omit from data JSON.
- **allow_unlimited_fields**: In JSON Schema this is an **empty object** `{}` when present (YANG `empty`).

## Data JSON structure

Use the **entity name** as the top-level key; value is a **list of records**. Nested children sit under the parent’s array field name. If scalar FK fields are **`required: true`** in the model, include them on nested rows (e.g. `company_id` on each department, `department_id` on each employee).

```json
{
  "company": [
    {
      "company_id": "acme",
      "company_name": "ACME Corp",
      "departments": [
        {
          "department_id": "eng",
          "department_name": "Engineering",
          "company_id": "acme",
          "employees": [
            {
              "employee_id": "alice",
              "employee_name": "Alice",
              "department_id": "eng"
            }
          ]
        }
      ]
    }
  ]
}
```

- PK and FK values must match the model; referenced rows must exist where required.
- Omit computed fields in input data.

## After authoring

Run **xframe-consolidate** (skill or `actions/consolidate/consolidate.min.js`) using **`--working-dir`** (default `xframe`): model and data live under `xframe/model` and `xframe/data`; output is `xframe/output`.

## References

- Example model + data: `assets/example-model.jsonc`, `assets/example-data.jsonc` (Company → Department → Employee; JSONC with comments).
- Authoritative YANG: `src/xframe/yang/meta-model.yang` in the xFrame repo.
- JSON Schema export (same module, property names for **`type`**, **`foreignKeys`**, **`array`**, etc.): `meta-model.yang.json` (e.g. `examples/meta-model.yang.json` in the [xYang](https://github.com/exergy-connect/xYang) repo, generated from the YANG).
- Consolidation: **xframe-consolidate** skill or project consolidator CLI.
