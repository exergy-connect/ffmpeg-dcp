---
name: xframe-present
description: Compiles .xp authoring documents (YAML front matter + Markdown segments) through normalized IR into HTML, PNG, PowerPoint, Word (.docx), and narrated H.264 MP4. Supports presentations (slidedeck, poster, readout, cover-letter), formats (desktop/tablet/mobile/poster/video), themes/styles, @layout/@region/@graph/@image/@narrative, Jinja templates, llm() / text_to_speech filters, and consolidated xFrame data. Use when building slides, decks, posters, .xp files, xframe-build, html2mp4, or exporting HTML/PNG/PPTX/DOCX/MP4.
---

# Present (xFrame)

Compile `.xp` to IR, HTML, PNG, PowerPoint, Word, and/or narrated MP4. Edit the `.xp` source and recompile; do not edit generated `.html` or `.xp.json`.

## Run

The CLIs are published with the GitHub Action bundle. After `install-skills.sh`, this skill's `install.sh` copies them and the YANG models into the installed skill:

```bash
node .cursor/skills/xframe-present/scripts/present.min.js <input.xp> [options]
```

In the xFrame.ai repository:

```bash
node actions/present/present.min.js <input.xp> [options]
```

Default outputs: IR + HTML. `.xp` must start with a closed YAML fence (`---` … `---`).

| Option | Description |
|--------|-------------|
| `--ir` `--html` `--png` `--pptx` `--docx` | Outputs. If omitted, writes IR and HTML. |
| `--screenshots` | With `--pptx`: photograph each HTML slide as a full-bleed PNG (same canvas as `--html`). |
| `-o, --out-dir <dir>` | Output directory (default: beside input). |
| `--presentation <name>` | `slidedeck`, `poster`, `readout`, `cover-letter`, … |
| `--format <name>` | `desktop`, `tablet`, `mobile`, `poster`, `cover-letter`, `video` |
| `--theme <name[,name...]>` | Repeatable. Built-ins: `light`, `dark`. |
| `--style <name[,name...]>` | Repeatable. |
| `--evaluation <static\|dynamic>` | Template / LLM evaluation. |
| `--positioning <static\|dynamic>` | Layout geometry. |
| `--templates <dir>` | Extra `.xpt` root. |
| `--content-plugin <module>` | Repeatable. |
| `--force-content-plugins` | Rebuild `.xframe/content-cache/`. |
| `--embed-images` | Inline local images in HTML (or set `embed_images: true` in front matter). |
| `--llm` | Enable compile-time `llm()`. |
| `--llm-model <name>` | LLM model override. |
| `--skip-audio` | Do not run TTS; reuse existing clips; omit audio from HTML and PPTX. |
| `--force-audio` | Regenerate TTS. Not with `--skip-audio`. |
| `--combined-audio` | One deck TTS track. |
| `--combined-pause <seconds>` | Pause between combined-track slides (default 3). |
| `--snapshot-canvas` | PNG sized to canvas; strip chrome. |
| `--snapshot-width` / `--snapshot-height` | PNG size (default 1440×900). |
| `-h, --help` | Usage. |

`--png` requires Chrome or Chromium (`XFRAME_CHROME_PATH` if needed).

Outputs in `--out-dir` (basename = input without extension):

- `--ir` → `<base>.xp.json`
- `--html` → `<base>.<presentation>.html`
- `--png` → `<base>.<presentation>.png` or `<base>.<presentation>.<format>.png` when those names differ
- `--pptx` → `<base>.<presentation>.pptx`
- `--docx` → `<base>.<presentation>.docx`

Exit 0 success (`Wrote <path>` on stderr), 1 compile/I/O, 2 usage.

```bash
node actions/present/present.min.js deck.xp --html
node actions/present/present.min.js deck.xp --evaluation dynamic --theme dark --html
node actions/present/present.min.js flyer.xp --presentation poster --format poster --html --png
node actions/present/present.min.js deck.xp --pptx -o dist/
node actions/present/present.min.js resume.xp --docx -o dist/
```

## MP4

Encode narrated H.264 with the separately published `html2mp4.min.js`. Input is `.xp` or `.xp.json`, not HTML. Requires Chrome or Chromium (`XFRAME_CHROME_PATH`), `ffmpeg`, and `ffprobe` (`FFMPEG_PATH` / `FFPROBE_PATH`). Compiling `.xp` forces `format: video` (logical canvas 1280×720 from `slidedeck-video`; output 1920×1080 unless `--width` / `--height`). HUD and chrome are hidden. Local animated `<img>` GIFs are composited; remote GIFs and CSS backgrounds are not.

After skill installation:

```bash
node .cursor/skills/xframe-present/scripts/html2mp4.min.js <input.xp|input.xp.json> -o <output.mp4> [options]
```

In the xFrame.ai repository or this source repository:

```bash
node actions/present/html2mp4.min.js <input.xp|input.xp.json> -o <output.mp4> [options]
npm run html2mp4 -- <input.xp|input.xp.json> -o <output.mp4> [options]
node dist/html2mp4/cli.js <input.xp|input.xp.json> -o <output.mp4> [options]
```

Pipeline in memory: compile → optional select → optional resolve → encode. Each slide is held for its `@narrative` audio plus `narrative.pause_seconds` (`--pause` wins; 0.75s if no narrative). Slides without audio use `--slide-duration` (default 5). The last slide adds `--outro-delay` / `video.outro_delay` (default 7). Missing clips are synthesized at encode time; existing `audio/<slide>-<locale>.*` are reused. Narrative language/text must be concrete — unresolved Jinja needs `--vars` / `--set` (or standalone `ir-resolve`) first.

