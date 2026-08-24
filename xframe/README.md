# xFrame Social Media Transcoder

Self-contained under `xframe/`. Does **not** modify the root `app.js` / `ffmpeg-wasm/` / `src/` pipeline.

Accepts a browser `MediaRecorder` WebM (VP8/VP9 + Opus), lets the user pick any set of social placements (feed and/or vertical per platform), deduplicates identical format signatures (Instagram/Facebook Meta share), and dispatches `(chunk × unique format)` units on DCP. Finished segments remux to H.264/AAC MP4 upload masters with `+faststart`.

## Layout

| Path | Role |
| --- | --- |
| [`dcp-transcoding.xp`](dcp-transcoding.xp) | Semantic concepts: platforms, placements, format specs, pipeline, dispatch |
| [`templates/_final/html.xpt`](templates/_final/html.xpt) | HTML final template |
| [`dcp-transcoding.js`](dcp-transcoding.js) | Browser runtime |
| [`ffmpeg-worker.js`](ffmpeg-worker.js) | Local WASM: `slice_webm`, `remux_to_mp4` |
| [`dcp-deploy-worker.js`](dcp-deploy-worker.js) | Base64 input-set prep |
| [`src/dcp-transcode.c`](src/dcp-transcode.c) | Forked work-function + social APIs |
| [`build.sh`](build.sh) | WASM build with VP8/VP9/Opus |
| [`package/`](package/) | Distinct DCP package `ffmpeg-wasm-social` |
| [`output/dcp-transcoding.html`](output/dcp-transcoding.html) | Compiled app (after xForm) |

## Compile the UI

Requires Node ≥24 and the installed xForm skill:

```bash
cd xframe
bash ffmpeg-wasm/build.sh
bash scripts/compile.sh
# equivalent:
#   node ../.cursor/skills/xform-run/scripts/xform.min.js dcp-transcoding.xp
#   node scripts/build-html.js
node scripts/verify-concepts.js
```

The compile step stages the HTML, browser scripts, workers, images, and custom
WASM under `output/`. That directory is the complete static deployment root:

```bash
cd /workspaces/ffmpeg-dcp/xframe/output
python3 -m http.server 8765
# open http://127.0.0.1:8765/dcp-transcoding.html
```

The custom WASM module is single-threaded and does not require
`SharedArrayBuffer` or cross-origin isolation headers.

## Build WASM

`src/dcp-transcode.c` + `build.sh` produce the custom single-threaded
VP8/VP9/Opus WebM → H.264/AAC implementation used both locally and on DCP.
The build writes `ffmpeg-wasm/dcp-transcode-glue.js` and
`ffmpeg-wasm/dcp-transcode.wasm`.

Publish for DCP:

```bash
cd xframe
bash ffmpeg-wasm/build.sh
node package/build-bravojs-bundle.js
# then publish package/ as name ffmpeg-wasm-social (see package/package.dcp)
```

The Docker build fetches and compiles the required Emscripten, FFmpeg, and
OpenH264 sources without using the root app’s build cache.

Build the WASM before compiling the UI; `scripts/compile.sh` fails if either
WASM runtime artifact is absent, preventing an incomplete deployment. For
HTML-only development, set `ALLOW_MISSING_WASM=1`.

## Parallelism

1. **Serial:** probe + keyframe-aligned WebM slice (~90 frames / ~3 s).
2. **Parallel (DCP):** one slice per `(chunk, unique format signature)` when “Max distribution” is on; otherwise one slice per chunk encoding every unique format inside the worker.
3. **Parallel (browser):** each unique signature remuxes to MP4 independently after ordered concat.
4. **Dedupe:** Instagram feed and Facebook feed share signature `1080x1350-7000-160-30` → one encode, two download names.

## Framing

- **Fill (cover):** center crop to placement aspect (default for social masters).
- **Fit (contain):** letterbox/pillarbox pad when the full frame must be preserved.
