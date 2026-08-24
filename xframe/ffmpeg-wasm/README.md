# xFrame single-threaded social WASM

Build reproducibly with Docker:

```bash
./build.sh
```

The build compiles the custom `src/dcp-transcode.c` API without Emscripten
pthreads and writes:

- `dcp-transcode-glue.js`
- `dcp-transcode.wasm`

These are intentionally separate from the repository-root `ffmpeg-wasm/`
used by the original demo.