| Option | Description |
|--------|-------------|
| `-o, --output <file>` | Required MP4 path. |
| `--language <locale>` | Narrative language, exact or base locale (default: first). |
| `--pause` `--outro-delay` `--slide-duration` | Timing in seconds. |
| `--slides <spec>` `--ids <id[,id...]>` `--ai-path` `--ai-context <text\|file>` | In-memory `ir-select`. `--ai-path` needs context (CLI or `video.ai_context`); not with `--slides` / `--ids`. |
| `--vars <file.json>` `--set <name=value\|name=@file>` | In-memory `ir-resolve`. |
| `--transition <name>` | `none`, `fade` (default), `wipeleft`, `wiperight`, `slideleft`, `slideright`. `none` stream-copies; others re-encode. |
| `--transition-duration <sec>` | Overlap (default 0.5; ignored when `none`). |
| `--iphone` | H.264 High Profile Level 4.1 + AAC for iPhone. |
| `--preset` `--crf` `--tune` `--threads` | libx264 (defaults: `medium`, 18, `stillimage`, 0=auto). CI: `ultrafast`, 26, 2 threads. |
| `--snapshot-delay <ms>` | Wait before screenshot / GIF measurement (default 1500). |
| `--chrome` `--ffmpeg` `--ffprobe` | Executables. |
| `--source-root <dir>` | Override the source base recorded in IR when `.xp.json` and its assets have been relocated. |

```yaml
narrative:
  pause_seconds: 3
video:
  outro_delay: 10
  ai_context: prompts/ai-video.md   # or inline notes; seeds --ai-path
```

```bash
node .cursor/skills/xframe-present/scripts/html2mp4.min.js deck.xp -o deck.mp4 --language en-US --transition fade
node .cursor/skills/xframe-present/scripts/html2mp4.min.js deck.xp -o cut.mp4 --slides 1,4,9 --language en-US
node .cursor/skills/xframe-present/scripts/html2mp4.min.js deck.xp -o tailored.mp4 --ai-path --ai-context "Network architect" --language en-US
```

Or isolate stages on disk: `ir-select` → `ir-resolve` → `html2mp4` on `.xp.json`. This repo's GitHub workflow is `.github/workflows/build-video.yml` (`workflow_dispatch`; prefers `--transition none` on free-tier).

## GitHub Action

```yaml
- uses: exergy-connect/xFrame.ai/actions/present@main
  with:
    source: path/to/deck.xp
    formats: ir,html
```

## Author `.xp`

```markdown
---
presentation: slidedeck
themes: [light, dark]
title: My Talk
---
@id cover
@layout cover
# Title

---
@id agenda
# Agenda

- Item
```

- Front matter: YAML between the first two `---` lines.
- Segments: split on a line that is only `---`.
- Body: GFM Markdown. `{{ … }}` is Jinja (compile-time unless `evaluation: dynamic`).

Front matter: `presentation`/`presentations` (default `slidedeck`), `format`/`formats` (default `desktop`, or `poster` for poster), `themes`/`theme`, `styles`/`style`, `css_imports` (stylesheet URLs; also on style/theme `.xpt` front matter — compiled to IR `css.imports` and `<link rel="stylesheet">` in the HTML head, not `@import` inside pane CSS), `title`, `subtitle`, `author`, `lang`, `layout`, `data`, `topic`, `llm`, `evaluation`, `header`, `footer`, `header-image`, `footer-image`, `narrative`, `video`.

Segment head: `@id`, `@layout <name>` (optional indented YAML), `@theme`, `@evaluation`, `@presentation`, `@format`, `@class`, `@walkthrough pause=true`.

Body: `@region <name>`, `@graph` (YAML spec; needs `data`), `@image`, `@html`, `@map`, `@qr_code`, `@page-break` (`header.continue`, default true), `@table`, `@narrative`, `@include <path>` (relative; optional `#fragment` or `segments:` range).

### `@html`

Host an interactive HTML artifact (not a Markdown HTML leak; not `@include`; not `@image` with a `.html`).

```xp
@html
  url: charts/sankey.html
  title: Contractor Sankey
  mode: iframe
  sandbox: allow-scripts allow-same-origin
  embed: true
  click_to_zoom: true
```

- `url` XOR `content` (fragment). Paths resolve relative to the `.xp`; with `--out-dir`, local files are hard-linked/copied into the output tree (unless `embed: true`).
- `mode: iframe` (default) isolates a full document. `inline` / `srcdoc` accept fragments only.
- `embed: true` gzip+base64 embeds the local file or fetched remote document into the deck; the browser inflates on load (`DecompressionStream`). Self-contained artifacts only.
- Interactive in `--html`; PNG / screenshot PPTX / MP4 photograph the iframe. Missing local file or failed embed fetch is a compile/build error with the resolved path or URL.
- `click_to_zoom` (default true) adds host chrome that opens a full-viewport overlay of the iframe.

```yaml
data:
  static: consolidated_data.json
```

Data paths are relative to the `.xp` file.

`{{ topic | llm("prompts/….md", cache=true) }}` needs `--llm` at compile time. Dynamic: `evaluation='dynamic'` or `--evaluation dynamic`. TTS: `@narrative` / `text_to_speech`; `--skip-audio` to skip synthesis. Gemini-only director brief: front matter `narrative.direction` (`profile`, `scene`, `style`, `accent`, `pacing`, `notes`) and optional slide `@narrative` `direction` overlay.
