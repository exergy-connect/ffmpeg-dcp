#!/usr/bin/env bash
# Builds openh264, x264, SVT-AV1, x265, and ffmpeg for wasm if not
# already built, applies the required patches, and compiles
# src/dcp-transcode.c against all four encoders into
# ffmpeg-wasm/dcp-transcode-glue.js + .wasm (fetched directly by the
# browser demo - no wasm-bytes.js base64 step needed here, unlike the
# Node-deployer copy of this script). See
# ../ffmpeg-dcp-deploy/ffmpeg-openh264-wasm-dcp.md for the reasoning
# behind every flag/patch - this script captures the *what*, the doc has
# the *why*.
#
# Assumes sibling checkouts two levels up (see ../../../SETUP.md):
#   ../../emsdk        - emscripten SDK
#   ../../openh264      - github.com/cisco/openh264, git-cloned directly
#   ../../x264           - code.videolan.org/videolan/x264, git-cloned directly
#   ../../SVT-AV1        - gitlab.com/AOMediaCodec/SVT-AV1, git-cloned directly
#   ../../x265           - x265 source, git-cloned directly
#   ../../ffmpeg         - ffmpeg n8.1.1, git-cloned directly (tag n8.1.1)
#   ../../ffmpeg-build-wasm - empty dir, out-of-tree ffmpeg build output
set -euo pipefail
cd "$(dirname "$0")"

# Absolute, not relative: several steps below `cd` into a sibling source
# tree before invoking emcc/emconfigure/cmake, and a relative EMSDK_NODE/
# EMSDK_PYTHON (or PATH entry) gets re-resolved against whatever the
# process's cwd is *at exec time*, not against where it was set - breaks
# with a `pylauncher: CreateProcess failed (2)` the moment cwd differs
# from this script's own directory. Cost a real debug cycle on the
# SVT-AV1 step below before being made absolute here.
EMSDK="$(cd ../../emsdk && pwd)"
# Windows-native (`pwd -W`, "C:/..."), not MSYS-style (`pwd`, "/c/..."),
# specifically for the four source/build dirs below: each gets passed as
# a configure/cmake source-tree argument and ends up embedded in a
# generated Makefile (e.g. ffmpeg's out-of-tree Makefile literally
# `include`s "$(SRC_PATH)/Makefile"). The `make` on this machine's PATH
# (make-portable, a native Win32 GNU Make build, not an MSYS one) can't
# resolve an MSYS-style "/c/..." path inside a Makefile `include`
# directive - "No such file or directory" even though the file
# genuinely exists at that path, just not in a form this make
# understands. Cost a real debug cycle the first time the ffmpeg build
# ran from a truly clean state (every prior run had `libavcodec.a`
# already cached, so this never actually executed until then). Plain
# `pwd` (not `-W`) stays correct for EMSDK/PKGCONFIG_SHIM/MAKE_PORTABLE/
# STRINGS_SHIM below - those get concatenated into bash's own $PATH
# string later, where a "C:/..." value would break PATH's colon-
# delimited parsing instead of fixing anything.
OPENH264_SRC="$(cd ../../openh264 && pwd -W)"
X264_SRC="$(cd ../../x264 && pwd -W)"
SVTAV1_SRC="$(cd ../../SVT-AV1 && pwd -W)"
X265_SRC="$(cd ../../x265 && pwd -W)"
FFMPEG_SRC="$(cd ../../ffmpeg && pwd -W)"
# MSYS-style form of the same directory, captured directly (not derived
# by string-transforming FFMPEG_SRC - simpler and can't drift out of sync)
# - needed below to patch ffmpeg's generated Makefile, which embeds this
# form regardless of which style was used to invoke configure. See that
# step's own comment for why.
FFMPEG_SRC_MSYS="$(cd ../../ffmpeg && pwd)"
FFMPEG_BUILD="$(mkdir -p ../../ffmpeg-build-wasm && cd ../../ffmpeg-build-wasm && pwd -W)"
PKGCONFIG_SHIM="$(cd ../tools/pkgconfig-shim && pwd)"
MAKE_PORTABLE="$(cd ../../make-portable/bin && pwd)"
STRINGS_SHIM="$(cd ../tools/strings-shim && pwd)"

