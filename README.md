# FFmpeg + OpenH264/x264/SVT-AV1/x265 on WASM, on DCP

Interactive browser demo: drop a video, watch it transcode locally vs. a
real [DCP](https://distributed.computer/) worker fleet, live. Real AV1
and HEVC renditions ride alongside H.264 for a quality/cost comparison.
Fully self-contained via `window.dcp` (`dcp-client.js` loaded straight
from a `<script>` tag) - no backend, no Node, anywhere.

## Run it

No build step - the compiled wasm module (`ffmpeg-wasm/`) is committed,
so a plain clone is runnable. Serve this folder over HTTP (needed for the
Worker + `fetch()` calls to work - won't run from a `file://` URL):

```
python -m http.server 8843
```

Then open `http://localhost:8843` in Chrome or Edge.

## Using your own DCP account

The demo ships wired to a shared demo identity/wallet, in `app.js`'s
`runFleetRace()`:

- **`identity.set('0x87ba...')`** ([app.js:552](app.js#L552)) - your DCP
  identity key, from your account on [Bell's DCP portal](https://bell.dcp.cloud/).
  Replace the hex string with your own.
- **`wallet.get('live demo')`** ([app.js:553](app.js#L553)) - the label
  DCP matches against a keystore file's basename in your local `.dcp`
  folder. Replace `'live demo'` with the basename (no extension) of the
  keystore file you downloaded from the portal - e.g. if you downloaded
  `wallet.keystore`, use `wallet.get('myAccount')`.

## Rebuilding the wasm module

Only needed if you're changing `src/dcp-transcode.c` itself. `build.sh`
regenerates `ffmpeg-wasm/dcp-transcode-glue.js` + `dcp-transcode.wasm`
from source - requires emscripten and sibling checkouts of OpenH264,
x264, SVT-AV1, x265, and FFmpeg source (see `build.sh`'s own header
comment for exact expected paths).
