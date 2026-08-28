# xFrame Social Media Transcoder

Self-contained under `xframe/`. Does **not** modify the root `app.js` / `ffmpeg-wasm/` / `src/` pipeline.

Accepts a browser `MediaRecorder` WebM (VP8/VP9 + Opus), lets the user pick any set of social placements (feed and/or vertical per platform), deduplicates identical format signatures (Instagram/Facebook Meta share), and dispatches `(chunk × unique format)` units on DCP. Finished segments remux to H.264/AAC MP4 upload masters with `+faststart`.

## Layout

| Path | Role |
| --- | --- |
| [`dcp-transcoding.xp`](dcp-transcoding.xp) | Semantic concepts: platforms, placements, format specs, pipeline, dispatch |
| [`worker.xp`](worker.xp) | Browser worker page concepts (dcp.live-style Start/Stop + optional comment) |
| [`templates/_final/html.xpt`](templates/_final/html.xpt) | Transcoder HTML final template |
| [`templates/worker/_final/html.xpt`](templates/worker/_final/html.xpt) | Worker HTML final template |
| [`dcp-transcoding.js`](dcp-transcoding.js) | Browser runtime |
| [`worker.js`](worker.js) | Browser worker runtime |
| [`ffmpeg-worker.js`](ffmpeg-worker.js) | Local WASM: `slice_webm`, `remux_to_mp4` |
| [`dcp-deploy-worker.js`](dcp-deploy-worker.js) | Base64 input-set prep |
| [`github-transcode-client.js`](github-transcode-client.js) | GitHub upload + workflow dispatch for **Transcode via GitHub** |
| [`dcp-gh-runner/`](dcp-gh-runner/) | Browser DCP package: JIT GitHub runner + transcode + LinkedIn |
| [`github/`](github/) | JIT GitHub Actions self-hosted runner (Node CLI for local dev / CI) |
| [`src/dcp-transcode.c`](src/dcp-transcode.c) | Forked work-function + social APIs |
| [`build.sh`](build.sh) | WASM build with VP8/VP9/Opus |
| [`package/`](package/) | Distinct DCP package `ffmpeg-dcp-social-v2` |
| [`output/dcp-transcoding.html`](output/dcp-transcoding.html) | Compiled transcoder (after xForm) |
| [`output/worker.html`](output/worker.html) | Compiled browser worker (after xForm) |

## Compile the UI

Requires Node ≥24 and the installed xForm skill:

```bash
cd xframe
bash ffmpeg-wasm/build.sh
bash scripts/compile.sh
# equivalent:
#   node ../.cursor/skills/xform-run/scripts/xform.min.js dcp-transcoding.xp --tree --final html
#   node scripts/build-html.js
node scripts/verify-concepts.js
```

The compile step stages the HTML, browser scripts, workers, images, and the
checked-in [`ffmpeg-wasm/`](ffmpeg-wasm/) runtime under `output/`. This keeps
the generated directory self-contained for GitHub Pages and local serving:

```bash
cd /workspaces/ffmpeg-dcp/xframe/output
python3 -m http.server 8765
# open http://127.0.0.1:8765/dcp-transcoding.html
# open http://127.0.0.1:8765/worker.html
# (transcoder worker fetches ./ffmpeg-wasm/dcp-transcode.wasm)
```

### Browser worker page