# cmake/ninja (used by the SVT-AV1 and x265 steps below) aren't bundled
# here - see SETUP.md's "pip install cmake ninja" note; adjust PATH if
# yours live somewhere pip didn't put them on automatically. `pip install`
# defaulted to a per-user install (not on PATH by default on Windows) -
# confirmed live via `python -m site --user-base`, same hardcoded-version-
# segment style as EMSDK_NODE/EMSDK_PYTHON below since this whole PATH
# setup already accepts that tradeoff for this machine's toolchain.
PIP_USER_SCRIPTS="$(python -m site --user-base 2>/dev/null)/Python314/Scripts"
export PATH="$MAKE_PORTABLE:$STRINGS_SHIM:$EMSDK:$EMSDK/upstream/emscripten:$EMSDK/upstream/bin:$PKGCONFIG_SHIM:$PIP_USER_SCRIPTS:$PATH"
export EMSDK_NODE="$EMSDK/node/24.19.0_64bit/node.exe"
export EMSDK_PYTHON="$EMSDK/python/3.13.3_64bit/python.exe"

# --- 1. openh264 (BSD H.264 encoder), single-threaded, SIMD128 ---
if [ ! -f "$OPENH264_SRC/libopenh264.a" ]; then
  echo "Building openh264 for wasm..."
  ( cd "$OPENH264_SRC" && \
    find . -name "*.o" -delete && find . -name "*.d" -delete && rm -f libopenh264.a && \
    make -j4 libopenh264.a OS=linux ARCH=wasm32 CC=emcc CXX=em++ AR=emar \
      CFLAGS_OPT="-O3 -msimd128 -mbulk-memory" )
fi

# --- 1b. x264 (GPL H.264 encoder, real CRF), single-threaded, SIMD128 ---
# --host=wasm32-unknown-linux hits configure's cpu/os fallback cases (no
# arch-specific asm/CFLAGS pollution like -m32, plain SYS=LINUX) rather
# than any real host triplet. Needs a `strings` shim (STRINGS_SHIM above)
# for configure's own endianness self-test - real binutils strings isn't
# available in this Windows toolchain.
if [ ! -f "$X264_SRC/libx264.a" ]; then
  echo "Building x264 for wasm..."
  ( cd "$X264_SRC" && \
    CC=emcc AR=emar RANLIB=emranlib sh ./configure \
      --host=wasm32-unknown-linux \
      --disable-asm --disable-cli --disable-thread --disable-opencl \
      --disable-avs --disable-swscale --disable-lavf --disable-ffms --disable-gpac --disable-lsmash \
      --enable-static --bit-depth=8 --chroma-format=420 \
      --extra-cflags="-O3 -msimd128 -mbulk-memory" && \
    emmake make -j4 libx264.a )
fi

# --- 1c. SVT-AV1 (BSD/AOM AV1 encoder), lp=1 single-thread mode, SIMD128 ---
# COMPILE_C_ONLY=ON is explicit belt-and-suspenders - CMake's own
# HAVE_X86_PLATFORM/HAVE_ARM_PLATFORM compile-time checks already fail
# under emcc (neither __x86_64__ nor __aarch64__ is defined for a wasm32
# target), so no nasm/arch-specific path gets pulled in either way.
if [ ! -f "$SVTAV1_SRC/Bin/Release/libSvtAv1Enc.a" ]; then
  echo "Building SVT-AV1 for wasm..."
  ( cd "$SVTAV1_SRC" && \
    emcmake cmake -S . -B build-wasm -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_APPS=OFF \
      -DBUILD_TESTING=OFF \
      -DCOMPILE_C_ONLY=ON \
      -DCMAKE_C_FLAGS="-O3 -msimd128 -mbulk-memory" \
      -DCMAKE_CXX_FLAGS="-O3 -msimd128 -mbulk-memory" && \
    cmake --build build-wasm --target SvtAv1Enc -j4 )
fi

# --- 1d. x265 (GPL HEVC encoder), no compile-time single-thread toggle.
# CMakeLists.txt lives in source/, not the repo root (confirmed via
# x265's own build/linux/make-Makefiles.bash reference script). Unlike
# x264/openh264, there's no --disable-thread-style flag here - x265's
# frame/wavefront parallelism is threaded by design, not optional at
# build time. Disabling it (pools=none) happens at RUNTIME instead, via
# ffmpeg's "x265-params" AVOption passthrough in dcp-transcode.c (same
# pattern as SVT-AV1's "svtav1-params lp=1" elsewhere in this project).
# ENABLE_ASSEMBLY=OFF for the same reason as every other encoder here
# (no x86/NASM under wasm32).
#
# Idempotent, same as the ffmpeg patch below: only apply if not already
# applied. Real bug this patches around, found live: x265's own
# CMakeLists.txt detects "X86" purely from CMAKE_SYSTEM_PROCESSOR
# matching an alias list (x86/i386/i686/x86_64/amd64) - Emscripten's
# toolchain reports one of these, so x265 unconditionally injects
# `-march=i686` (a real x86 CPU flag) into the compile command, which
# clang rejects outright for the wasm32-unknown-emscripten target
# ("unsupported option '-march=' for target ..."). CMake automatically
# defines EMSCRIPTEN=TRUE under Emscripten's own toolchain file - the
# patch just excludes that case from the existing X86-detection branch,
# one line changed.
if ! grep -q "NOT EMSCRIPTEN" "$X265_SRC/source/CMakeLists.txt"; then
  git -C "$X265_SRC" apply "$(cd "$(dirname "$0")" && pwd)/patches/x265-no-march-under-emscripten.patch"
