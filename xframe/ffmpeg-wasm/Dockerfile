# Single-threaded custom FFmpeg WASM for the xFrame social transcoder.
# Build context must be xframe/ so src/ and the configure patch are available.

FROM emscripten/emsdk:6.0.7 AS builder

ENV PREFIX=/opt/ffmpeg-wasm
ENV FFMPEG_VERSION=n8.1.1
ENV CFLAGS="-O3 -msimd128 -mbulk-memory"
ENV CXXFLAGS="${CFLAGS}"

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      autoconf automake ca-certificates git libtool make pkg-config && \
    rm -rf /var/lib/apt/lists/*

# OpenH264 is the only external video encoder required by the social pipeline.
# install-static drops headers + openh264.pc so FFmpeg's pkg-config check passes.
ENV OPENH264_PREFIX=/opt/openh264
WORKDIR /src/openh264
RUN git clone --depth 1 https://github.com/cisco/openh264.git . && \
    make -j"$(nproc)" libopenh264.a \
      OS=linux ARCH=wasm32 CC=emcc CXX=em++ AR=emar \
      CFLAGS_OPT="${CFLAGS}" && \
    make install-static \
      OS=linux ARCH=wasm32 CC=emcc CXX=em++ AR=emar \
      PREFIX="${OPENH264_PREFIX}"

ENV PKG_CONFIG_PATH="${OPENH264_PREFIX}/lib/pkgconfig"
ENV EM_PKG_CONFIG_PATH="${PKG_CONFIG_PATH}"

WORKDIR /src/ffmpeg
RUN git clone --depth 1 --branch "${FFMPEG_VERSION}" https://github.com/FFmpeg/FFmpeg.git .
COPY ffmpeg-single-thread-pthread-detection.patch /tmp/ffmpeg-single-thread.patch
RUN git apply /tmp/ffmpeg-single-thread.patch

# The configure patch keeps FFmpeg's synchronous pthread stubs enabled without
# passing -pthread, so Emscripten emits ordinary ArrayBuffer memory and no
# pthread worker pool.
RUN pkg-config --exists --print-errors 'openh264 >= 1.3.0' && \
    emconfigure ./configure \
      --prefix="${PREFIX}" \
      --target-os=none \
      --arch=x86_32 \
      --cpu=generic \
      --enable-cross-compile \
      --disable-x86asm \
      --disable-inline-asm \
      --disable-asm \
      --disable-stripping \
      --disable-programs \
      --disable-doc \
      --disable-debug \
      --disable-everything \
      --enable-protocol=file \
      --enable-demuxer=mov,matroska,mpegts,wav \
      --enable-muxer=mp4,mpegts,null,webm,matroska \
      --enable-decoder=h264,aac,pcm_s16le,wrapped_avframe,vp8,vp9,opus,vorbis \
      --enable-encoder=aac,mjpeg \
      --enable-libopenh264 \
      --enable-encoder=libopenh264 \
      --enable-parser=h264,aac,vp8,vp9,opus,vorbis \
      --enable-bsf=vp9_superframe,vp9_raw_reorder \
      --enable-filter=scale,fps,aresample,anull,null,setpts,testsrc,color,abuffer,abuffersink,loudnorm \
      --enable-indev=lavfi \
      --enable-pthreads \
      --disable-network \
      --disable-autodetect \
      --nm=emnm \
      --ar=emar \
      --ranlib=emranlib \
      --cc=emcc \
      --cxx=em++ \
      --extra-cflags="${CFLAGS}" \
      --extra-cxxflags="${CXXFLAGS}" \
      --extra-ldflags="-sDEFAULT_TO_CXX=1" && \
    emmake make -j"$(nproc)"

COPY src/dcp-transcode.c /src/dcp-transcode.c
RUN mkdir -p /src/dist && \
    emcc /src/dcp-transcode.c ${CFLAGS} \
      -I /src/ffmpeg \
      $(pkg-config --cflags openh264) \
      -L /src/ffmpeg/libavformat \
      -L /src/ffmpeg/libavcodec \
      -L /src/ffmpeg/libavutil \
      -L /src/ffmpeg/libswscale \
      -L /src/ffmpeg/libswresample \
      -L /src/ffmpeg/libavfilter \
      -lavfilter -lavformat -lavcodec -lavutil -lswscale -lswresample \
      $(pkg-config --libs --static openh264) \
      -sDEFAULT_TO_CXX=1 \
      -sMODULARIZE=1 \
      -sEXPORT_NAME=createFfmpegModule \
      -sENVIRONMENT=web,worker \
      -sEXPORTED_FUNCTIONS="['_transcode','_transcode_segment','_slice','_slice_webm','_transcode_social_segment','_remux_to_mp4','_reencode_for_chunking','_generate_thumbnails','_get_chunk_frame_count','_get_source_fps','_generate_test_input','_probe_streams','_probe_hdr','_get_last_probe_audio_tracks','_get_last_probe_min_decoded_audio_frames','_main']" \
      -sEXPORTED_RUNTIME_METHODS="['ccall','cwrap','FS']" \
      -sFORCE_FILESYSTEM=1 \
      -sEXIT_RUNTIME=0 \
      -sINVOKE_RUN=0 \
      -sALLOW_MEMORY_GROWTH=1 \
      -sSTACK_SIZE=5MB \
      -o /src/dist/dcp-transcode-glue.js && \
    mv /src/dist/dcp-transcode-glue.wasm /src/dist/dcp-transcode.wasm

FROM scratch AS export
COPY --from=builder /src/dist/ /
