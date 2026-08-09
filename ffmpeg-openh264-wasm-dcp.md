# Compiling FFmpeg + OpenH264 to WebAssembly for DCP

Porting a large, real-world C project (FFmpeg, with an external codec
library) to run inside a DCP work function — the biggest port attempted in
this series, after [the plain-math-library guide](./wasm-in-work-functions.md)
and [the FFTW guide](../fftw-demo/fftw-wasm-dcp-howto.md). This page assumes
both of those and only covers what's new here: a project with its own real
build system that doesn't target wasm out of the box, and a whole class of
DCP-sandbox-specific constraint (no real threads) that a mature codebase's
own architecture can silently violate in ways a small library never would.

## DCP worker environment constraints (read this first)

Every choice below traces back to one of these. If you're porting a
different library, check it against this list before writing any build
flags:

- **No filesystem.** A work function can't read a file at runtime. Compiled
  wasm binaries ship as data (base64 in a JS module or a bound `compute.for`
  argument) — see the basic guide.
- **No real threads, at all.** No `SharedArrayBuffer`-backed WASM threading,
  no `Worker`/`worker_threads` construction available to a work function,
  regardless of `SharedArrayBuffer` itself being present as a global. A
  library or program that unconditionally spawns an OS thread for its own
  internal architecture (not just as an optional performance path) **cannot
  run as-is**, no matter how it's configured. This is the constraint that
  broke ffmpeg's own CLI scheduler below — worth internalizing before
  porting anything with its own threading model.
- **No browser/Node globals.** No `document`, `fetch`, `Worker`. Emscripten's
  default glue auto-detects environment via `location`/`importScripts`
  stubs the sandbox already provides (see the basic guide's `pyodide-core.js`
  note) — usually works without modification, but verify per-project.
- **`WebAssembly` and `atob`/`btoa` are native/polyfilled** in the sandbox —
  no shimming needed for those specifically.
- **No pkg-config, no `make`, no native C/C++ compiler, no admin rights** in
  a from-scratch Windows build environment — not a sandbox constraint, but
  worth stating since every workaround below assumes it.

## Toolchain gaps (build-machine only, not sandbox-related)

A from-scratch Windows dev box has none of the Unix build tooling most C
projects assume, and no admin rights to install it the normal way (`choco`
needs elevation). All fixed with portable, no-install options:

- **`make`**: portable GNU Make binary (ezwinports build), no installer.
- **`cmake`/`ninja`**: `pip install cmake ninja` — real portable wheels, not
  stubs.
- **`pkg-config`**: doesn't exist and can't easily be gotten portably.
  FFmpeg's `--enable-lib<x>` flags for external codec libraries
  (`--enable-libopenh264` included) hard-require it via `require_pkg_config`
  — there's no manual-flags fallback path. Fixed with a from-scratch shim
  implementing only the exact four call shapes FFmpeg's configure makes
  (`--version`, `--exists --print-errors "<pkg> >= <ver>"`, `--cflags`,
  `--libs`, `--variable=<name>`) against a hand-written `.pc` file. Two
  non-obvious gotchas if you write your own:
  - `emconfigure` **unconditionally overwrites `PKG_CONFIG_PATH`** from a
    *different* env var, `EM_PKG_CONFIG_PATH` — set that one, not
    `PKG_CONFIG_PATH` directly, or your `.pc` file silently won't be found.
  - `PKG_CONFIG_PATH` arrives as a Windows-style path (`C:/Users/...`) —
    naive colon-splitting for multi-path support breaks on the drive
    letter's `:`. Try the whole value as one directory before splitting.
- **Host compiler for build-time tools**: FFmpeg's configure separately
  probes a *host* C compiler (for small helper tools that run during the
  build itself, not part of the wasm output) and fails hard without one.
  emsdk's own `clang.exe` (the plain one, not the `wasm32-*` prefixed
  wrappers) compiles and links native Windows binaries directly — use it as
  `--host-cc`.
- **Host-tool linking**: that same `clang.exe` defaults to MSVC-style
  linking on Windows, which wants a `m.lib` that doesn't exist (Windows has
  no separate libm). Fix: `--host-extralibs=` (empty, overrides the default
  `-lm`).

## Building OpenH264 for wasm

Clone the git repo directly (unlike FFTW, OpenH264 doesn't need
autotools-generated files — its Makefile is committed as-is) and build the
static lib with `ARCH`/`OS` overridden to route around its own
architecture-specific asm entirely:

```bash
make libopenh264.a OS=linux ARCH=wasm32 CC=emcc CXX=em++ AR=emar
```

- `OS=linux` picks an existing, real platform Makefile fragment
  (`build/platform-linux.mk`) that's a thin, portable GNU-toolchain wrapper
  — there's no `wasm`-specific one, and this one has no Linux-specific
  behavior that matters for a static-lib-only build.
- `ARCH=wasm32` doesn't match any of the library's x86/arm/mips/loongarch
  branches in `build/arch.mk`, so no architecture-specific asm gets pulled
  in at all — a plain, portable C++ build results without needing to
  explicitly disable asm.

## Configuring FFmpeg

```bash
emconfigure sh ../ffmpeg/configure \
  --target-os=none --arch=x86_32 --cpu=generic \
  --enable-cross-compile --disable-x86asm --disable-inline-asm \
  --disable-asm --disable-stripping \
  --disable-programs --enable-ffmpeg \
  --disable-doc --disable-debug \
  --disable-everything \
  --enable-protocol=file \
  --enable-demuxer=mov,matroska,mpegts,wav \
  --enable-muxer=mp4,mpegts,hls,null \
  --enable-decoder=h264,hevc,aac,pcm_s16le \
  --enable-encoder=aac \
  --enable-libopenh264 --enable-encoder=libopenh264 \
  --enable-parser=h264,hevc,aac \
  --enable-filter=scale,fps,aresample,anull,null,setpts \
  --disable-network --disable-autodetect \
  --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ \
  --host-cc=clang.exe --host-extralibs= \
  --extra-cflags="-O3" --extra-cxxflags="-O3" \
  --extra-ldflags="-sDEFAULT_TO_CXX=1"
```

Notes on the non-obvious parts:

- `--disable-everything` then opt back in per-component — start from zero,
  not from FFmpeg's (huge) default feature set.
- **`git clone` the git repo, not a release tarball, works fine here** —
  FFmpeg's `configure` is hand-written and committed directly, unlike
  FFTW's autotools-generated one. Don't assume this generalizes; check each
  project.
- **`-sDEFAULT_TO_CXX=1` is required because OpenH264 is C++, but FFmpeg's
  own build links the final binary with the C driver (`emcc`), not `em++`**,
  since FFmpeg's own sources are plain C. Without this flag: undefined
  symbols for `operator new`/`delete` and C++ RTTI vtables at final link,
  not at compile time — easy to misdiagnose as a missing-library problem
  when it's actually a missing-C++-runtime problem.
- **Don't pass `-msimd128`/`-mbulk-memory` without first confirming they
  work inside the actual sandbox** (not just locally) — verified safe via a
  real in-sandbox test job in this case, but treat that as a prerequisite
  step for any port, not an assumption.

### The threading trap

FFmpeg's own CLI program (`fftools/ffmpeg`) declares a hard dependency on
its internal `threads` feature — the build silently produces zero programs
(no error) if that dependency isn't satisfied, which is easy to miss.
Naively enabling it, though, makes FFmpeg's configure probe for pthread
support *by actually compiling and linking a test program with `-pthread`*,
which succeeds under `emcc` — and that success switches Emscripten into
**real multi-threaded compilation** (`--shared-memory`, `-mt` runtime libs),
requiring `SharedArrayBuffer` and real thread-spawning capability neither
of which a DCP work function has, regardless of `SharedArrayBuffer` itself
being present as a sandbox global (see the constraints section above).

Fix: patch FFmpeg's `configure` to skip straight to the flag-free
`check_func pthread_join && check_func pthread_create` fallback, which finds
those symbols (present via Emscripten's musl libc, declared regardless of
`-pthread`) without adding `-pthread` anywhere. This satisfies the
`threads` feature at the source-compile level without ever triggering
Emscripten's real threading backend.

```patch
- if check_lib pthreads pthread.h pthread_join   -pthread &&
-    check_lib pthreads pthread.h pthread_create -pthread; then
-     add_allcflags -pthread
- elif check_lib pthreads pthread.h pthread_join   -pthreads && ...
-     [... several more -pthread/-lpthread branches ...]
- elif check_func pthread_join && check_func pthread_create; then
+ if check_func pthread_join && check_func pthread_create; then
      enable pthreads
```

## Don't use `fftools/ffmpeg`'s `main()` as the work function entry point

The threading fix above gets the **libraries** (`libavcodec`/`libavformat`/
etc.) to compile without triggering real Emscripten threading. FFmpeg's CLI
frontend itself (`fftools/ffmpeg_sched.c`, the pipeline scheduler introduced
in recent FFmpeg versions) is a separate problem: it unconditionally calls
`pthread_create()` once per pipeline stage — one thread each for demux,
decode, filter, encode, mux — with **no single-threaded fallback path
anywhere in that file**, independent of any codec or `-threads` setting.
Two things confirmed this is a hard wall, not a flag to find:

1. **Runtime pthread failure**: without a working `pthread_create`, this
   fails immediately with `pthread_create() failed: Not supported` the
   moment a real encode is attempted (`-version` never spins up the
   scheduler, so a smoke test that only checks `-version` won't catch this).
2. **Synchronous `pthread_create`/`pthread_join` shim** (`-Wl,--wrap=pthread_create,--wrap=pthread_join`,
   running each "thread" inline instead of concurrently) doesn't deadlock,
   but produces **silent incorrect output** — process exits 0, no error, no
   output file. The scheduler's stages assume genuine concurrent
   producer/consumer execution against bounded queues; running them
   synchronously in creation order breaks that assumption. Worse than a
   crash — don't reach for this as a fix for anything beyond a quick
   diagnostic.

**The fix: don't route through `fftools/ffmpeg`'s `main()` at all.** Call
`libavformat`/`libavcodec` directly instead — demux → decode → encode → mux
as a plain function-call sequence, no scheduler, no internal threading.
Confirmed working end-to-end with the **full pipeline**, not just encode:
`reference/full-pipeline-test.c` generates synthetic frames, encodes via
`libopenh264`, muxes to MP4 (`avcodec_send_frame`/`avcodec_receive_packet`,
`avformat_write_header`/`av_interleaved_write_frame`) — then immediately
demuxes that same file back in (`avformat_open_input`/`av_read_frame`),
decodes every frame via the `h264` decoder, re-encodes via `libopenh264`
again, and muxes a second output file. All single-threaded, zero pthread
involvement anywhere, no shim needed:

```
[phase1] frames_encoded=10 packets_written=10
[phase2] decoder opened OK: h264
[phase2] frames_decoded=9 frames_encoded=9 packets_written=9
[phase2] out2.mp4 size = 13260 bytes
FULL PIPELINE OK
```

(9 decoded vs. 10 encoded going in is ordinary encoder latency/reordering,
not a bug — the last frame is still buffered in the encoder when the file
is finalized and flushes out on the *next* read in a real streaming
scenario.)

**The codec and container libraries were never the problem; only FFmpeg's
own CLI orchestration layer was.** This is also a better architectural fit
for the DCP work-function model regardless of the threading issue:
`(sliceBytes, params) → outputBytes` maps naturally onto a direct API
driver, not onto constructing an argv array for a CLI tool's `main()`.

One MEMFS note: this test writes `out.mp4` in phase 1 and reads it back in
phase 2, both **inside the same process** — this only works because MEMFS
is in-memory and process-scoped. Two separate `node` invocations would not
see each other's MEMFS content; a real work function reads/writes MEMFS
entirely within one call, matching this shape naturally.

Two output-path notes from getting this driver running:

- **Windows path parsing.** `C:/Users/.../out.mp4` gets misread by FFmpeg's
  URL parser as protocol `C` (colon-terminated scheme), not a drive letter
  — `Protocol not found`. Irrelevant for the real sandbox target (MEMFS
  paths, not host paths) but will bite local testing on Windows if you
  pass an absolute host path; use a relative/MEMFS-style path instead.
- **`wrapped_avframe` decoder.** Needed to consume `lavfi` source filters
  (`testsrc` etc.) — easy to miss under `--disable-everything` since
  nothing else references it by name; only surfaces as "no decoder found"
  at demux time, not at configure time.

## Linking for the sandbox: MODULARIZE

```bash
emcc reference/full-pipeline-test.c -O3 [... same libs as above ...] \
  -sDEFAULT_TO_CXX=1 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createFfmpegModule \
  -o full-pipeline-modularized.mjs
```

This driver is not import-free the way the small hand-written examples in
the basic guide are (it uses full libc, MEMFS, C++ runtime) — 30 imports
across `env`/`wasi_snapshot_preview1`, so it needs the real Emscripten glue,
not a standalone-wasm shortcut. `MODULARIZE` produces that glue as an
importable module, matching the JS-module delivery pattern the rest of
this doc set uses. This ES6 variant is a fine sanity-check build for local
`node`/`import()` testing — loads and runs `main()` correctly — but **the
build actually shipped to the sandbox needs different flags entirely**, and
gets its own section below (job-deployment testing surfaced two real bugs
this smoke-test build never exercises, since it's never run through DCP's
own bundler or the sandbox's actual global surface).

## SIMD128 + bulk-memory

Both confirmed safe in-sandbox by a dedicated capability-probe job before
being used here (never assume — verify inside the actual sandbox, not just
locally). Applied to both libraries, not just one:

- **OpenH264**: `CFLAGS_OPT="-O3 -msimd128 -mbulk-memory"` on the `make`
  invocation from the section above.
- **FFmpeg**: same flags added to `--extra-cflags`/`--extra-cxxflags` at
  configure time.

One make gotcha: **changing compiler flags alone does not force a
rebuild** — `make`'s dependency tracking is based on file mtimes, not flag
content, so object files already on disk look "up to date" against
unchanged source files even though the flags used to produce them changed.
`make clean` doesn't reliably help either if invoked without the exact same
`ARCH`/`OS`/etc. overrides used for the original build, since the file list
it cleans is computed from those variables too — a `make clean` run with
different (or default/unset) variables can clean the wrong file set
entirely, silently leaving stale objects in place. Safest fix: delete `.o`/
`.a` files directly (`find . -name '*.o' -delete`) rather than trusting
`make clean` after any flag change.

Rebuilding and relinking with both flags reproduced the exact same full
pipeline result as the scalar build (`frames_encoded=10`,
`frames_decoded=9`, `out2.mp4 size = 13260 bytes`) — expected, since SIMD
only accelerates internal computation and doesn't change this encoder's
deterministic output for a fixed single-threaded input.

## Wiring it up as a DCP work function

`src/dcp-transcode.c` turns the proven pipeline into a real, repeatedly-callable
work function: `transcode(inputPath, outputPath, width, height,
bitrateKbps)` reads a file from MEMFS, demuxes/decodes/scales
(`libswscale`, real rendition resizing, not just a proof-of-concept
passthrough) /encodes/muxes, writes the result to another MEMFS path.
`width`/`height` of `0` keep the source size. OpenH264 has no true CRF
(unlike x264) — `bitrateKbps > 0` switches it into bitrate-controlled mode
via the real `rc_mode` AVOption (string-based — don't guess the enum's
integer value and pass it to `av_opt_set_int`, use `av_opt_set` with the
named string instead); `0` leaves it at its default quality mode.

Compile flags differ from the plain smoke-test build in a few
DCP-specific ways:

```bash
emcc src/dcp-transcode.c -O3 -msimd128 -mbulk-memory [... same libs ...] \
  -sDEFAULT_TO_CXX=1 \
  -sMODULARIZE=1 -sEXPORT_NAME=createFfmpegModule \
  -sENVIRONMENT=web,worker \
  -sEXPORTED_FUNCTIONS="['_transcode','_main']" \
  -sEXPORTED_RUNTIME_METHODS="['ccall','cwrap','FS']" \
  -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 -sINVOKE_RUN=0
```

- **No `-sEXPORT_ES6=1` this time** — plain CommonJS output instead. The
  sandbox's module loader (BravoJS) is a CommonJS system; a plain
  `require('./dcp-transcode-glue')` needs the standard
  `module.exports = createFfmpegModule` shape, not an ES module. Confirmed
  present at the end of the generated glue file without any extra flag.
- **`-sENVIRONMENT=web,worker`, excluding `node`.** This is required, not
  optional, for anything actually shipped via `job.requires()` — see
  "Two deploy-time bugs" below for why leaving it unset (which works fine
  for local-only testing) breaks the real deploy.
- **`FS` in `EXPORTED_RUNTIME_METHODS`, plus `FORCE_FILESYSTEM=1`** — the
  wrapper needs `Module.FS.writeFile`/`readFile` to move slice bytes in and
  the transcoded result out of MEMFS; neither is exposed by default.
- **`EXIT_RUNTIME=0`** — required for calling `transcode()` repeatedly
  against one instance (once per slice) rather than tearing the runtime
  down after a single call, same reasoning as the original plan's
  `-sEXIT_RUNTIME=0`/`callMain` note, just applied to a direct `ccall`
  instead of `main()`.
- **`INVOKE_RUN=0`** — `main()` is kept only because Emscripten's runtime
  init wants one linkable; this flag stops it from auto-running (it does
  nothing) so module load doesn't waste a call.

## Two deploy-time bugs local testing doesn't catch

Both of these passed every local test — `node`-run smoke tests, direct
`ccall`/`FS` round-trips — and only surfaced once the job was actually
deployed via `job.exec()`. Neither is specific to this project; both are
real traps for shipping *any* real Emscripten glue (as opposed to
hand-written wrapper code) through `job.requires()`.

**1. `job.requires()`'s webpack bundler chokes on the glue's dead Node
branch.** Deploying threw `Error: Webpack: child process returned exit
code 1 with stderr null` from deep inside `dcp-client`'s own bundler
(`Job._pack` → `createModuleBundle`) — the same `dcp-module-bundler`
tool referenced in the basic guide, with its actual error swallowed.
Reproduced directly — `webpack --entry ./ffmpeg-wrapper.js ...` run from
`ffmpeg-wasm/`, using the `webpack` install that comes with `dcp-client` itself
(outside this repo, wherever `dcp-client` is installed) — to get the real
message: `UnhandledSchemeError: Reading from "node:fs" is not handled by
plugins`, from `dcp-transcode-glue.js`'s
Node-environment branch (`require('node:fs')`/`require('node:crypto')`,
part of Emscripten's default multi-environment glue). Webpack statically
resolves every `require()` it finds in bundled source — it doesn't matter
that this code path never executes in the sandbox; the bundler fails before
anything runs. Fix: `-sENVIRONMENT=web,worker` at build time removes the
Node branch (and its `require()` calls) from the generated source
entirely, rather than leaving it in as unreachable dead code. Confirmed:
reproducing the same webpack invocation locally against the rebuilt glue
now compiles cleanly.

**2. `Module["wasmBinary"]` is silently ignored — use `instantiateWasm`
instead.** The original wrapper passed `{ wasmBinary }` to the module
factory and appeared to work in local `node` testing. It didn't actually
work: grepping the generated glue confirms `wasmBinary` is never read from
the config object anywhere. The local test passed because unset
`-sENVIRONMENT` let the glue auto-detect `ENVIRONMENT_IS_NODE` and load the
`.wasm` via real `fs.readFileSync` off local disk — which happened to be
sitting right there, but is both unavailable (no filesystem) and
irrelevant (the bytes are already in hand, not on disk) in the sandbox.
This is a case where a passing local test doesn't prove sandbox
correctness — the two environments were satisfying the same call in
different, non-equivalent ways. The real override hook, confirmed present
in the glue source, is `Module.instantiateWasm(imports, successCallback)`:

```js
const createFfmpegModule = require('./dcp-transcode-glue');
const wasmBase64 = require('./wasm-bytes');

// This build's environment check is `!!globalThis.WorkerGlobalScope`
// (a real Worker constructor) - not confirmed whether the sandbox
// defines it natively, so define a truthy stand-in ourselves before
// requiring the glue rather than relying on it being there. Detection
// only needs to resolve to ENVIRONMENT_IS_WORKER; instantiateWasm below
// is what actually controls wasm loading either way.
if (typeof globalThis.WorkerGlobalScope === 'undefined') {
  globalThis.WorkerGlobalScope = function WorkerGlobalScope() {};
}

let modulePromise = null;
function getModule() {
  if (!modulePromise) {
    const wasmBytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));
    modulePromise = createFfmpegModule({
      instantiateWasm(imports, successCallback) {
        WebAssembly.instantiate(wasmBytes, imports).then((result) => {
          successCallback(result.instance);
        });
      },
    });
  }
  return modulePromise;
}

async function transcodeSlice(sliceBytes, { width = 0, height = 0, bitrateKbps = 0 } = {}) {
  const Module = await getModule();
  Module.FS.writeFile('/slice-in.mp4', sliceBytes);
  const ret = Module.ccall('transcode', 'number',
    ['string', 'string', 'number', 'number', 'number'],
    ['/slice-in.mp4', '/slice-out.mp4', width, height, bitrateKbps]);
  if (ret !== 0) throw new Error(`transcode() failed with code ${ret}`);
  const outBytes = Module.FS.readFile('/slice-out.mp4');
  Module.FS.unlink('/slice-in.mp4');
  Module.FS.unlink('/slice-out.mp4');
  return outBytes;
}

module.exports = { transcodeSlice };
```

Same `WebAssembly.instantiate(bytes, importObject)` pattern used by every
hand-written wrapper elsewhere in this doc set — just reached through a
different Emscripten API because this module needs the real glue instead
of standalone wasm. Re-verified locally afterward using a test harness that
stubs the sandbox's confirmed globals (`self.location`) rather than relying
on Node's own environment, to avoid repeating the same false-positive
mistake: 7195-byte source down to 3120 bytes at 80×60/200kbps, and up to
8068 bytes at default quality mode/source size — both correct, matching
the pre-fix numbers exactly (same encoder, same math — only the loading
mechanism changed).

The demo job (`ffmpeg-transcode-job.js`) models the actual ABR-ladder
shape: one input video, each slice a different rendition
(360p/240p/160p/source-quality), `job.requires(['./ffmpeg-wasm/ffmpeg-wrapper'])`
the only declared module.

**Untested at this scale**: `wasm-bytes.js` here is 6.5MB of base64 (the
compiled module itself is ~4.9MB — real codec + container + C++ runtime
code, an order of magnitude past FFTW's 579KB) — the largest payload shipped
via this transitive-`job.requires()` pattern in this doc set so far. The
mechanism itself has no documented size limit (see the basic guide), and
this specific job — including this payload — has now been confirmed
deployed and running for real (see below); it just hadn't been, going in.

## A third deploy-time bug: bound `compute.for` arguments plus `job.requires()`

This one only showed up after the two bugs above were fixed and the job
actually got as far as running `transcode()` in the real sandbox — and it's
the reason the video input in the final job script is embedded in each
slice's own datum instead of passed as a bound `compute.for` argument, even
though a bound argument is exactly the pattern
[the basic guide recommends](./wasm-in-work-functions.md) for shipping a
single constant value to every slice, and is proven working elsewhere in
this doc set (the wasm binary itself, in the inline-argument pattern).

The first version of this job did exactly that —
`compute.for(renditions, workFunction, inputBase64)` — and every slice
failed identically: `input '/slice-in.mp4' is 3 bytes`, followed by
FFmpeg's own `moov atom not found`/`Invalid data found when processing
input`. 3 bytes is `atob()`'s output for a 4-character input — and
`atob(null)` coerces `null` to the string `"null"` (4 characters, all valid
base64 alphabet) before decoding it. The bound argument was arriving as
`null` inside the sandbox, not the actual ~9.6KB base64 payload.

Every other bound-argument example in this doc set has **no**
`job.requires()` call on the same job; every `job.requires()` example that
also needs per-slice constant data puts it in the slice's own datum, not a
bound argument. This is the first time this project combined both on one
job, and it's the combination that breaks — not either mechanism alone.
The actual interaction can't be diagnosed further from here: `compute.for`
and `job.requires()`'s implementations are both server-fetched at
`dcp-client` `init()` time, not present in any local checkout to inspect
(same limitation noted in the basic guide for `job.requires()` itself).

The fix applied: stop using a bound argument for this job entirely, and put
`inputBase64` on every element of the `renditions` array instead — a
different, unaffected delivery path (the plain per-slice-datum mechanism
every example in this series starts from). Costs a small amount of
duplication (the same ~9.6KB base64 string repeated across 4 slices instead
of shared once), negligible at this size. If you hit this combination
yourself with a much larger bound value where that duplication cost isn't
negligible, that's a reason to actually track down the root cause rather
than route around it — this doc doesn't have that answer, only the
symptom, the reproduction, and the workaround.

## Confirmed working end-to-end, live

With that fix applied, a real deployment of `ffmpeg-transcode-job.js`
against the actual DCP worker fleet succeeded across all four slices:

| Rendition | Target | Output size |
|---|---|---|
| 360p | 640×360, 800kbps | 14229 bytes |
| 240p | 426×240, 400kbps | 7477 bytes |
| 160p | 284×160, 200kbps | 4176 bytes |
| source-quality | source size, quality mode (no fixed bitrate) | 8068 bytes |

Output sizes ordered exactly as expected (higher resolution/bitrate →
larger output), and `source-quality`'s 8068 bytes matches the local
same-input test run precisely. Everything documented above as
"untested at this scale" is now confirmed at that scale: the 6.5MB
`job.requires()` payload, the `-sENVIRONMENT=web,worker` build, the
`instantiateWasm` override, and per-slice-datum input delivery all worked
correctly on real DCP workers, not just in local `node` testing.

## OpenH264 warning noise: cosmetic vs. real

Two warnings fire on every encoder open under default settings. DCP's
console relay tags any sandbox stderr line as `level: 'error'` regardless
of the actual ffmpeg log severity, so both show up looking like real
failures even on a fully successful transcode — worth checking the actual
cause before assuming a red console line means something broke.

- `layerId(0) doesn't support profile(578), change to UNSPECIFIC profile`
  — cosmetic. ffmpeg's `libopenh264enc.c` defaults to
  `AV_PROFILE_H264_CONSTRAINED_BASELINE`, a combined flag value
  (`AV_PROFILE_H264_CONSTRAINED`(512) `|` `AV_PROFILE_H264_BASELINE`(66) =
  578) passed straight through as `uiProfileIdc` — but OpenH264's own
  `EProfileIdc` enum (`codec_app_def.h`) only defines plain values
  (`PRO_BASELINE`=66, `PRO_MAIN`=77, `PRO_HIGH`=100), not the OR'd
  combination, so it falls back to auto-detect regardless. Avoid it (and
  get an explicit, known profile instead of relying on the fallback) by
  setting `enc_ctx->profile = AV_PROFILE_H264_MAIN` before `avcodec_open2`.
- `bEnableFrameSkip = 0, bitrate can't be controlled for RC_QUALITY_MODE,
  RC_BITRATE_MODE and RC_TIMESTAMP_MODE without enabling skip frame` —
  real, not cosmetic. ffmpeg's wrapper defaults `rc_mode` to
  `RC_QUALITY_MODE` (not off), and OpenH264 warns for every mode in that
  list whenever frame-skipping is disallowed — it fires even if `rc_mode`
  is never touched. Fix: `av_opt_set_int(enc_ctx->priv_data,
  "allow_skip_frames", 1, 0)` unconditionally, not just when requesting
  bitrate mode.

## Chunked ABR + HLS pipeline

Beyond one-shot whole-file transcode, `src/dcp-transcode.c` also splits a
source video into independently-decodable chunks and transcodes each
chunk × rendition combination as its own work unit — the shape a real
ABR/HLS ladder needs (parallelizable across chunks, not just across
renditions).

- `slice(inputPath, outputPrefix, targetChunkFrames)`: splits via stream
  copy (no decode/re-encode) at the first keyframe at or after
  `targetChunkFrames` frames since the current chunk started — actual
  chunk length varies with source GOP placement, not a hard target.
  Writes `{outputPrefix}NNN.ts` (3-digit, zero-padded) MPEG-TS chunks with
  **absolute, not rebased, timestamps** — needed for correct downstream
  HLS `#EXTINF` math and playback continuity. Returns chunk count (or a
  negative error code). Per-chunk frame counts and detected source fps are
  exposed via `get_chunk_frame_count(i)`/`get_source_fps()` so the JS side
  can compute exact segment durations without re-probing.
- `transcode_segment(inPath, outPath, width, height, bitrateKbps)`: same
  encode path as `transcode()`, muxes to MPEG-TS instead of MP4 — what
  each (chunk, rendition) work unit actually calls. MPEG-TS's muxer
  handles avcc→Annex-B SPS/PPS conversion automatically, which is why
  closed-GOP chunks stay independently decodable without any manual
  bitstream rewriting.
- Audio (if present) is split at the same chunk boundaries and carried
  through every rendition — see the dedicated section below for how.

**Job shape** (`hls-transcode-job.js`): slicing happens once, locally, at
deploy time — the sandbox has no filesystem, and a chunk needs to exist
before it can become its own work unit anyway. One unit per
`(chunkIndex, rendition)`, each chunk's base64 bytes embedded directly in
that unit's own datum (same reasoning as the bound-argument bug above —
this job also uses `job.requires()`). After `job.exec()`, results are
grouped by rendition, ordered by `chunkIndex`, and assembled into a
standard HLS layout: one `master.m3u8` plus one `{rendition}/playlist.m3u8`
+ numbered `.ts` segments per rendition, computing each
`#EXT-X-STREAM-INF` bandwidth from actual output byte totals over total
duration.

**Sandbox gotcha inside `workFunction`**: no `Buffer` global in the
sandbox (only `atob`/`btoa`, same as the rest of this doc set) — encoding
the transcoded segment back to base64 for the result payload needs a
manual chunked `String.fromCharCode`/`btoa` loop, not
`Buffer.from(...).toString('base64')`. Chunk in 32KB pieces to avoid
blowing the call stack on `String.fromCharCode.apply` for one large array.
Same class of bug as the bound-argument issue above: works perfectly in
local Node testing (where `Buffer` exists) and only fails in the sandbox.

Validated end-to-end locally (`test/test-hls-pipeline-local.js`): a
synthetic 150-frame/15s clip sliced into 4 chunks (~3–4s each, boundaries
following actual keyframe placement), all 12 (4 chunks × 3 renditions)
transcodes succeeded, and the assembled output is a structurally valid HLS
tree (`master.m3u8` + 3 rendition subfolders, each with `playlist.m3u8` +
numbered segments). Live-fleet deployment of this specific job is the
natural next validation step, following the same pattern as the
whole-file job above — local success here doesn't guarantee sandbox
success on its own, per every bug found in this doc so far.

## Bake-off: adding libx264 alongside libopenh264

OpenH264 (BSD) has no true CRF, as noted above. x264 (GPL — fine for this
academic PoC, but worth knowing if reusing this build for anything else)
does, and is the natural point of comparison. `dcp-transcode.c`'s
`do_transcode()` now takes an `encoder_name` param (`"libopenh264"` or
`"libx264"`), threaded through `transcode()`/`transcode_segment()` and the
JS wrapper's `encoder` option (default `'libopenh264'`, so existing job
scripts that don't pass it are unaffected).

**Building x264 for wasm** follows the same shape as OpenH264 (see above),
with two differences of its own:

- **`--host=wasm32-unknown-linux` isn't a real target** — it just routes
  x264's hand-written `configure` into its generic-CPU/Linux-OS fallback
  branches (`ARCH` becomes the literal uppercased `host_cpu`, matching no
  x86-specific case, so no `-m32`/`nasm`/asm-flags get pulled in; `SYS`
  becomes `LINUX` off the `*linux*` pattern in `$host_os`). A real triplet
  like `i686-linux-gnu` would instead hit x264's `i*86` case and add
  `-m32` unconditionally (even with `--disable-asm`), which `emcc` doesn't
  want.
- **`configure`'s own endianness self-test needs a `strings` binary**,
  which isn't part of this Windows toolchain (real binutils `strings`
  isn't installed, and there's no portable option). Fixed with a
  from-scratch shim ([`tools/strings-shim/`](../tools/strings-shim/)) that
  just extracts printable-character runs via `grep -a -o`, same idea as
  the pkg-config shim — implements the one real behavior `configure`
  actually needs, not a general replacement.

```bash
CC=emcc AR=emar RANLIB=emranlib sh ./configure \
  --host=wasm32-unknown-linux \
  --disable-asm --disable-cli --disable-thread --disable-opencl \
  --disable-avs --disable-swscale --disable-lavf --disable-ffms --disable-gpac --disable-lsmash \
  --enable-static --bit-depth=8 --chroma-format=420 \
  --extra-cflags="-O3 -msimd128 -mbulk-memory"
emmake make -j4 libx264.a
```

`--disable-thread` matters for the same reason as everywhere else in this
doc: x264's own multi-threaded encoding path assumes real OS threads,
which the sandbox doesn't have. Disabling it at x264's own configure level
means the library itself never attempts to spawn one, regardless of
`avctx->thread_count` — a cleaner guarantee than OpenH264's approach of
just setting `thread_count = 1` and trusting the library to respect it.

**Wiring into ffmpeg** needs `--enable-gpl --enable-libx264
--enable-encoder=libx264` added to the ffmpeg `configure` invocation, plus
a `tools/pkgconfig-shim/x264.pc` (same shape as `openh264.pc`) so
ffmpeg's `require_pkg_config` check for `libx264` succeeds. This is a real
`libavcodec` rebuild, not just a relink — expect the full ffmpeg build
step to run again, not just the final `dcp-transcode.c` compile.

**A third deploy-relevant memory bug, caught locally this time**: the
first x264 encode attempt aborted with `RuntimeError: Aborted(OOM)` /
`abortOnCannotGrowMemory` — x264's lookahead buffers and reference frames
need more heap than OpenH264 ever asked for, and the module's default
Emscripten heap has no room to grow without `-sALLOW_MEMORY_GROWTH=1`
(not previously needed, since OpenH264 alone fit in the default size).
Added to the link flags; confirmed fixed locally. **Not yet verified
in-sandbox** — same category of "safe to assume" trap as SIMD128/
bulk-memory above (those needed a dedicated capability-probe job before
being trusted), so treat this the same way before relying on it in a real
deploy.

**Initial results** (8-frame and 100-frame clips, openh264 vs x264 only)
showed x264 meaningfully smaller at comparable quality, at a real
compute-time cost. Those exact numbers are superseded below — adding a
third encoder (libsvtav1) surfaced a real framerate bug that affected
x264's ABR pacing too, not just SVT-AV1. See the combined three-way
results after that section.

**Not yet done**: swapping `hls-transcode-job.js`'s renditions over to
`libx264`/`libsvtav1` and deploying for real, and running the same
bake-off inside the actual sandbox rather than just locally (per the
`ALLOW_MEMORY_GROWTH` caveat above).

## Adding libsvtav1 (AV1) — a third encoder, and a real threading de-risk

FFmpeg's own CLI scheduler (`fftools/ffmpeg_sched.c`, see above) was a
hard wall: unconditional `pthread_create()` per pipeline stage, no
single-threaded fallback anywhere in that file. SVT-AV1's core encoder
*library* (not a CLI — this project calls it the same direct way as the
other two encoders, via `libavcodec`) has the same kind of 16-stage
threaded pipeline (resource coordination, picture analysis, motion
estimation, rate control, mode decision, entropy coding, etc.), each
normally getting its own `pthread_create()`. Before spending build time on
it, that architecture was checked directly against the source
(`Source/Lib/Globals/enc_handle.c`): a genuinely recent (2025)
`CONFIG_SINGLE_THREAD_KERNEL` mode exists, and when the `lp`
("level of parallelism") config value is `1`, **every one of the 16
pipeline stages routes through a cooperative FIFO-dispatched kernel loop
on one thread instead of spawning any OS thread at all** — not a partial
fallback; the entire threaded code path (all 16 `EB_CREATE_THREAD*`
calls in `enc_handle.c`) sits in a mutually exclusive `else` branch that
never executes when `lp == 1`. Confirmed no other unconditional
`pthread_create()` call site exists elsewhere in `Source/Lib`. This is a
real, deliberate single-threaded mode, not a hack — a meaningfully
different situation from the ffmpeg CLI scheduler dead end.

**Building for wasm** (`Source/Lib` only — same "bypass the CLI, call the
library API directly" pattern as ffmpeg) uses CMake, not a hand-written
`configure`:

```bash
emcmake cmake -S . -B build-wasm -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_APPS=OFF -DBUILD_TESTING=OFF \
  -DCOMPILE_C_ONLY=ON \
  -DCMAKE_C_FLAGS="-O3 -msimd128 -mbulk-memory" \
  -DCMAKE_CXX_FLAGS="-O3 -msimd128 -mbulk-memory"
cmake --build build-wasm --target SvtAv1Enc -j4
```

`-DCOMPILE_C_ONLY=ON` is explicit belt-and-suspenders — SVT-AV1's own
`CMakeLists.txt` detects x86/ARM via `check_c_source_compiles` testing for
`__x86_64__`/`__aarch64__`, which already correctly fail to compile under
`emcc` targeting wasm32, so the no-asm path is actually taken either way.
Unlike x264, no host-triplet trick or `strings` shim was needed — CMake's
own compile-time detection just works here.

**A latent build.sh bug this step exposed**: `EMSDK_NODE`/`EMSDK_PYTHON`
were set as *relative* paths, computed once relative to this script's own
directory. That's fine as long as every step stays in that same
directory, but this CMake step (like several before it) `cd`s into the
sibling source tree first — and a relative path in an env var gets
re-resolved against whatever the process's cwd is *at the moment a
command actually execs*, not against where the variable was set. Symptom:
`pylauncher: CreateProcess failed (2): "../emsdk/python/.../python.exe"`
— the path was one `cd` too shallow. Every one of `build.sh`'s
`EMSDK`/`OPENH264_SRC`/`X264_SRC`/etc. path variables is computed as an
absolute path now (`$(cd ../../x && pwd)`), not just the SVT-AV1 one —
this bug was latent in the openh264/x264/ffmpeg steps too, just never
triggered in practice because this project's `build.sh` had only ever
been re-run after those `.a`/`.a` files already existed on disk (so those
guarded blocks kept getting skipped, straight to the final
`dcp-transcode.c` compile step, which never `cd`s anywhere).

**Wiring into ffmpeg** needs `--enable-libsvtav1 --enable-encoder=libsvtav1`
(no `--enable-gpl` needed — SVT-AV1 itself is BSD/AOM-licensed, unlike
x264) plus a `tools/pkgconfig-shim/SvtAv1Enc.pc` (ffmpeg's
`require_pkg_config` checks for the pkg-config name `SvtAv1Enc`, not
`libsvtav1`). `lp=1` isn't exposed as its own ffmpeg `AVOption` — it's set
through ffmpeg's generic `svtav1-params` passthrough
(`av_opt_set(enc_ctx->priv_data, "svtav1-params", "lp=1", 0)`), which maps
directly onto SVT-AV1's own `"lp"` config key
(`Source/Lib/Globals/enc_settings.c`'s parameter table). Confirmed active
via SVT-AV1's own startup log: `Level of Parallelism: 1`.

**Two more real bugs, both general — not SVT-AV1-specific, and both
would've silently degraded the other two encoders too**:

1. **Wrong framerate derivation.** `dcp-transcode.c` was setting
   `enc_ctx->time_base` from the input stream's time_base but never
   setting `enc_ctx->framerate` at all. Those are different things — time
   base is a timestamp *granularity* (often much finer than the actual
   frame interval, e.g. `1/90000`), not `1/fps`. OpenH264 and x264
   tolerate `framerate` being unset; SVT-AV1 doesn't — ffmpeg's
   `libsvtav1.c` falls back to treating `time_base.den/time_base.num` as
   the frame rate when `avctx->framerate` isn't set, producing a nonsense
   value (observed: "the maximum allowed frame rate is 240 fps" reported
   against an implied rate far above that) that SVT-AV1 correctly
   rejected outright. Fixed by always deriving `enc_ctx->framerate` from
   the real source stream (`avg_frame_rate`, falling back to
   `r_frame_rate`) — the same pattern `slice()` already used for
   `get_source_fps()`. Applied unconditionally, not just for SVT-AV1: this
   was silently wrong for OpenH264/x264 too, and re-running the bake-off
   after the fix changed x264's ABR output size substantially (see below)
   — its bitrate pacing needs a correct fps to budget bits per frame
   correctly, which it had never actually been given.
2. **Stack overflow, not memory corruption.** After the framerate fix,
   SVT-AV1 encoding still failed — `RuntimeError: memory access out of
   bounds`, no useful stack trace, reproducible regardless of clip length
   or rate-control mode. Rebuilding with `-sSAFE_HEAP=1 -sASSERTIONS=2`
   turned the opaque trap into a real diagnostic: `Aborted(stack overflow
   ...)` inside `svt_av1_init_temporal_filtering`, called from the
   picture-decision kernel's motion-compensated temporal filtering.
   Emscripten's default wasm stack (64KB) is too small for SVT-AV1's
   local buffers in that function — nothing to do with wasm32, the
   single-thread dispatcher, or a real bug in SVT-AV1 itself. Fixed with
   `-sSTACK_SIZE=5MB` at link time. Worth remembering as a debugging
   technique for any future "memory access out of bounds with no
   symbols" trap in this series, not just this one: a quick `-sSAFE_HEAP=1
   -sASSERTIONS=2` rebuild turns an opaque wasm trap into a real error
   with a real call stack.

**Validated the encoded output is real, not just non-crashing.** ffmpeg's
built-in `av1` decoder needs its own hwaccel `get_format` negotiation this
project hasn't wired up (`Your platform doesn't support hardware
accelerated AV1 decoding` / `Get current frame error`) — irrelevant to
the actual use case (DCP workers only ever *encode* AV1 here, never
decode it), so not chased further. Instead, confirmed structurally: the
output MP4 contains real `av01` (codec fourcc) and `av1C` (AV1 codec
config box) atoms with non-zero, plausible sample sizes — not just an
empty/garbage container.

**Results** (`test/test-codec-bakeoff.js`, 100-frame/~10s chunk-sized
clip, all three encoders, same rendition/bitrate — output size as an
efficiency proxy, not a full VMAF/SSIM comparison; supersedes the
two-way numbers above after the framerate fix):

| Mode | openh264 | x264 | svtav1 (preset 10) |
|---|---|---|---|
| quality/CRF (default) | 104703 B (390ms) | 61324 B (571ms) | **50517 B** (1647ms) |
| 400kbps ABR | 103729 B (335ms) | 208185 B (598ms) | 133684 B (1726ms) |

(Numbers above include the synthetic clip's audio track, added after this
table was first written — see the audio-handling section below; a fixed
~37KB AAC payload is now baked into every row, on top of the same video
encoding these numbers described before.)

AV1 wins on compression efficiency at comparable quality settings, as
expected — roughly 4.9× smaller than openh264 and 1.8× smaller than x264
at each encoder's own default quality mode, at the highest compute cost
of the three (even at preset 10, a speed-favoring preset out of SVT-AV1's
0–13 range). The ABR row's dramatic jump in x264's output size compared
to the pre-framerate-fix numbers is the framerate bug's effect, not a
codec characteristic — x264's ABR bit-budget pacing is now working off a
real fps instead of an accidental one. Both quality-mode rows still
undershoot a 400kbps ceiling substantially for the same reason noted
earlier (the synthetic gradient test content is trivially compressible
relative to real-world video). Timings are single-encode wall-clock on
the local dev machine, not the sandbox — useful for relative comparison
between encoders, not as an absolute sandbox performance number.

**Not yet done**: deploying any `libsvtav1` rendition for real (this is
the newest and least-battle-tested of the three encoders in this
project — confirm `ALLOW_MEMORY_GROWTH`/`STACK_SIZE=5MB` hold up in the
actual sandbox before trusting them there, same caveat as x264's memory
growth above), and running the bake-off against real (non-synthetic)
source video.

## Audio handling in the chunking pipeline

The chunking pipeline above was originally video-only. Audio (when
present) is now split at the same chunk boundaries as video and carried
through every rendition, stream-copied (no decode/re-encode) since
rendition differences (resolution/bitrate) only ever apply to video —
there's nothing for a per-rendition audio re-encode to change.

**Where it's implemented**: `do_transcode()` (the shared helper behind
both `transcode()` and `transcode_segment()`) now detects the first audio
stream alongside the first video stream, creates a matching passthrough
output stream (`avcodec_parameters_copy`, no decoder/encoder involved at
all for that stream), and routes audio packets straight to the muxer with
only a timestamp rescale — video is the only stream that goes through the
decode→scale→encode loop. `slice()` does the same per-chunk: each new
chunk (still cut at video keyframes only — audio never drives a chunk
boundary) gets its own passthrough audio stream, and every audio packet
gets written into whichever chunk is currently open when it's read.
Audio arriving before the very first video keyframe (no chunk open yet)
is silently dropped — at most a few hundred ms in practice, not worth
buffering for.

**Test fixture**: `generate_test_input()` (the synthetic-clip generator
used throughout this project's tests) now also encodes a 440Hz mono tone
via ffmpeg's native `aac` encoder, muxed alongside the synthetic video at
matching duration, entirely so there's something real to validate the
audio path against without needing an external test video.

**Verifying audio actually survived stream-copy is harder than it
sounds** — two wrong approaches found along the way, both worth avoiding
if debugging something similar:

1. A successful `transcode_segment()` call proves nothing about audio by
   itself. `do_transcode()` silently proceeds with video-only output if
   it doesn't find an audio stream in the input — there's no error path
   for "audio was expected but missing." A clean exit code only tells you
   the *video* path worked.
2. Scanning the output bytes directly for ADTS sync-word patterns doesn't
   work either, and not because the audio is malformed — MPEG-TS
   packetizes everything into interleaved 188-byte packets with their own
   headers, so two consecutive real ADTS frames are essentially never
   byte-adjacent in the file. A naive byte scan won't find any real
   frame-length chain regardless of whether the audio itself is fine.

The only real proof is decoding actual audio frames back out. Added a
small permanent debug helper, `probe_streams(path)`, in the same spirit
as `get_source_fps()`/`get_chunk_frame_count()`: opens a file, and if it
finds an audio stream, actually decodes a few frames from it (not just
checks the stream list) — logs `has_video=.. has_audio=..
decoded_audio_frames=N` to stderr and returns `(has_video<<1|has_audio)`.
Confirmed via this at three points in the pipeline: the source MP4 (5/5
frames decoded), a sliced MPEG-TS chunk straight out of `slice()` (5/5),
and the final `transcode_segment()` output for that chunk (5/5) — audio
survives the full round trip, not just the first hop.

**One real mechanism worth understanding, not just trusting**: MP4 stores
AAC as bare, config-based packets (the `AudioSpecificConfig` lives in
`extradata`, not inline per-packet); MPEG-TS conventionally expects
self-contained ADTS-framed AAC instead. Reading `libavformat/mpegtsenc.c`
directly confirmed ffmpeg's mpegts muxer handles this conversion
*automatically* — when it sees an AAC stream with non-empty `extradata`
at `avformat_write_header` time, it spins up an internal ADTS sub-muxer
and re-wraps every packet through it during write, entirely transparent
to the caller. This project's `avcodec_parameters_copy()` calls (which
carry `extradata` over correctly) are the only reason this "just works"
without any manual ADTS-wrapping code anywhere in `dcp-transcode.c`.

**Not yet done**: multi-track audio (only the first audio stream is
picked up — a source with multiple audio languages/tracks would silently
keep only one), and deploying this for real (same live-sandbox caveat as
everything else added in this session's later stretch).

## The demo front end

Everything above runs from Node — a real deploy still means editing and
running a `.js` file yourself. `index.html`/`app.js`/`ffmpeg-browser.js`/
`ffmpeg-worker.js` (at the `ffmpeg-dcp/` top level, alongside
`ffmpeg-wasm/` — see the real bug below for why they don't live in their
own subfolder) are the actual "drop a video, watch it race, watch it
play" experience: a static page, no backend, no build step.

- `index.html` + `app.js` — the page: drop zone, a two-bar race (same
  wasm module encoding locally, in-page, vs. real DCP dispatch), a
  liveness grid (chunk × rendition, cells fill in as fleet results land),
  a live cost counter, and an hls.js player for the assembled ladder.
- `ffmpeg-worker.js` — runs the actual wasm module (same one the sandbox
  work function uses, loaded the browser-native way: `fetch()`s
  `dcp-transcode.wasm` directly instead of decoding an inline base64
  string — no `wasm-bytes.js` needed here at all) inside a real Web
  Worker, not the main thread — see "the page froze" below for why that
  matters. `ffmpeg-browser.js` is a thin `postMessage`-based RPC client
  in front of it. One filename gotcha, confirmed live: `build.sh` renames
  the compiled output (`dcp-transcode-glue.wasm` → `dcp-transcode.wasm`)
  for `wasm-bytes.js`'s benefit, but the glue still internally requests
  the pre-rename name via `locateFile` — relying on that would 404 here.
  Fixed the same way the sandbox wrapper solves the analogous problem:
  override `instantiateWasm` and fetch the known real filename directly.
- The QR code (in `app.js`) points at `https://dcp.live/?computeGroups=
  bell,18be80` — `dcp.live`'s own real worker-join page, pre-filled via
  query params with this job's exact `job.computeGroups` credentials, so
  a scanning device becomes eligible for *this* job's slices specifically
  rather than just the general scheduler pool. This page originally
  guessed at a self-hosted `join.html` (adapted from `dcp-client`'s own
  `examples/vanilla-web/simple-worker.html`) since no worker-side
  compute-group mechanism was found documented locally — turns out there
  already was a real one, just not a local one; removed once the actual
  URL was known.

**Run it**: serve `ffmpeg-dcp/` over any static HTTP server —
`npx serve ffmpeg-dcp` (or `cd ffmpeg-dcp && npx serve`) — then open the
URL it prints. Opening `index.html` directly via `file://` breaks
`fetch()` entirely (`Access to fetch ... blocked by CORS policy ...
'null'`) — confirmed live, not just theorized; a real static server is
the plan's own stated bar ("host on anything static"), not a local
special case.

**What this reuses**: the fleet dispatch path in `app.js` mirrors
`hls-transcode-job.js` where the browser build actually lets it — same
unit shape (per chunk × rendition, chunk bytes embedded in each unit's
own datum), same `job.computeGroups`, same HLS assembly logic (now
targeting blob URLs instead of files). One thing does *not* carry over —
see below.

### `job.requires()` does not work the way Node's does in a browser — confirmed live, in two stages

**Stage 1: parent-directory traversal is rejected.** The first version
put these files in their own `demo/` subfolder, referencing the sandbox
module via `job.requires(['../ffmpeg-wasm/ffmpeg-wrapper'])` (one level
up, correctly matching where `ffmpeg-wasm/` actually was). Live result:
the job deployed and got accepted fine, then every slice failed with
`Job error: Invalid module path: ./../ffmpeg-wasm/ffmpeg-wrapper`.
`dcp-client`'s browser-side path resolver normalizes the given specifier
(prepending `./`) and then rejects anything that still contains `..` —
apparently a deliberate security boundary specific to the browser build
(Node's version trusts real filesystem access; letting an arbitrary web
page's job script reach outside its own served directory would be a real
escape). Fix attempted: move `index.html`/`app.js`/`ffmpeg-browser.js`/
`join.html` up to sit directly alongside `ffmpeg-wasm/` (which is also
why they live at the `ffmpeg-dcp/` top level now, not in a subfolder) —
`job.requires(['./ffmpeg-wasm/ffmpeg-wrapper'])`, no `..` anywhere.

**Stage 2: even a traversal-free local path doesn't resolve.** With the
`..` gone, the *next* live attempt failed differently:
`Job error: Invalid module path: ./../ffmpeg-wasm/ffmpeg-wrapper` was
gone, replaced by `Job error: In operation fetchModuleURL: Could not
locate module /packages/ffmpeg-wasm/package.dcp`. That URL shape —
`/packages/<name>/package.dcp` — isn't a fetch of a file on the page's
own origin at all; it's a lookup against what appears to be a
**published DCP package registry**, treating `ffmpeg-wasm` (the first
path segment) as a package name. Nothing in this project's local
`dcp-client` checkout documents this mechanism or how to publish to it
(`grep`ing the whole checkout for `package.dcp`/`fetchModuleURL` turned
up nothing beyond an unrelated npm link). Conclusion, as far as this
project could determine without that tooling: **the browser build of
`job.requires()` only resolves published DCP packages by name — it does
not fetch arbitrary local relative files from the page's own origin the
way Node's filesystem-based bundler does.** That was this page's single
biggest open question before any live test, and now it has a real,
if disappointing, answer.

**The actual fix: drop `job.requires()` for this job entirely**, and
ship the wasm module a different proven way — bound arguments, the same
delivery mechanism [the basic guide's pattern 1](./wasm-math/wasm-in-work-functions.md)
uses, just not normally at this size. `app.js` now `fetch()`es
`ffmpeg-wasm/dcp-transcode-glue.js` (as text) and
`ffmpeg-wasm/dcp-transcode.wasm` (as bytes, base64-encoded) once, then
passes both through `compute.for(units, workFunction, [glueSource,
wasmBase64])`. Inside `workFunction`, the glue source is materialized via
a small `new Function('module', 'exports', glueSource)` CommonJS shim
(providing real `module`/`exports` locals makes the glue's own
`if (typeof module === "object")` export branch fire correctly), then
`instantiateWasm` is overridden exactly like the sandbox wrapper already
does — `atob()` the bound-argument base64 into bytes,
`WebAssembly.instantiate`. This is the same combination already proven
safe elsewhere in this project (a bound argument *without*
`job.requires()` on the same job) — the documented bound-argument bug
only triggers when both are used *together*.

**Real cost of this workaround, not a bug**: the `job.requires()`-based
sandbox wrapper caches its wasm module instance at module scope
(`getModule()`'s `modulePromise`), which persists across multiple slices
dispatched to the *same* worker process — one instantiation, many
encodes. A bound argument can't back that same cache: work functions are
re-`eval`'d fresh per slice with no surviving closures, so this
browser-dispatched job re-materializes and re-instantiates the ~8MB wasm
module from scratch on *every single slice*. Fine for a demo; a real
concern if this pattern were used for a large, module-scope-cache-reliant
production job.

**Not yet verified**: whether an 11MB+ *bound argument* (not a
`job.requires()` payload — that scale was already proven fine, just via
a different mechanism) transmits and deserializes correctly at the
scheduler/worker layer. The job deploying and slices dispatching in the
`job.requires()` attempts above at least confirms the identity/wallet/
dispatch plumbing itself works end-to-end from a browser; whether the
much larger bound-argument payload specifically holds up is the next
thing this needs a live test to confirm.

### A real ordering bug: the fleet race didn't actually start until the local race finished

Caught on the same live test as the module-resolution issue above, and
worth documenting because the cause is a genuinely easy trap in any
"race two things concurrently" browser code: `Promise.all([runLocalRace(),
runFleetRace()])` *looks* like it starts both immediately, and in terms
of promise scheduling it does — but `runLocalRace()`'s per-unit work is a
multi-second **synchronous** `Module.ccall()` burst. JavaScript is
single-threaded: while that call is running, nothing else gets a turn,
including the pending network callbacks (`identity.set()`/`wallet.get()`/
`wallet.add()`) that `runFleetRace()` needs to advance. The `await
setTimeout(r, 0)` yield between local-race units is a real yield, but it
only gets one macrotask's worth of a chance to let other pending work
run before the next multi-second synchronous burst starts again — not
enough for a several-step network handshake to reliably complete.

Fix: hoist identity/wallet setup out of `runFleetRace()` into its own
`setupDcp()`, called and *awaited* before either race starts. This isn't
just a timing nicety — it means the one-time wallet/identity setup cost
is no longer competing for event-loop turns against local's CPU-bound
work at all, and both races now start from a genuinely synchronized line
once setup resolves.

**Worker-side compute-group membership — resolved.** The original
self-hosted `join.html` (joining the general scheduler pool via the same
`DCPWorker` pattern as `dcp-client`'s own `simple-worker.html` example)
couldn't confirm whether a worker joining that way becomes eligible for
*this* job's `job.computeGroups`-restricted slices specifically — no
worker-side equivalent was found documented in this project's local
`dcp-client` checkout. There already was a real one, just not a local,
discoverable-by-grep one: `https://dcp.live/?computeGroups=<joinKey>,
<joinSecret>` — `dcp.live`'s own worker page accepts the group
credentials as a query param. The QR code points there now; `join.html`
was removed.

**Known simplifications, not bugs**: playback only starts once the
*entire* fleet job finishes (`job.exec()` resolving), not progressively
per-chunk as the plan's stretch goal describes — building true
progressive HLS append (start playback the instant chunk 0 exists for
one rendition, keep extending the playlist as more segments land) is a
real chunk of additional work, deferred here. The "approx. concurrent
workers" and cost-counter numbers are explicitly labeled approximations
in the UI itself (Little's-Law-style estimates from result arrival
timing, not a directly reported scheduler metric) — the throughput
number they're derived from (results/sec, rolling window) is real,
measured data; the concurrency estimate built on top of it isn't.

## A real-world-input bug, and real (not synthetic) bake-off numbers

Every test in this project up to this point used `generate_test_input()`'s
synthetic clip — convenient, but self-consistent in a way that hides
certain bugs: the audio it produces always round-trips through this
project's own encoder, so its `codecpar->codec_tag` is always exactly
what this project's own muxers expect. `test/hockey-sample.mp4` (real
stock footage — generic hockey action, not NHL/Montreal Canadiens
broadcast footage, which is copyrighted; see
`test/hockey-sample-SOURCE.txt` for the exact source and license) broke
that assumption immediately:

```
[mp4 @ ...] Tag [15][0][0][0] incompatible with output codec id '86018' (mp4a)
[transcode] avformat_write_header failed: Invalid data found when processing input
```

`codec_tag` is a container-specific fourcc for a codec, copied verbatim
by `avcodec_parameters_copy()` — fine when re-muxing into the *same*
container family the source came from, but a real third-party MP4 can
carry a `codec_tag` value the output mp4 muxer's own strict compatibility
check rejects outright, even though the underlying AAC stream is
perfectly valid. Standard fix, the same one ffmpeg's own CLI remuxing
code applies in this situation: zero the output stream's `codec_tag`
after copying codecpar, letting the muxer pick its own correct tag for
the codec ID instead of trusting the source's. Applied to both audio
pass-through sites (`do_transcode()` and `slice()`'s chunk audio stream).
Confirmed via `probe_streams()` (real decode, not just structural
presence) that both video and audio survive the full real-file pipeline
afterward: slice → `transcode_segment()` → decodable output, same as the
synthetic-clip result documented above.

**With that fixed, a real bake-off on real footage** (one 3-second chunk,
320×240, quality/CRF mode, from a genuine hockey clip with real skating
motion and camera pans — not a flat gradient):

| Encoder | Output size | Time |
|---|---|---|
| openh264 | 389939 B | 2961ms |
| x264 | 134753 B | 2924ms |
| svtav1 | 139447 B | 5717ms |

Notably different picture from the synthetic-clip bake-off, where AV1
was the clear efficiency winner: here **x264 and SVT-AV1 are close, with
x264 slightly ahead** (both ~2.9× smaller than OpenH264, which is
consistently the weakest of the three on both synthetic and real
content). Real motion complexity narrows the AV1-vs-x264 gap seen on the
trivially-compressible synthetic gradient — a reminder that synthetic
test content, however convenient, can meaningfully mis-rank encoders
relative to real-world footage, and why this file is worth keeping
around for any future bake-off work on this project.

### A second real-world-input bug: unset decoder timestamps

A *different* real video (user-supplied, downloaded separately from
`test/hockey-sample.mp4`) surfaced another real-world-only bug through
the demo page's local race path:
`[mpegts] Timestamps are unset in a packet for stream 0` (stream 0 =
video, in `transcode_segment()`'s output), immediately followed by
`Encoder did not produce proper pts, making some up` and then OpenH264
`N frames skipped` — a real, non-fatal correctness issue, not a crash
(the job still completed), but the encoder's own rate-control logic
visibly struggling with the bad input.

Root cause: `do_transcode()`'s encode loop did `scaled->pts =
frame->pts;` unconditionally — fine for this project's own synthetic
clips (always clean, sequential pts, since `generate_test_input()` sets
`frame->pts = i` itself) and, apparently, for `hockey-sample.mp4`, but
some real-world files hand back decoded frames with `frame->pts ==
AV_NOPTS_VALUE` for at least some frames (common with VFR sources, files
re-muxed by tools that don't preserve timing cleanly, or certain B-frame
arrangements) — that unset value propagated straight through scaling,
encoding, and muxing.

Fix: track a monotonic frame counter and fall back to it, converted
through the real detected framerate into the stream's own `time_base`
via `av_rescale_q()`, whenever `frame->pts` is unset:

```c
scaled->pts = (frame->pts != AV_NOPTS_VALUE)
    ? frame->pts
    : av_rescale_q(frame_index, av_inv_q(enc_ctx->framerate), in_video_stream->time_base);
frame_index++;
```

Converting through the real framerate (not just using the raw frame
counter as the pts) matters: a bare frame index would land in a
completely different numeric scale than a real `time_base`-denominated
pts from an earlier frame in the same stream, breaking monotonicity even
worse than leaving it unset. Landing fallback values in the *same* units
as legitimately-pts'd frames means mixed streams (some real timestamps,
some synthesized) still come out monotonic and evenly spaced. Regression
suite and both real test files (`hockey-sample.mp4`, plus this newly
reported one) both still pass after the fix — this file didn't happen to
trigger the original bug, which is exactly why a *second* real-world
input mattered here: synthetic clips and even one real clip can both
fail to exercise an edge case that a different real file hits
immediately.

**Follow-up — the fallback above had its own bug, surfaced once
`reencode_for_chunking()` started running against individual *chunks*
instead of only whole files**: `Application provided invalid, non
monotonically increasing dts to muxer in stream 0: 534535 >= 6006`. The
`frame_index`-based fallback always started counting from zero on every
`do_transcode()` call — correct for a whole-file input starting at t=0,
wrong for a chunk carrying *absolute* (not rebased-to-zero) timestamps
inherited from a much longer original video (see `slice()`'s own doc
comment on why chunks keep absolute timestamps). The moment any frame
inside such a chunk needed the fallback, it got a small from-zero value
sitting right next to real neighboring timestamps in the hundreds of
thousands — a large backward jump, not just "unset." Fix: extrapolate
one frame-duration past the *last known-good* `pts` (real or itself
previously synthesized) instead of computing independently from zero:

```c
scaled->pts = (frame->pts != AV_NOPTS_VALUE)
    ? frame->pts
    : (last_pts != AV_NOPTS_VALUE ? last_pts + one_frame : 0);
last_pts = scaled->pts;
```

Reproduced the exact failing case directly (`sliceVideoAdaptive()` on
`hockey-sample.mp4`, which re-encodes 4 of its 5 initial chunks) —
clean, no warnings, after the fix; full regression suite unaffected.

## Chunk size is bounded by the source's own keyframe interval — `reencode_for_chunking()`

`slice()` is a cheap stream copy — it can only ever cut at a keyframe the
source *already has*. Its `target_chunk_frames` param means "cut at the
first keyframe at or after N frames," not "cut every N frames" — on a
source whose own keyframe interval is longer than the target (very
common with real-world video; 2–6+ second GOPs are typical for
web-delivered content), the target has **zero effect** below that
interval no matter how low it's set. Confirmed directly: `slice()` on
`hockey-sample.mp4` (a ~90-frame/3s native GOP) produced identical
3-second chunks at `target_chunk_frames` of 30, 10, *and* 5 — the target
never got low enough to matter, because it was never going to be able to
cut any sooner than the file's own next real keyframe regardless.

Getting chunks reliably smaller than the source's native GOP isn't a
parameter tweak — a synthetic keyframe can't just be spliced in front of
the original following P-frames, since those reference the *original*
frame's exact decoded pixels, not a substitute one. The actual fix is a
new function, `reencode_for_chunking(input_path, output_path, gop_size,
out_width, out_height)`: a full decode+re-encode of the whole input
(reusing `do_transcode()`, extended with a `gop_size` parameter that,
when `> 0`, sets `enc_ctx->gop_size` — `transcode()`/`transcode_segment()`
both still pass `0`, unaffected), forcing a real keyframe every
`gop_size` frames. Run `slice()` on *its* output with the same target and
every chunk boundary lands where requested, regardless of what the
original source did. Real cost, not free like `slice()` itself: one full
encode pass over the entire input before any chunking or dispatch can
start.

**`out_width`/`out_height` (0/0 = keep source resolution) matter here
specifically because of that cost.** This is an intermediate artifact
that gets encoded *again* per rendition anyway — there's no reason to
pay full source-resolution encode time when every actual rendition is
smaller. Measured on `hockey-sample.mp4` (12s, 3.4MB, source resolution
well above any configured rendition): encoding the intermediate at
source resolution took **32 seconds**; capped at 320×240 (this project's
largest configured rendition) took **12 seconds** — a real 2.5×
difference, not a rounding error, for a fairly small/short test file.
This scales with source resolution and duration, so the cap matters more
(not less) as inputs get larger — exactly the direction this project's
own testing is heading.

The demo page (`app.js`) now calls this before `sliceVideo()`, capped at
`Math.max(...RENDITIONS.map(r => r.width/height))`, with
`TARGET_CHUNK_FRAMES` lowered from 30 to 15 now that the target is
actually honored rather than just a floor on whatever the source's GOP
happened to be. Verified end-to-end on real footage: intermediate →
sliced chunk → final `transcode_segment()` output all still have real,
independently-decodable audio (checked via `probe_streams()`, not just
non-crashing) — the audio pass-through logic inside `do_transcode()`
(including the `codec_tag` fix above) applies unchanged to this new
entry point too, since it's the same underlying function.

## The page froze during `reencode_for_chunking()` — moving wasm execution into a real Web Worker

Reported live, immediately after `reencode_for_chunking()` shipped: the
page appeared to hang at "Normalizing keyframe interval…" for as long as
the encode took. Not a bug in the sense of something broken — a single
`Module.ccall()` is one uninterruptible synchronous block of computation
from JavaScript's point of view, and there is no way to yield mid-call on
the main thread. A multi-second (or, on a bigger input, multi-minute)
synchronous call blocks *everything* on that thread — rendering, input,
the progress bars this page is trying to show — which reads exactly like
a frozen tab, and long enough triggers the browser's own "Page
Unresponsive" warning.

This is different from the DCP sandbox constraint this whole project
otherwise works within: a browser tab actually has real `Worker` threads
available (the sandbox doesn't). So unlike everywhere else in this doc
where "no real threads" is a hard constraint to design around, here it's
the fix: `ffmpeg-worker.js` now runs the actual wasm module (loaded via
`importScripts()`, which — like a page `<script>` tag — shares the
enclosing global scope, so `dcp-transcode-glue.js`'s top-level `var
createFfmpegModule` becomes available the same way; a genuine
`WorkerGlobalScope` also means the glue's own environment detection
resolves correctly with no shim needed here, unlike the main-thread
case). `ffmpeg-browser.js` became a thin `postMessage`-based RPC client
in front of it, keeping the *exact same* `window.ffmpegBrowser` function
signatures it had when it ran the wasm module directly — `app.js` needed
zero changes for this move.

**Deliberately not using `Transferable` objects** (zero-copy
`ArrayBuffer` handoff) for the RPC payloads, even though the data can be
large: several call sites reuse the same `Uint8Array` across multiple
worker calls (`runLocalRace()`'s loop calls `transcodeSegment()` on the
*same* chunk once per rendition), and a transferred buffer is detached
(unusable) on the sending side afterward. Correctness over an
optimization that would need real per-call-site bookkeeping to use
safely — `postMessage`'s default structured-clone copy is the safer
default here.

**A genuinely nice side effect, not just a fix**: every wasm call this
page makes — including `runLocalRace()`'s per-unit `transcodeSegment()`
loop — now runs off the main thread. The `await new Promise(r =>
setTimeout(r, 0))` yield between local-race units (added earlier, before
this refactor, specifically to let the UI repaint between blocking
bursts) is now redundant — the `postMessage` round-trip itself already
yields properly — left in place since it's harmless, not because it's
still doing anything. More substantively: the local race's own measured
time should now be a truer reflection of actual computation cost, no
longer inflated by contention with the main thread's own rendering work.

## The full-video pre-encode was still the wrong shape — a hybrid instead

Fixing the freeze didn't fix the underlying design concern it surfaced:
`reencode_for_chunking()` is a full decode+re-encode of the *entire*
input, and that's genuinely serial, one-machine, one-thread cost that
scales with source length — true whether it runs on the main thread or
(as of the fix above) in a Worker, and true regardless of how many
workers the fleet has, since none of them touch this step. For "larger
and larger videos," a linearly-scaling local preprocessing pass sitting
in front of the actual distributed work undercuts the point of the demo.

The real fix, once this was named directly: don't re-encode the whole
video just because *some* of it has an inconveniently long native GOP.
`sliceVideoAdaptive()` (in `ffmpeg-worker.js`) is the hybrid —

1. Run the cheap `slice()` first, at whatever keyframes the source
   already has (free, instant, and for many real-world sources with
   reasonable GOP spacing, this is already good enough).
2. For each resulting chunk, check its frame count against
   `target_chunk_frames * OVERSIZE_FACTOR` (2× — a real, adjustable knob,
   not load-bearing). Only chunks that come out genuinely oversized get
   individually re-encoded (`reencode_for_chunking()`, same function as
   before, just called per-chunk instead of on the whole input) and
   re-sliced.

Each oversized chunk pays for only *its own* size, not the whole video's
— a source with short, regular GOPs throughout now pays nothing extra at
all. Verified both paths on real inputs: a synthetic clip with a native
20-frame GOP against a 15-frame target re-encoded **0 of 8** initial
chunks (82ms total — the cheap-slice-only cost, no re-encoding at all);
`hockey-sample.mp4` (whose every native GOP happens to exceed target)
still re-encoded **4 of 5**, landing on the same uniform, small-chunk
result as the full-video approach did, at comparable total cost for this
particular worst-case file — the win shows up on sources that *aren't*
uniformly oversized throughout, which most real-world video actually is.

`app.js` now calls this one function (`sliceVideoAdaptive`) instead of
the previous two-step `reencodeForChunking()` + `sliceVideo()` — same
call site, same resolution cap reasoning, same `TARGET_CHUNK_FRAMES`.
`reencodeForChunking()`/`sliceVideo()` stay exposed individually too
(still useful on their own), `sliceVideoAdaptive()` is just the
recommended entry point for actual chunking now.

### The hybrid still needs a realistic target — "still taking forever" on a larger real file

Shipping the hybrid didn't fully fix the underlying slowness: a larger
(17.5MB) user-supplied file was still slow to process, and with no
per-chunk feedback the wait looked identical to a freeze. Two separate
fixes, not one:

1. **Progress feedback.** `sliceVideoAdaptive()` now takes an optional
   `progress` callback (passed as a trailing argument to every worker
   RPC handler — harmless no-op for handlers that don't use it — and
   threaded through `ffmpeg-browser.js`'s `call()` as a `postMessage`
   sub-channel that doesn't resolve the pending request), reporting
   `{ phase: 'sliced', nativeChunks, needsReencode }` once up front and
   `{ phase: 'reencoding', current, total }` per oversized chunk. `app.js`
   logs both, so "is this frozen" no longer has to be inferred from
   silence.
2. **The actual root cause of the slowness, though — `TARGET_CHUNK_FRAMES`
   itself was set too fine to let the hybrid's own optimization do much.**
   At 15 frames (~0.5s) with the 2× oversize threshold, any native GOP
   over ~1 second (i.e. nearly all real-world web video, which commonly
   runs 2–10s GOPs) counts as oversized — confirmed on `hockey-sample.mp4`,
   **4 of its 5** native chunks needed individual re-encoding at that
   target, meaning the hybrid barely outperformed re-encoding the whole
   video, just with extra per-call overhead. Raised the target to 90
   frames (~3s at a typical 30fps source, chosen to land near common
   real-world GOP sizes) — on the same file, **0 of 5** chunks now need
   re-encoding, and total processing time dropped from ~12s to under 2s.
   The lesson generalizes: a hybrid cheap/expensive-path optimization is
   only as good as how well its threshold matches the real distribution
   of its input, not just whether the hybrid logic itself is correct.

### The liveness grid rendered as a few huge blocks, not a grid

Real CSS bug, not an environment quirk: `grid-template-columns:
repeat(renditions.length, 1fr)` divides the *entire container width* (up
to 980px) across however many columns exist. With a fixed 3 columns
(renditions) and few enough rows (chunks) not to look obviously
"gridlike," each cell ballooned to roughly a third of the page width —
confirmed via a screenshot showing exactly that. Fixed by giving
`.grid-cell` an explicit `width: 32px` and changing the column track
definition to `repeat(renditions.length, 32px)` (fixed px, not `1fr`) —
a liveness grid should stay small and dense regardless of container
width or row count, the same way a GitHub contribution graph does, not
stretch to fill the page.

### Console noise: `console.error()` styling doesn't mean something broke

Live testing surfaced pages of red, stack-traced console output —
`[libopenh264] N frames skipped` repeated throughout a real run that
*had actually succeeded* (`Fleet race done in 91.9s`, no `Job error:`,
no thrown exceptions). Root cause: `ffmpeg-worker.js`'s `printErr` hook
mapped ffmpeg's entire stderr stream — which carries every internal log
severity (info/warning/error) through one conduit, no per-line
distinction available — to `console.error()`, and browsers render
`console.error()` in red with a stack trace regardless of the message's
actual severity. "N frames skipped" is OpenH264's own benign rate-control
diagnostic (expected, given `allow_skip_frames` is deliberately enabled —
see the bake-off section above), not a sign of failure. Changed to
`console.warn()` — still visually distinct from normal `print()` output,
without the false "something is broken" signal. Real failures in this
codebase were never dependent on stderr text in the first place: every
`ccall` return code that indicates failure already throws a real JS
`Error` independently, in every wrapper function — stderr here is
supplementary diagnostic output, not the thing to watch for problems.

### Making SVT-AV1 real on the demo page, not just described in prose

The page's subtitle originally just asserted "SVT-AV1 costs more compute
but lands smaller" as background text — the demo itself only ever
dispatched `libopenh264`. Asked to make that literal: `RENDITIONS` now
threads a real `encoder` field through both races (`runLocalRace`,
`runFleetRace`'s `jobUnits`/`workFunction` — the C driver already
supports this per-unit, no `dcp-transcode.c` changes needed) and adds a
dedicated comparison pair (`h264-240p-quality` / `av1-240p`) alongside
the real 3-rendition ABR ladder, with live totals surfaced in a new
"Same resolution, two encoders" section.

**A real methodology bug caught before shipping, not after**: the first
version compared `av1-240p` against the existing ABR `240p` rendition —
same resolution, same 500kbps bitrate cap. Live result on a real chunk:
AV1 came out 4% *larger* than H.264, the opposite of the expected story.
Root cause: capping both encoders to the same target bitrate makes them
converge toward the same output size regardless of which one is actually
more efficient — bitrate-capped mode measures how well each encoder hits
a target, not how efficient it is. This project's own bake-off
(`ffmpeg-openh264-wasm-dcp.md`, above) always compared *quality* mode
(CRF, `bitrateKbps: 0`) to quality mode for exactly this reason. Fixed
by giving the comparison pair its own two renditions, both in quality
mode, decoupled from the real ABR ladder's bitrate-capped rungs — same
chunk, same test footage, confirmed **59% smaller** for AV1, with AV1
visibly taking longer per encode too (≈3.4s vs ≈1.3–1.6s for the other
renditions in one local test). `h264-240p-quality`/`av1-240p` are both
excluded from HLS playback (`playable: false`) — they exist purely for
the comparison, and AV1-in-MPEG-TS has its own problem independent of
all this: `ffmpeg`'s own muxer flags it live (`Stream 0, codec av1, is
muxed as a private data stream and may not be recognized upon reading`),
confirming the earlier caution about that combination not being reliably
supported was warranted, not just theoretical.

### The cost counter now uses real AWS Elemental MediaConvert rates, not an illustrative figure

Replaced the original flat `$0.015/min` placeholder with real numbers
fetched from AWS's own pricing page (`aws.amazon.com/mediaconvert/pricing/`,
checked 2026-08-09), not remembered/guessed at:

- **Basic tier** (AVC/VP8/VP9 only — no AV1/HEVC support at all):
  `$0.0075/min` at SD, single-pass, first pricing tier.
- **Professional tier** (the *only* tier AV1 is available on — Basic
  can't encode it at any price): `$0.0120/min` base at SD, first tier,
  × `3.5` multiplier for AV1 at SD/≤30fps → `$0.042/min` effective.

Both simplified to AWS's first (highest) pricing tier only — this demo
never approaches the 50k–100k normalized-minutes/month volume needed to
reach AWS's own discount brackets, so modeling those would add
complexity without ever mattering here. `awsRatePerMinute(rendition)`
picks the rate by `rendition.encoder`, and `runFleetRace()`'s `result`
handler now accumulates cost per-unit using each chunk's *real* duration
(`durations[chunkIndex]`, already tracked precisely by
`sliceVideoAdaptive()`) — not an average across the whole video like the
original version did.

**A genuinely striking number falls out of this for free**: on one real
test run (5 chunks, 5 renditions = 25 units), the single AV1 rendition
cost **more** than all four H.264 renditions *combined* (`$0.0190` vs.
`$0.0136`) despite being only 1 of the 5. AV1 costs more on real AWS
pricing for two independent, compounding reasons — the Professional-tier
requirement and the codec multiplier — not just the encode itself being
slower, which is exactly the story this page's subtitle and codec-
comparison section are trying to tell.

### "Cost counter" → "Cost comparison" — pricing this same work on DCP itself

AWS numbers alone only tell half the story on a page whose whole point
is DCP. Added a second stat block to the same section pricing the exact
same local-race work using DCP's own real rate: 1.000 ⊇ (one DCP credit)
= `$0.0003171` USD per 100 vCPU-seconds (`DCP_USD_PER_100_VCPU_SECONDS`
in `app.js`).

Two different bottom-line numbers follow from that one raw cost, not
one, because Bell's own relationship to DCP differs by use case:

- **Internal use** (Bell running its own transcodes on DCP): Bell earns
  back 80% of the compute credits it spends, netting a real cost of
  about 1/5 (20%) of the raw DCP cost (`BELL_INTERNAL_NET_FACTOR = 0.20`).
- **External resale** (Bell selling transcoding as a service, running on
  DCP under the hood): Distributive (the network operator) keeps 20% of
  what the customer pays, Bell keeps the other 80% as revenue
  (`BELL_EXTERNAL_REVENUE_SHARE = 0.80`).

**Two design mistakes in the first attempt, both caught live by the
user, not in testing:**

1. **Priced from the wrong race, and only once at the end.** The first
   version measured per-unit compute time in `runLocalRace()` and
   computed the DCP cost as a one-shot summary after both races finished
   (`Promise.all`) — same timing as the `speedup` number. The user
   reported the DCP stats stuck at `$0.0000` after a run that otherwise
   looked complete (fleet at 225/225, AWS numbers already populated).
   Root cause: AWS's cost ticks live per unit as fleet results stream in
   (`job.on('result')`), but this version's DCP cost needed the *local*
   race's per-unit timing — and local race processes every unit
   **sequentially, on one thread**, which is the entire premise of this
   demo (it's supposed to lose the race). For any real chunk count the
   fleet finishes and populates its stats long before local does, so a
   DCP summary gated on local completing sits at `$0.0000` for most —
   often all — of the time a viewer is looking at the page,
   indistinguishable from broken.

2. **The efficiency-factor math it was built on was also solving the
   wrong problem, caught in the same follow-up.** The user's direct
   question — "the dcp numbers should not need the local run to finish,
   both based on dcp fleet slices returning, no?" — reframed the whole
   approach: price DCP cost from the **real** fleet, not from a
   browser-local proxy adjusted by an assumed hardware-speed constant.
   The original design used local wall-clock time (this demo's own
   single-threaded machine) as a stand-in for an "AWS-class reference"
   duration, then divided by `BELL_CPU_EFFICIENCY = 0.38` to estimate
   how long Bell's slower fleet hardware would really take — a modeled
   estimate layered on top of a proxy. But the fleet race already
   dispatches real work to real DCP workers; there's no need to estimate
   their compute time when it can simply be measured.

**Fixed by having the dispatched work function measure and report its
own real compute time**, then pricing and ticking DCP cost from the
fleet's own `result` stream, exactly like AWS's cost already works:
`workFunction()` (the function actually shipped to and executed on real
DCP workers, via `compute.for()`) now times its own `transcode_segment()`
ccall with `Date.now()` — not `performance.now()`, since nothing else in
this project had previously confirmed `performance` exists inside a
dispatched sandbox's global scope, and `Date` is universally available —
and returns `computeSeconds` alongside the segment bytes. `job.on('result')`
prices each landed slice directly via `dcpRawCostForSeconds(ev.result.computeSeconds)`
and calls `updateDcpCostComparison()` right there, the same event and
cadence `updateCostCounter()` (AWS) already uses. Because this is now a
*real measured* number from whichever hardware actually executed the
slice, it doesn't need the efficiency-factor division at all — a slower
worker simply takes longer, in seconds, which the pricing already
reflects. `BELL_CPU_EFFICIENCY` stays in `app.js` purely as documented
reference context for the explanatory copy (why a real DCP-priced number
can come out higher than a naive rate-to-rate comparison would suggest
if the slices happen to land on Bell's own slower fleet), not as a
multiplier in the calculation. `runLocalRace()` reverted to pure timing/
UI with no DCP-cost involvement at all — the local race has nothing to
do with pricing DCP once real fleet timing is available.

### UI polish pass: provider badges, MB not KB, restyling dcp-client's injected wallet modal

Several small fixes to the same cost-comparison area, requested together:

- **AWS vs. DCP labeling.** The big `#costCounter` number had no visible
  provider label at all (only inferable from prose below it), and the
  three DCP stats weren't visually grouped as one block. Added a small
  `.provider-badge` pill (orange for AWS, violet for DCP) next to each,
  plus a violet left-border accent (`.dcp-stat-row`) grouping the three
  DCP numbers, for at-a-glance disambiguation.
- **KB → MB** for the codec-comparison byte totals (`statH264Bytes`/
  `statAv1Bytes` in `updateCodecComparison()`) — output segments at this
  scale read more naturally in MB.
- **Trimmed historical narration out of user-facing copy.** Several
  paragraphs (subtitle, cost-comparison prose, codec-comparison prose)
  had accumulated dev-diary asides written mid-session ("confirmed
  live", "not estimated from the local race") that made sense as
  commentary to me while building the feature but add nothing for an
  actual page visitor. Rewritten to state the current design plainly;
  the history lives in this doc and memory instead, not in the page.
  Also reduced em dash usage throughout the visible copy.

**Restyling dcp-client's injected wallet-unlock modal.** dcp-client.js
auto-injects `<link rel="stylesheet" href=".../dcp-client/assets/dcp-client.css">`
into `<head>` (disable via `load-css="false"` on its `<script>` tag,
not used here) which itself `@import`s `dcp-modal.css`. Both are wrapped
in `@layer` (`@layer dcp-style, dcp-client, dcp-modal, dcp-auth;`), and
per the CSS Cascade Layers spec, **any unlayered rule always beats any
layered rule**, regardless of specificity or source order — so a page
just needs to declare plain (non-`@layer`) rules targeting the modal's
real DOM (confirmed via the bundle: a genuine `<dialog id="dcp-modal">`
appended straight to `document.body`, no shadow root, so it's directly
selectable) to re-theme it, no `!important` needed. `dcp-modal.css`'s own
header comment even says as much: "should be used in conjunction with an
overall appearance stylesheet from the base application to set key
details like text colours, fonts, form element appearance." Added a
theming block to `index.html`'s `<style>` targeting `dialog#dcp-modal`
and its children (title bar, body, inputs, buttons, close-x, backdrop)
to match the page's existing dark palette, plus a narrower `max-width`
since the default (65% of viewport) is much wider than this modal's
actual content (a short passphrase prompt) needs. Left `dcp-client.css`/
`dcp-modal.css` themselves loaded, since they own the actual layout
(flex arrangement, open/close animation, sizing behavior) that would be
real work to reimplement — only overrode appearance-level properties.

### Escalating-duration stress test: no crash found, a real throughput number instead

Before starting on new transcoding flows, ran `test/stress-test.js`
against `test/stress-test-worker.js` — each size in its own fresh `node`
process (wasm's `ALLOW_MEMORY_GROWTH` heap only grows within a process,
so testing multiple sizes in one long-lived process would make later
sizes fail earlier than they really would). `generate_test_input()`
hardcodes 320×240/10fps, so duration (frame count) is the only axis
testable without a full rebuild — also the axis that matters most for
"what if someone uploads a very long video," since chunk/unit count
scales with duration, not resolution.

Results: 5min (3000 frames) completed in 35.6s, 30min (18000 frames) in
142.1s — RSS barely moved (275.5MB → 273.9MB) — then 90min (54000 frames)
hit a 3-minute per-attempt budget without finishing. **No memory ceiling
found**, just a timeout that was too tight: extrapolating the ~4x-time-
for-6x-duration trend from the first two points, 90 minutes would land
around 7 minutes, not actually fail. Honest takeaway: this synthetic
generator's fixed low resolution means it can't test real production
resolutions (1080p+ would cost far more per frame), and the real
memory-ceiling question is still open past 90 minutes at this resolution
- flagged as a known gap, not chased further in this pass.

### New transcoding flows: planned, Phase 1 (scrubbing-preview sprite sheet) shipped

Scoped six ideas (HEVC 3rd codec column, HDR10 passthrough, low-latency
live-style dispatch, multi-audio-track passthrough, thumbnail/sprite-
sheet generation, EBU R128 loudness normalization) against the real
build (`build.sh`'s exact ffmpeg configure flags, `dcp-transcode.c`'s
actual stream-handling code) rather than assuming feasibility - two
explicit scope calls made up front: **Dolby Vision is out** (needs a
licensed RPU SDK we don't have; HDR10 metadata passthrough only, DV
described conceptually in docs, not implemented), and **closed captions
are out of the first multi-track pass** (subtitle-stream handling is new
territory for this pipeline; scope to multi-*audio*-track only). Full
plan and sequencing rationale saved for reference; picked thumbnail/
sprite-sheet generation as the starting phase - purely additive, doesn't
touch `do_transcode()`/`slice()` at all, so zero regression risk to the
working demo.

**`generate_thumbnails()`** (new function in `dcp-transcode.c`, after
`reencode_for_chunking()`): samples up to N frames evenly spaced across
the whole input's duration, scales each to a small size, and writes it
as a standalone MJPEG file (`{prefix}NNN.jpg`). Decodes the *whole*
input sequentially rather than seeking — `av_seek_frame()` only lands on
a keyframe, and this project's own encoder output already has irregular
GOP boundaries (see `slice()`'s doc comment), so seeking wouldn't
reliably land near the requested timestamp anyway. A full decode pass
costs more than seeking would on a long source, but thumbnailing is a
one-time per-source operation, not per-rendition — the same tradeoff
`reencode_for_chunking()` already makes elsewhere in this file. Confirmed
on real footage: ~19s for `videoplayback.mp4` (250s/17MB). Uses
`AV_PIX_FMT_YUVJ420P` (JPEG full-range), not `do_transcode()`'s
`AV_PIX_FMT_YUV420P` (MPEG range) — a standalone JPEG conventionally
uses full-range JFIF colorspace. This does trigger a benign `deprecated
pixel format used` warning from `swscaler` on modern ffmpeg (the "J"
pixel format variants are soft-deprecated in favor of `AV_PIX_FMT_YUV420P`
+ explicit `color_range`) — cosmetic, not a correctness issue (output
verified as valid JPEG via its SOI marker in `test/test-thumbnails.js`),
left as a known follow-up rather than blocking on it.

New build flag: `--enable-encoder=mjpeg` (ffmpeg builds standalone JPEGs
from the mjpeg encoder's raw packet bytes directly - no muxer needed,
same as `ffmpeg -vframes 1 out.jpg` does internally). New exported
symbol: `_generate_thumbnails`. Wired through the same three layers every
other wasm function in this project goes through: `ffmpeg-worker.js` (the
real Web Worker doing the actual ccall), `ffmpeg-browser.js` (the
postMessage RPC client), and `ffmpeg-wasm/ffmpeg-wrapper.js` (the Node-side
equivalent used by test scripts and Node job drivers). Browser-side:
`generateThumbnailSprite()`/`finishScrubPreview()` in `app.js` composite
the returned JPEGs into one sprite sheet via `<canvas>`, generate a real
WebVTT sprite map (the same format hls.js/video.js scrubbing-preview
plugins consume), and wire a hover-to-scrub interaction on a new
"6. Scrubbing preview" section - kicked off in parallel with slicing
(against the *original* upload, not chunks), not added to the race's
critical path.

### A real, previously-latent build.sh bug: MSYS vs. native Win32 `make`

Adding the `mjpeg` encoder flag required forcing a genuinely clean
ffmpeg rebuild for the first time - every prior `build.sh` run had
`libavcodec.a` already cached, so the whole `if [ ! -f ...libavcodec.a ]`
block (guarding the "long one" ffmpeg configure+build step) had silently
never executed since this project's very first build. That block turned
out to be broken on this machine, in a way nothing had ever exercised
before:

- **Root cause**: ffmpeg's own `configure` re-derives its source path
  *internally* (`cd $(dirname "$0") && pwd`, inside the MSYS `sh` running
  it) regardless of what path style was used to invoke it - so every
  generated `Makefile`/`*.mak` file embeds the MSYS form (`/c/Users/...`)
  no matter what `FFMPEG_SRC` was set to in `build.sh`. The `make` that's
  actually on this machine's `PATH` (`make-portable`, a native Win32 GNU
  Make build, not an MSYS one - confirmed there's no MSYS-aware `make`
  anywhere on this system to fall back to) can't resolve that form in a
  Makefile `include` directive: `Makefile:1: /c/Users/.../Makefile: No
  such file or directory`, even though the file is genuinely right there
  - just not in a form this particular `make` binary's own `fopen()`
  understands.
- **Real fix**: patch the generated Makefile/`.mak` files' paths back to
  Windows-native form *after* `configure` runs, *before* `make` runs -
  fighting what the generated files say, not what generates them.
  `FFMPEG_SRC` (and `OPENH264_SRC`/`X264_SRC`/`SVTAV1_SRC`/`FFMPEG_BUILD`,
  same class of risk on a truly fresh build) switched to `pwd -W`
  (Windows-native); a new `FFMPEG_SRC_MSYS="$(cd ../../ffmpeg && pwd)"`
  captures the MSYS form directly (not derived by string-transforming
  the other one - simpler, can't drift). Deliberately did **not** convert
  `EMSDK`/`PKGCONFIG_SHIM`/`MAKE_PORTABLE`/`STRINGS_SHIM` to `-W` form -
  those get concatenated into bash's own `$PATH` string later, where a
  `C:/...` value would break `$PATH`'s colon-delimited parsing instead of
  fixing anything; only the four vars that get passed as configure/cmake
  source-tree *arguments* (and end up embedded in generated build files)
  needed the fix.
- **A second, compounding bug found while fixing the first**: the first
  patch attempt used `grep -rl --include="Makefile" --include="*.mak"`,
  which failed outright on this specific `grep` build - `--include=PATTERN`
  long-option syntax isn't supported at all here (`grep: --include=Makefile:
  No such file or directory`, i.e. it tried to open the literal pattern text
  as a file). Worse, that error was silently swallowed by a `2>/dev/null`
  redirect I'd added defensively, and under `set -euo pipefail` the
  resulting exit code aborted the whole script with zero visible error
  text in the log - a real lesson: don't redirect stderr away from a
  code path you haven't independently verified handles every edge case
  yet, especially under `pipefail`, where a swallowed error can silently
  determine the whole script's fate. Fixed by switching to `find . \(
  -name "Makefile" -o -name "*.mak" \) -print0 | xargs -0 grep -l ...`
  instead - `find -name` is universally supported, sidestepping this
  `grep` build's `--include` gap entirely. Verified the whole patch
  pipeline standalone against synthetic test files (confirmed exit 0,
  correct output) before trusting it inside the real build again.

## Resolution stress test, then Phases 2-6 of the six-flow plan

With Phase 1 (thumbnails) shipped, `generate_test_input()` was
parameterized with `width`/`height` (defaulting to the original
320x240 when unset - every existing test and call site stays
unaffected) and pointed at a ramping stress test across SD/HD/FHD/4K/8K
before committing to the remaining five flows, on the theory that a
resolution ceiling would be a more interesting and more likely failure
mode for this pipeline than a duration one (every encoder here already
processes video frame-by-frame regardless of length; resolution is what
actually stresses per-frame buffer sizing).

**Finding: OpenH264 hard-rejects `width * height > 9,437,184` pixels** -
a real, permanent codec-level validation limit (not a bug, not a wasm
memory ceiling), hit cleanly at the 8K step. Documented as a known
ceiling for the `libopenh264` renditions specifically; SVT-AV1/x264/x265
were not tested against the same ceiling since the stress test's purpose
was finding *a* real ceiling to document, not exhaustively characterizing
every encoder's own limit.

The remaining five flows from the original plan were then implemented in
order (thumbnails was Phase 1; multi-audio, loudness, HDR10, low-latency
dispatch, and HEVC were Phases 2-6):

### Phase 2: multi-audio-track passthrough

`do_transcode()`, `probe_streams()`, and `slice()` each picked audio via
`else if (t == AVMEDIA_TYPE_AUDIO && audio_idx < 0) audio_idx = i` -
first stream only, in three separate places. Replaced with
`MAX_AUDIO_STREAMS`-sized (`8`) arrays and loops in all three, following
the exact per-stream copy/rescale pattern the single-track code already
used, just repeated per index instead of hardcoded once.
`generate_test_input()` gained an `extra_audio_track` flag (a second
880Hz tone alongside the default 440Hz one, standing in for a Fr/En
dual-track source - no real bilingual fixture needed to prove the
mechanism) via a `write_tone_track()` helper factored out of the
previous single-track inline code. `probe_streams()` now decodes from
every audio track (not just the first) and exposes two new getters,
`get_last_probe_audio_tracks()`/`get_last_probe_min_decoded_audio_frames()`,
so `test/test-multi-audio.js` can assert both tracks survive the source,
a whole-file transcode, and every sliced chunk independently - not just
that the container has two streams, but that both actually decode.
**Verified, all green, no regressions to the existing suite.**

### Phase 3: EBU R128 loudness normalization

The first real `avfilter` graph anywhere in this codebase - audio
previously always stream-copied; this flow needs a genuine decode ->
filter -> re-encode chain (`abuffer` -> `loudnorm` -> `abuffersink`).
New build flags: `--enable-filter=abuffer,abuffersink,loudnorm`. Three
real bugs found and fixed while building the graph, all from the same
underlying gotcha:

- **Bug 1**: used `avfilter_graph_create_filter()` for `abuffer`, then
  tried to set its sample-format option afterward - that function inits
  the filter immediately with no format, so it failed with "Sample
  format was not set or was invalid". **Fixed**: the two-step pattern
  instead - `avfilter_graph_alloc_filter()` (allocate only) +
  `av_buffersrc_parameters_set()` + `avfilter_init_str(ctx, NULL)`
  (init after options are set).
- **Bug 2**: same root cause for `abuffersink`'s `sample_fmts` option -
  "not a runtime option and so cannot be set after the object has been
  initialized". **Fixed**: same two-step pattern.
- **Bug 3**: `loudnorm` doesn't preserve AAC's fixed 1024-sample frame
  size - it emitted arbitrarily-sized chunks (19200/2304/556800 samples
  seen across one run), which `avcodec_send_frame()` then rejected.
  **Fixed**: `av_buffersink_set_frame_size(norm_sink_ctx,
  norm_enc_ctx->frame_size)` forces fixed-size output chunks matching
  the AAC encoder's own frame size.

`test/test-loudnorm.js` verifies the filtered audio survives as real,
independently decodable audio end to end - it does **not** verify the
actual LUFS value lands at the target, which is out of scope (would
need a real loudness-measurement tool in the test itself, not just
ffmpeg). Also worth flagging as a real, honest architectural tension for
this doc rather than hiding it: `loudnorm`'s single-pass mode is what's
usable per-chunk in this architecture, but that doesn't guarantee
consistent loudness *across* chunks the way a whole-file two-pass
analysis would.

### Phase 4: HDR10 metadata passthrough

Two layers of HDR metadata, handled differently:

- **Container/codec-level** (`color_primaries`/`color_trc`/`colorspace`/
  `chroma_sample_location`): copied straight from `dec_ctx` to
  `enc_ctx` right after encoder framerate setup in `do_transcode()`.
  Note the naming trap here - `AVCodecParameters` calls this field
  `color_space`, but `AVCodecContext` calls the *same concept*
  `colorspace` (no underscore) - easy to typo past the compiler since
  both are valid identifiers, just on different structs.
- **Frame-level side data** (`AVMasteringDisplayMetadata`/
  `AVContentLightMetadata`, via `av_frame_get_side_data()`/
  `av_*_create_side_data()`): copied frame-by-frame in the decode loop,
  with `av_frame_remove_side_data()` called first since the `scaled`
  frame is reused across iterations and stale side data would otherwise
  leak into subsequent frames that shouldn't carry it.

**A real use-after-free bug**, found and fixed in the new `probe_hdr()`
verification function: the original code called
`avformat_close_input(&fmt)` (which frees the `AVFormatContext` and
every `AVStream`/`AVCodecParameters` hanging off it) *before*
`return cp->color_primaries`, reading already-freed memory - confirmed
by comparing a pre-close `fprintf` (correct value, 9) against the
post-close return (garbage). **Fixed**: capture the value into a local
before closing.

**Honestly documented gap, not a bug**: `test-hdr.js` confirms
`color_primaries` (container-level) survives `do_transcode()` end to
end, but mastering-display/content-light *side data* does not -
`has_mastering_display_metadata=0` on both the source and the
transcoded output. Root-caused to `generate_test_input()`'s own
OpenH264-based encode step never serializing attached `AVFrame` side
data into the H.264 bitstream at encode time in the first place (the
fixture never carries it to begin with), not a bug in the passthrough
code itself - confirmed by swapping in `libx264` as the transcode-step
encoder and seeing the identical result either way, ruling out
`do_transcode()`'s own encoder choice as the cause.

### Phase 5: low-latency chunked dispatch

JS-only, no wasm rebuild. `runFleetRace()` in `app.js` previously
dispatched one `compute.for()` job covering every chunk in the video;
refactored to group `units` by `chunkIndex` and dispatch one job *per
chunk*, back to back, not awaited between dispatches
(`chunkJobPromises.push(job.exec(...).catch(...))`, `await
Promise.all(chunkJobPromises)` at the end) - each chunk gets its own
`job.on('result'/'error'/'nofunds')` wiring, feeding a shared
`handleResult()` keyed by `(chunkIndex, label)` so it doesn't matter
which job a given result actually came from. Real, disclosed limitation
worth stating plainly: `slice()` (the C function) still processes the
whole input file in one call, so this demo's own chunks all become
available at roughly the same moment regardless of this change - what
actually changes is that the *dispatch* code no longer needs the full
chunk count up front before it can start submitting jobs, which is
exactly the part that would need to be true for a genuinely
live/incrementally-arriving source. Not tested against a live DCP
fleet in this session (acknowledged limitation, consistent with this
project's pattern of flagging what's verified vs. not).

### Phase 6: HEVC via libx265 - a build/link saga, then a real runtime hang, then a real fix

Same shape as the x264/SVT-AV1 additions before it: clone `../../x265`
as a sibling checkout, add a wasm build stage to `build.sh`, `emcmake
cmake` (not `emconfigure`/`make` - x265 is CMake-based, source lives in
a `source/` subdirectory, not the repo root), `--enable-libx265
--enable-encoder=libx265`. Unlike x264/openh264/SVT-AV1, x265 has no
compile-time single-thread build toggle - single-threadedness has to
come from the `x265-params` AVOption passthrough at runtime
(`pools=none:frame-threads=1`, mirroring the `svtav1-params lp=1`
pattern already established for SVT-AV1). Three real build/link bugs,
then a genuine runtime hang that turned out to need actual source
patching to fix - by far the longest single item in this project's
build history.

**Build/link bugs (all three fixed, all three now committed patches
under `patches/`, applied idempotently by `build.sh`):**

- **`-march=i686` under Emscripten**: x265's `source/CMakeLists.txt`
  detects "X86" purely from `CMAKE_SYSTEM_PROCESSOR` matching an alias
  list (`x86`/`i386`/`i686`/`x86_64`/`amd64`) - Emscripten's toolchain
  file reports one of these, so x265 unconditionally injected
  `-march=i686` (a real x86 CPU flag), which clang rejects outright for
  `wasm32-unknown-emscripten` ("unsupported option '-march=' for
  target"). **Fixed**: `patches/x265-no-march-under-emscripten.patch`,
  one line (`elseif(X86 AND NOT X64)` -> `elseif(X86 AND NOT X64 AND
  NOT EMSCRIPTEN)` - CMake auto-defines `EMSCRIPTEN=TRUE` under
  Emscripten's own toolchain file, so this excludes exactly the one
  case that needs excluding).
- **pkg-config shim misnamed**: ffmpeg's configure calls
  `require_pkg_config libx265 x265 x265.h x265_api_get`. First guess
  was that arg 1 (`libx265`) was the real pkg-config package name -
  wrong. Traced through configure's own `test_pkg_config()` (`pkg="${2%%
  *}"`) and confirmed arg 2 (`x265`) is what's actually searched for;
  arg 1 is just ffmpeg's internal component name. **Fixed**: the shim
  file is `Bell/tools/pkgconfig-shim/x265.pc` with `Name: x265` inside,
  not `libx265.pc`.
- **`x265_config.h` not found**: this header is CMake-*generated*, and
  lands in `build-wasm/`, not `source/` - the shim's `Cflags` only
  pointed at `source/`. **Fixed**: added `-I${libdir}` (already =
  `build-wasm/`) alongside the existing `-I${includedir}`.
- **`sem_close`/`sem_unlink` undefined symbols** at link time, from
  `ringmem.cpp.o`: x265's `NamedSemaphore` class (an optional feature
  for sharing CTU-info analysis data *across processes*) uses real
  POSIX named semaphores in its non-`_WIN32` branch. Emscripten's libc
  implements pthread mutex/cond as real (if single-threaded) stubs, but
  doesn't implement named semaphores at all. **Fixed**:
  `patches/x265-emscripten-namedsemaphore-stub.patch` - a no-op stub
  under `#ifdef __EMSCRIPTEN__` (`create()`/`give()`/`take()` always
  report success, `release()` does nothing), architecturally correct
  since a single-process wasm module has no other process to
  synchronize with, and this feature is never invoked by this project's
  basic encode call regardless.

With all four fixed, the build succeeded cleanly (`ffmpeg_g` linked,
`wasm-bytes.js` grew to ~14.4MB base64) and x265's own init logging
showed exactly the intended configuration (`No thread pool allocated,
--wpp disabled` / `frame threads / pool features: 1 / none`) - and then
a smoke-test encode hung indefinitely with zero further output.

**Confirming it was a real hang, not just slow encoding**: checked the
stuck process's actual start time against wall-clock time (~14 minutes
elapsed with zero progress, versus low-single-digit seconds for
comparable jobs on every other encoder) before killing it. Investigated
locally and via web search for known Emscripten-threading footguns
before finding the exact mechanism in x265's own source:

- `Encoder::init()` (`encoder.cpp:513-514`) does
  `m_frameEncoder[i]->start(); m_frameEncoder[i]->m_done.wait();` - the
  calling thread creates a `FrameEncoder` worker thread, then
  *immediately blocks* waiting for an event only that new thread can
  signal (`Thread::start()` -> `pthread_create()`;
  `FrameEncoder::threadMain()` -> `m_done.trigger()` after its own
  setup, `frameencoder.cpp`).
- `frameNumThreads` (and therefore at least one `FrameEncoder` thread)
  is **never zero** - `pools=none:frame-threads=1` only disables the
  *optional* extra thread pool (`m_numPools == 0`, confirmed both from
  the log output and from `encoder.cpp`'s `if (m_numPools) { ...
  m_threadPool[j].start() ... }` being correctly skipped), not this
  always-present worker.
- This sandbox has no real second thread of execution available to a
  DCP work function (single V8 isolate, no Worker constructor - already
  documented in `patches/ffmpeg-single-thread-pthread-detection.patch`'s
  own comment, written for an earlier encoder). `pthread_create()`
  "succeeding" without real concurrency behind it, followed by an
  immediate blocking wait for a signal only the uncreated thread can
  send, is the textbook Emscripten single-thread-build deadlock shape.

**The fix that actually worked**: rather than trying to make
`pthread_create()`/`pthread_join()` behave like real threads (not
possible in this sandbox), traced whether x265's own call pattern at
`frameNumThreads=1` was actually using real concurrency at all. It
isn't: `Encoder::encode()` (`encoder.cpp:1991-2032`) already calls
`getEncodedPicture()` (blocks for the *previous* frame) before
`startCompressFrame()` (kicks off the *next* frame) - strictly
sequential, never two frames in flight. The thread/event handshake
wasn't buying any real concurrency in this configuration; it was a
synchronous function call wearing a threaded costume. That makes
replacing it with a direct synchronous call architecturally sound, not
a hack.

`patches/x265-emscripten-synchronous-frameencoder.patch`
(`source/encoder/frameencoder.h`/`.cpp`): under `#ifdef __EMSCRIPTEN__`,
`FrameEncoder` declares its own non-virtual `start()`/`stop()` that
*shadow* (hide, not override - `Thread::start()`/`stop()` aren't
virtual) the base `Thread` class's versions for any call through a
`FrameEncoder*`-typed pointer (confirmed via `grep` that both real call
sites in the whole x265 tree - `encoder.cpp:513` and `:648` - go through
exactly such a pointer). `threadMain()`'s body was split into two
reusable pieces: `runThreadInit()` (the one-time per-NUMA-node/TLD
setup) and `runFrameCompress()` (wait-for-reference-data, compress,
signal done) - both still used by the real (non-Emscripten) threaded
path via `threadMain()` unchanged, and both called directly, inline, by
the new synchronous path:

- `FrameEncoder::start()` calls `runThreadInit()` then
  `m_done.trigger()` synchronously, so `encoder.cpp:514`'s
  `m_done.wait()` returns immediately (`Event` is a real counting
  semaphore - `trigger()` before `wait()` leaves the counter
  incremented, so a later `wait()` doesn't block; verified by reading
  `Event`'s implementation in `threading.h`, not assumed).
- `startCompressFrame()` calls `runFrameCompress()` directly instead of
  `m_enable.trigger()` under `__EMSCRIPTEN__`.
- `FrameEncoder::stop()` is a no-op - nothing was ever spawned to join
  (the base `Thread`'s private `thread` handle stays `0` since the base
  `Thread::start()` is never called).
- The generic `Thread`/`ThreadPool` machinery elsewhere in x265 is
  untouched - safe specifically because this project always sets
  `pools=none`, so no other code path ever calls `ThreadPool::start()`.

Result: the same 30-frame smoke test that hung for 14+ minutes completed
in 827ms after the patch. Full `test/test-codec-bakeoff.js` re-run
against all four encoders confirms real, working numbers (100-frame
chunk-sized clip, quality mode): `libopenh264` 104703 bytes,
`libx264` 61324 bytes, `libsvtav1` 50517 bytes, `libx265` 58882 bytes -
and at 400kbps ABR: `libopenh264` 103729, `libx264` 208185,
`libsvtav1` 133684, `libx265` 212269 bytes. All 8 pre-existing Node
tests still pass with zero regressions.

### Browser demo wiring for Phases 2-6

HEVC (Phase 6) rides alongside the existing H.264/AV1 pair in the
codec-comparison section (`hevc-240p` rendition, `RENDITIONS` in
`app.js`) - same quality-mode-not-bitrate-cap comparison methodology
already established for AV1. Low-latency dispatch (Phase 5) is already
the shape of `runFleetRace()` itself, not a separate toggle. Loudness
normalization (Phase 3) got a real UI toggle ("Normalize loudness (EBU
R128) on every rendition") wired through to both the local race
(`transcodeSegment` params) and the fleet race (`unit.normalizeLoudness`
on each dispatched job unit, read by the existing `workFunction`).
Multi-audio-track (Phase 2) and HDR10 (Phase 4) passthrough are both
**transparent** - a real upload with its own multiple audio tracks or
HDR10 metadata already passes through automatically, with no toggle
needed, since the underlying `do_transcode()` change isn't
user-selectable behavior in a real pipeline either. A second checkbox
("Demo clip: dual-language audio + HDR10 tags") only affects the
*generated* demo clip, since the synthetic generator needs an explicit
flag to fabricate a second track/HDR metadata to demonstrate the
passthrough against - real uploads need no such flag. Syntax-checked
and DOM-cross-referenced; not exercised in a live browser in this
session (no browser-automation tool available), consistent with this
project's established pattern for browser-only surfaces.