Mobile-first Start/Stop page at [`worker.html`](output/worker.html). Optional
comment and a Comment language selector (from browser speech voices) are
persisted locally. URL options: `paymentAddress`, `jobIds`, `computeGroups`,
`leavePublicGroup`, `maxSandboxes`, `identity` (default `(anonymous)`),
`comment` (alias `workerComment`), `language` (BCP 47 tag for transcoder TTS),
`demoCommentIndex` (1–4 Think Different quotes). Platform results carry
`{ text: "<identity>: <comment>", language, demoCommentIndex? }`. The index is
inferred whenever the comment matches a standard demo quote. The transcoder
plays its generated `crazyOnes` WAV in the selected language when available,
then rotates through the other generated languages instead of replaying one.
Each language is played at most once per job; missing WAVs fall back to queued
browser text-to-speech. Slice callouts and the worker legend show the language
flag for the audio that will actually play. Click a commented slice (or focus it
and press Enter/Space) to replay its selected WAV or browser-speech fallback.
Uncheck **Read out comments** under Run to skip autoplay while keeping click-to-play.
Check **LinkedIn** on a commented slice to include that worker quote in the LinkedIn share caption, within the platform’s 1200-character post limit.

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
bash ffmpeg-wasm/build.sh          # if WASM artifacts are missing
node package/build-bravojs-bundle.js
node package/publish.js --apiKey=0x…   # or DCP_API_KEY
```

`publish.js` deploys `ffmpeg-dcp-social-v2` to the DCP package manager so
`job.requires(['ffmpeg-dcp-social-v2/ffmpeg-wasm.js'])` resolves. Use a new
package **name** when the fleet must pick up a new WASM (DCP does not accept
`name@version/file` in `requires`, and same-name updates are create-once).
Until that package is published, fleet jobs fail with `Could not locate module
/packages/ffmpeg-dcp-social-v2/package.dcp`.

The Docker build fetches and compiles the required Emscripten, FFmpeg, and
OpenH264 sources without using the root app’s build cache.

Build the WASM before compiling the UI; `scripts/compile.sh` fails if either
WASM runtime artifact is absent, preventing an incomplete deployment. For
HTML-only development, set `ALLOW_MISSING_WASM=1`.

Director’s-cut ranges stay in the browser editor only. On Run, the client
keyframe-slices the **original** source, maps keep-ranges onto those chunks,
and dispatches only overlapping pieces to DCP. Discarded timeline never leaves
the browser. Boundary pieces set `needsTrim` so fleet workers call
`extract_time_range` (then remux + social encode); interior pieces social-encode
once. Fleet WASM must export `extract_time_range` — rebuild with
`bash ffmpeg-wasm/build.sh` and republish under a **new** package name (see
`package/package.dcp`) after changing `src/dcp-transcode.c`.

## Transcode via GitHub

The **Transcode via GitHub** button (next to **Transcode on DCP**) opens a dialog
for a GitHub personal access token (cached in `localStorage`). Optional LinkedIn
token, author URN, and caption enable direct REST posting; otherwise the worker
falls back to committing MP4 + metadata and dispatching `post-to-linkedin.yml`.

1. Uploads the current recording to `docs/uploads/` via the GitHub Contents API.
2. Dispatches [Self-hosted runner test](../.github/workflows/self-hosted-runner-test.yml) with the uploaded path.
3. Pays for one DCP slice whose work function lists
   [`dcp-gh-runner/dcpGhRunner.js`](dcp-gh-runner/dcpGhRunner.js) and
   `ffmpeg-dcp-social-v2/ffmpeg-wasm.js` in **`job.requires`** (packages ship with
   the job — no separate publish step for dcp-gh-runner). The slice JIT-registers as
   a GitHub Actions runner on a **browser WASM worker**, downloads `VIDEO_URL`,
   transcodes to LinkedIn feed MP4 (`li_feed`), then publishes.

Rebuild the bundle after source changes:

```bash
cd xframe/dcp-gh-runner
npm install
npm run build          # writes dist/dcpGhRunner.js + dcpGhRunner.js
```

Optional: `node scripts/publish.js --apiKey=0x…` only if you want a globally
registered copy under the package manager name; **`job.requires` is sufficient**
for the transcoder path.

Token needs `repo` and `workflow` scopes. Uploads are capped at ~95 MB (GitHub Contents API limit).

The Node CLI in [`github/`](github/) remains for local dev and CI; the browser path
uses the esbuild bundle under [`dcp-gh-runner/`](dcp-gh-runner/).

## Parallelism

1. **Serial:** probe + keyframe-aligned WebM/MP4 slice (~90 frames / ~3 s) + director’s-cut → program pieces.
2. **Parallel (DCP):** one slice per `(program piece, unique format signature)` when “Max distribution” is on; otherwise one slice per piece encoding every unique format inside the worker.
3. **Parallel (browser):** each unique signature remuxes to MP4 independently after ordered concat.
4. **Dedupe:** Instagram feed and Facebook feed share signature `1080x1350-7000-160-30` → one encode, two download names.

## Framing

- **Fill (cover):** center crop to placement aspect (default for social masters).
- **Fit (contain):** letterbox/pillarbox pad when the full frame must be preserved.
