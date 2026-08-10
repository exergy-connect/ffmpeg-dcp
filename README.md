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

## Rebuilding the wasm module

Only needed if you're changing `src/dcp-transcode.c` itself. `build.sh`
regenerates `ffmpeg-wasm/dcp-transcode-glue.js` + `dcp-transcode.wasm`
from source - requires emscripten and sibling checkouts of OpenH264,
x264, SVT-AV1, x265, and FFmpeg source (see `build.sh`'s own header
comment for exact expected paths).