fi

# x265's optional external CTU-info sharing feature (ringmem.cpp) uses real
# POSIX named semaphores for cross-process sync - meaningless in a single-
# process wasm module, and unlike pthread mutex/cond (which Emscripten's
# libc does stub for single-threaded builds), sem_open/sem_close/sem_unlink
# aren't implemented at all, so this is a real link-time undefined-symbol
# error without the stub below, even though the feature itself is never
# invoked by this project's basic encode call.
if ! grep -q "__EMSCRIPTEN__" "$X265_SRC/source/common/threading.h"; then
  git -C "$X265_SRC" apply "$(cd "$(dirname "$0")" && pwd)/patches/x265-emscripten-namedsemaphore-stub.patch"
fi

# x265's FrameEncoder always spawns at least one real OS thread (frame-
# threads=1 only disables the *optional* extra thread pool, not this one),
# synchronized with the main encoder thread via blocking events - the
# calling thread signals "start a frame" and immediately blocks waiting
# for "frame done", a signal only the spawned thread can send. This sandbox
# has no real second thread of execution (no -pthread, no Worker), so that
# wait hangs forever. With frame-threads=1, x265's own call pattern already
# never overlaps two frames (Encoder::encode() waits for the previous frame
# before starting the next), so the thread was never buying real
# concurrency here - this patch replaces the thread+event handshake with a
# direct synchronous call for FrameEncoder specifically, leaving the
# generic Thread/ThreadPool machinery (unused when x265-params sets
# pools=none, as this project always does) untouched.
if ! grep -q "__EMSCRIPTEN__" "$X265_SRC/source/encoder/frameencoder.h"; then
  git -C "$X265_SRC" apply "$(cd "$(dirname "$0")" && pwd)/patches/x265-emscripten-synchronous-frameencoder.patch"
fi

if [ ! -f "$X265_SRC/build-wasm/libx265.a" ]; then
  echo "Building x265 for wasm..."
  ( cd "$X265_SRC" && \
    emcmake cmake -S source -B build-wasm -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DENABLE_SHARED=OFF \
      -DENABLE_CLI=OFF \
      -DENABLE_ASSEMBLY=OFF \
      -DCMAKE_C_FLAGS="-O3 -msimd128 -mbulk-memory" \
      -DCMAKE_CXX_FLAGS="-O3 -msimd128 -mbulk-memory" && \
    cmake --build build-wasm -j4 )
fi

