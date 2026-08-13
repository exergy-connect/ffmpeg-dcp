# FFmpeg + OpenH264/x264/SVT-AV1/x265 on WASM, on DCP

Interactive browser demo: drop a video, watch a real
[DCP](https://distributed.computer/) worker fleet transcode it, live.
Real AV1 and HEVC renditions ride alongside H.264 for a quality/cost
comparison. Fully self-contained via `window.dcp` (`dcp-client.js`
loaded straight from a `<script>` tag) - no backend, no Node, anywhere.

This is the `dcp-only` branch - no in-page local encode to compare
against, and no hardcoded identity/compute group. Point it at your own
DCP account and compute group from the page itself.

## Run it

No build step - the compiled wasm module (`ffmpeg-wasm/`) is committed,
so a plain clone is runnable. Serve this folder over HTTP (needed for the
Worker + `fetch()` calls to work - won't run from a `file://` URL):

```
python -m http.server 8843
```

Then open `http://localhost:8843` in Chrome or Edge.

## Using your own DCP account

The page itself has a "Your DCP account" section, persisted in this
browser's local storage across reloads (a "clear" link resets it):

- **API key** - your DCP identity key, from your account on
  [your DCP portal](https://dcp.cloud/). Leave blank to fall back
  to the built-in demo key (`DEFAULT_API_KEY` in `app.js`).
- **Compute group(s)** - one row per group, each a `joinKey` field and
  a masked `joinSecret` field (secret optional). Leave a row's key
  blank to dispatch to the public compute group. "+ Add another group"
  adds more rows; each row's "×" removes it (or clears it, if it's the
  only row left).

`wallet.get()` is called with no argument - DCP prompts for a wallet/
passphrase via its own popup regardless of what's passed there, so
there's nothing to configure on that side.

## Rebuilding the wasm module

Only needed if you're changing `src/dcp-transcode.c` itself. `build.sh`
regenerates `ffmpeg-wasm/dcp-transcode-glue.js` + `dcp-transcode.wasm`
from source - requires emscripten and sibling checkouts of OpenH264,
x264, SVT-AV1, x265, and FFmpeg source (see `build.sh`'s own header
comment for exact expected paths).