# --- 2. ffmpeg n8.1.1: patch configure, then configure+build ---
if [ ! -f "$FFMPEG_BUILD/libavcodec/libavcodec.a" ]; then
  echo "Building ffmpeg for wasm (this is the long one)..."

  # Idempotent: only apply if not already applied.
  if ! grep -q "DCP/wasm patch" "$FFMPEG_SRC/configure"; then
    git -C "$FFMPEG_SRC" apply "$(cd "$(dirname "$0")" && pwd)/patches/ffmpeg-single-thread-pthread-detection.patch"
  fi

  export EM_PKG_CONFIG_PATH="$(cd "$PKGCONFIG_SHIM" && pwd)"
  export PKG_CONFIG_PATH="$EM_PKG_CONFIG_PATH"

  mkdir -p "$FFMPEG_BUILD"
  ( cd "$FFMPEG_BUILD" && emconfigure sh "$FFMPEG_SRC/configure" \
    --target-os=none --arch=x86_32 --cpu=generic \
    --enable-cross-compile --disable-x86asm --disable-inline-asm \
    --disable-asm --disable-stripping \
    --disable-programs --enable-ffmpeg \
    --disable-doc --disable-debug \
    --disable-everything \
    --enable-protocol=file \
    --enable-demuxer=mov,matroska,mpegts,wav \
    --enable-muxer=mp4,mpegts,hls,null \
    --enable-decoder=h264,hevc,aac,pcm_s16le,wrapped_avframe,av1 \
    --enable-encoder=aac,mjpeg \
    --enable-libopenh264 --enable-encoder=libopenh264 \
    --enable-gpl --enable-libx264 --enable-encoder=libx264 \
    --enable-libsvtav1 --enable-encoder=libsvtav1 \
    --enable-libx265 --enable-encoder=libx265 \
    --enable-parser=h264,hevc,aac,av1 \
    --enable-filter=scale,fps,aresample,anull,null,setpts,testsrc,color,abuffer,abuffersink,loudnorm \
    --enable-indev=lavfi \
    --disable-network --disable-autodetect \
    --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ \
    --host-cc=clang.exe --host-extralibs= \
    --extra-cflags="-O3 -msimd128 -mbulk-memory" \
    --extra-cxxflags="-O3 -msimd128 -mbulk-memory" \
    --extra-ldflags="-sDEFAULT_TO_CXX=1" )

  # ffmpeg's own configure re-derives its source path internally (`cd
  # $(dirname "$0") && pwd`, inside the MSYS `sh` running it) regardless
  # of which style path was used to invoke it - so every generated
  # Makefile/*.mak file embeds the MSYS form ("/c/...") no matter what
  # FFMPEG_SRC above was set to. The `make` on this machine's PATH
  # (make-portable, a native Win32 GNU Make build, not an MSYS one)
  # can't resolve that form in an `include` directive - fails with "No
  # such file or directory" even though the file is genuinely right
  # there, just not in a form this make understands. Cost a real debug
  # cycle the first time this build ever ran from a truly clean state
  # (every prior run had libavcodec.a already cached, so this step
  # never actually executed until then). Rewrite every occurrence back
  # to the Windows-native form post-configure, before make runs -
  # patching generated build files rather than fighting the tool that
  # generates them. `find -name`, not `grep --include`: this grep
  # build doesn't support --include=PATTERN at all (errors "No such
  # file or directory" on the literal pattern text) - a second, real
  # portability gap found while chasing the first one.
  ( cd "$FFMPEG_BUILD" && find . \( -name "Makefile" -o -name "*.mak" \) -print0 \
      | xargs -0 grep -l -- "$FFMPEG_SRC_MSYS" 2>/dev/null \
      | xargs -r sed -i "s#$FFMPEG_SRC_MSYS#$FFMPEG_SRC#g" )

  ( cd "$FFMPEG_BUILD" && emmake make -j4 )
fi

# --- 3. dcp-transcode.c -> ffmpeg-wasm/dcp-transcode.wasm + ffmpeg-wasm/dcp-transcode-glue.js ---
echo "Compiling dcp-transcode.c..."
emcc src/dcp-transcode.c -O3 -msimd128 -mbulk-memory \
  -I "$FFMPEG_BUILD" -I "$FFMPEG_SRC" \
  -L "$FFMPEG_BUILD/libavformat" -L "$FFMPEG_BUILD/libavcodec" \
  -L "$FFMPEG_BUILD/libavutil" -L "$FFMPEG_BUILD/libswscale" \
  -L "$FFMPEG_BUILD/libswresample" -L "$FFMPEG_BUILD/libavfilter" \
  -L "$OPENH264_SRC" -L "$X264_SRC" \
  -L "$SVTAV1_SRC/Bin/Release" -L "$X265_SRC/build-wasm" \
  -lavfilter -lavformat -lavcodec -lavutil -lswscale -lswresample -lopenh264 -lx264 -lSvtAv1Enc -lx265 \
  -sDEFAULT_TO_CXX=1 \
  -sMODULARIZE=1 -sEXPORT_NAME=createFfmpegModule \
  -sENVIRONMENT=web,worker \
  -sEXPORTED_FUNCTIONS="['_transcode','_transcode_segment','_slice','_reencode_for_chunking','_generate_thumbnails','_get_chunk_frame_count','_get_source_fps','_generate_test_input','_probe_streams','_probe_hdr','_get_last_probe_audio_tracks','_get_last_probe_min_decoded_audio_frames','_main']" \
  -sEXPORTED_RUNTIME_METHODS="['ccall','cwrap','FS']" \
  -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sSTACK_SIZE=5MB \
  -o ffmpeg-wasm/dcp-transcode-glue.js

mv ffmpeg-wasm/dcp-transcode-glue.wasm ffmpeg-wasm/dcp-transcode.wasm
