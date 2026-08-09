/*
 * DCP work-function driver: transcode(inputPath, outputPath, width,
 * height, bitrateKbps) reads a file from MEMFS, demuxes/decodes/scales
 * (libswscale)/encodes (libopenh264)/muxes, writes the result to
 * another MEMFS path. Single-threaded throughout - no fftools, no
 * scheduler, no pthread (see reference/full-pipeline-test.c and the
 * how-to doc for why that matters).
 */
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswscale/swscale.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <emscripten.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

/* fprintf(stderr, ...) only reaches the caller if the JS wrapper passes
 * explicit print/printErr callbacks - not wired to anything by default. */
#define TRANSCODE_FAIL(step, ret) \
  do { \
    fprintf(stderr, "[transcode] %s failed: %s (%d)\n", step, av_err2str(ret), ret); \
    return ret; \
  } while (0)

/* encoder_name selects the H.264 encoder for the bake-off: "libopenh264"
 * (default, BSD-licensed, no true CRF) or "libx264" (GPL, real CRF via
 * the "crf" AVOption - built with --enable-gpl, fine for this academic
 * PoC). bitrate_kbps <= 0 means "quality mode" for either encoder:
 * OpenH264's own RC_QUALITY_MODE (no fixed bitrate target) or x264's
 * CRF 23 (a real perceptual-quality target, not just an absence of rate
 * control). bitrate_kbps > 0 means ABR for either: OpenH264's
 * RC_BITRATE_MODE (via the string-valued "rc_mode" AVOption, avoiding a
 * guess at the enum's integer value) or x264's native bitrate mode
 * (triggered simply by setting avctx->bit_rate).
 * container is an ffmpeg muxer short name ("mp4" for a standalone
 * whole-file result, "mpegts" for an HLS-ready segment - the two
 * transcode()/transcode_segment() entry points below just fix this).
 * gop_size <= 0 leaves the encoder's own default keyframe interval;
 * > 0 forces one every gop_size frames - used by
 * reencode_for_chunking() below, not by transcode()/transcode_segment()
 * (both pass 0). */
static int do_transcode(const char *input_path, const char *output_path,
                         int out_width, int out_height, int bitrate_kbps,
                         const char *container, const char *encoder_name,
                         int gop_size) {
  int ret;

  {
    FILE *probe = fopen(input_path, "rb");
    if (!probe) {
      fprintf(stderr, "[transcode] input_path '%s' not found in MEMFS\n", input_path);
      return -1002;
    }
    fseek(probe, 0, SEEK_END);
    long input_size = ftell(probe);
    fclose(probe);
    if (input_size <= 0) {
      fprintf(stderr, "[transcode] input_path '%s' is empty\n", input_path);
      return -1002;
    }
  }

  /* ---- demux + decode input ---- */
  AVFormatContext *in_fmt = NULL;
  if ((ret = avformat_open_input(&in_fmt, input_path, NULL, NULL)) < 0)
    TRANSCODE_FAIL("avformat_open_input", ret);
  if ((ret = avformat_find_stream_info(in_fmt, NULL)) < 0)
    TRANSCODE_FAIL("avformat_find_stream_info", ret);

  int video_idx = -1, audio_idx = -1;
  for (unsigned i = 0; i < in_fmt->nb_streams; i++) {
    enum AVMediaType t = in_fmt->streams[i]->codecpar->codec_type;
    if (t == AVMEDIA_TYPE_VIDEO && video_idx < 0) video_idx = i;
    else if (t == AVMEDIA_TYPE_AUDIO && audio_idx < 0) audio_idx = i;
  }
  if (video_idx < 0) { fprintf(stderr, "[transcode] no video stream found\n"); return -1000; }

  const AVCodec *dec_codec = avcodec_find_decoder(in_fmt->streams[video_idx]->codecpar->codec_id);
  AVCodecContext *dec_ctx = avcodec_alloc_context3(dec_codec);
  avcodec_parameters_to_context(dec_ctx, in_fmt->streams[video_idx]->codecpar);
  dec_ctx->thread_count = 1;
  if ((ret = avcodec_open2(dec_ctx, dec_codec, NULL)) < 0)
    TRANSCODE_FAIL("decoder avcodec_open2", ret);

  /* ---- scaler: decoded size -> requested rendition size ---- */
  int dst_w = out_width > 0 ? out_width : dec_ctx->width;
  int dst_h = out_height > 0 ? out_height : dec_ctx->height;
  struct SwsContext *sws = sws_getContext(
      dec_ctx->width, dec_ctx->height, dec_ctx->pix_fmt,
      dst_w, dst_h, AV_PIX_FMT_YUV420P,
      SWS_BILINEAR, NULL, NULL, NULL);
  if (!sws) { fprintf(stderr, "[transcode] sws_getContext failed\n"); return -1001; }

  /* ---- encoder + output ---- */
  const AVCodec *enc_codec = avcodec_find_encoder_by_name(encoder_name);
  if (!enc_codec) { fprintf(stderr, "[transcode] unknown encoder '%s'\n", encoder_name); return -1004; }
  AVCodecContext *enc_ctx = avcodec_alloc_context3(enc_codec);
  enc_ctx->width = dst_w;
  enc_ctx->height = dst_h;
  enc_ctx->time_base = in_fmt->streams[video_idx]->time_base;
  /* time_base is a timestamp granularity (often much finer than the
   * actual frame interval, e.g. 1/90000), not 1/fps - openh264/x264
   * tolerate framerate being left unset, but SVT-AV1 falls back to
   * treating time_base as 1/fps when framerate isn't set explicitly,
   * which produces a nonsense value (e.g. "90000fps") that it then
   * rejects outright (its own sanity cap is 240fps). Always derive the
   * real rate from the source stream instead. */
  AVStream *in_video_stream = in_fmt->streams[video_idx];
  enc_ctx->framerate = in_video_stream->avg_frame_rate.num ?
      in_video_stream->avg_frame_rate : in_video_stream->r_frame_rate;
  enc_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
  enc_ctx->thread_count = 1;
  if (gop_size > 0) enc_ctx->gop_size = gop_size;

  if (strcmp(encoder_name, "libx264") == 0) {
    /* x264 was built with --disable-thread, so it never spawns real
     * threads regardless of avctx->thread_count - no sandbox-specific
     * workaround needed here, unlike OpenH264's manual thread_count=1. */
    av_opt_set(enc_ctx->priv_data, "preset", "veryfast", 0);
    if (bitrate_kbps > 0) {
      enc_ctx->bit_rate = bitrate_kbps * 1000;  /* setting bit_rate alone selects x264's ABR mode */
    } else {
      av_opt_set(enc_ctx->priv_data, "crf", "23", 0);  /* real CRF - x264's actual strength over OpenH264 */
    }
  } else if (strcmp(encoder_name, "libsvtav1") == 0) {
    /* lp=1 (level_of_parallelism) routes every one of SVT-AV1's 16
     * pipeline stages through its CONFIG_SINGLE_THREAD_KERNEL cooperative
     * dispatcher instead of spawning a pthread per stage - see the how-to
     * doc for how this was confirmed by reading enc_handle.c, the same
     * kind of hard threading wall that ruled out fftools/ffmpeg's own
     * CLI scheduler elsewhere in this project. Passed via the generic
     * "svtav1-params" passthrough since ffmpeg doesn't expose "lp" as a
     * dedicated AVOption. */
    av_opt_set(enc_ctx->priv_data, "svtav1-params", "lp=1", 0);
    av_opt_set_int(enc_ctx->priv_data, "preset", 10, 0);  /* 0=slowest/best .. 13=fastest; 10 favors speed for this PoC */
    if (bitrate_kbps > 0) {
      enc_ctx->bit_rate = bitrate_kbps * 1000;
    } else {
      av_opt_set_int(enc_ctx->priv_data, "crf", 35, 0);  /* real CRF, SVT-AV1's own 0-63 scale (roughly 2x x264's) */
    }
  } else {
    /* AV_PROFILE_H264_MAIN maps 1:1 to OpenH264's own PRO_MAIN=77; leaving
     * profile unset makes ffmpeg's openh264 wrapper default to the combined
     * AV_PROFILE_H264_CONSTRAINED_BASELINE flag value (578), which OpenH264's
     * EProfileIdc enum doesn't recognize and warns about (harmless - it falls
     * back to auto-detect - but avoidable). */
    enc_ctx->profile = AV_PROFILE_H264_MAIN;
    /* ffmpeg's openh264 wrapper defaults rc_mode to RC_QUALITY_MODE (not
     * off), and OpenH264 warns on every open unless skip-frame is allowed -
     * so this is needed regardless of whether bitrate_kbps requests real
     * bitrate control below. */
    av_opt_set_int(enc_ctx->priv_data, "allow_skip_frames", 1, 0);
    if (bitrate_kbps > 0) {
      enc_ctx->bit_rate = bitrate_kbps * 1000;
      av_opt_set(enc_ctx->priv_data, "rc_mode", "bitrate", 0);
    }
  }
  if ((ret = avcodec_open2(enc_ctx, enc_codec, NULL)) < 0)
    TRANSCODE_FAIL("encoder avcodec_open2", ret);

  AVFormatContext *out_fmt = NULL;
  avformat_alloc_output_context2(&out_fmt, NULL, container, output_path);
  AVStream *out_stream = avformat_new_stream(out_fmt, NULL);
  avcodec_parameters_from_context(out_stream->codecpar, enc_ctx);
  out_stream->time_base = enc_ctx->time_base;
  /* Audio is passed through untouched (no decode/re-encode) - rendition
   * differences (resolution/bitrate) only apply to video, so there's
   * nothing for a per-rendition audio re-encode to actually change. */
  AVStream *out_audio_stream = NULL;
  AVStream *in_audio_stream = audio_idx >= 0 ? in_fmt->streams[audio_idx] : NULL;
  if (in_audio_stream) {
    out_audio_stream = avformat_new_stream(out_fmt, NULL);
    avcodec_parameters_copy(out_audio_stream->codecpar, in_audio_stream->codecpar);
    /* codec_tag is a container-specific fourcc for the same codec_id -
     * copying the source's verbatim only works when source and output
     * are the same container family. A real third-party MP4 can carry a
     * codec_tag the output mp4 muxer's own strict compatibility check
     * rejects even though the underlying AAC is perfectly valid
     * ("Tag [...] incompatible with output codec id"). Zeroing it lets
     * the muxer pick its own correct tag for codec_id instead - this
     * never showed up against this project's own synthetic test clips
     * because those always round-tripped through our own encoder, whose
     * tag was already self-consistent. */
    out_audio_stream->codecpar->codec_tag = 0;
    out_audio_stream->time_base = in_audio_stream->time_base;
  }
  if ((ret = avio_open(&out_fmt->pb, output_path, AVIO_FLAG_WRITE)) < 0)
    TRANSCODE_FAIL("avio_open", ret);
  if ((ret = avformat_write_header(out_fmt, NULL)) < 0)
    TRANSCODE_FAIL("avformat_write_header", ret);

  /* ---- demux -> decode -> scale -> encode -> mux loop ---- */
  AVPacket *in_pkt = av_packet_alloc();
  AVFrame *frame = av_frame_alloc();
  AVFrame *scaled = av_frame_alloc();
  scaled->format = AV_PIX_FMT_YUV420P;
  scaled->width = dst_w;
  scaled->height = dst_h;
  av_frame_get_buffer(scaled, 32);
  AVPacket *out_pkt = av_packet_alloc();
  /* Fallback for decoded frames with no valid pts - real-world files
   * (as opposed to this project's own synthetic test clips, which always
   * set clean sequential pts) can hand back frames with pts unset, which
   * otherwise propagates straight through to the muxer ("Timestamps are
   * unset in a packet"). Extrapolates one frame-duration past the last
   * known-good pts (real or itself synthesized), NOT frame_index frames
   * from zero - this input can be a chunk carrying absolute (non-zero-
   * based) timestamps inherited from a much longer original video, where
   * a from-zero fallback would produce a small value wildly out of scale
   * with its real, large neighboring timestamps the moment any frame in
   * the chunk needed it ("non monotonically increasing dts to muxer",
   * confirmed live - a large real pts followed by a near-zero
   * frame-index-based one is a big backward jump, not just "unset"). */
  int64_t last_pts = AV_NOPTS_VALUE;
  const int64_t one_frame = av_rescale_q(1, av_inv_q(enc_ctx->framerate), in_video_stream->time_base);

  while (av_read_frame(in_fmt, in_pkt) >= 0) {
    if (in_pkt->stream_index == audio_idx) {
      av_packet_rescale_ts(in_pkt, in_audio_stream->time_base, out_audio_stream->time_base);
      in_pkt->stream_index = out_audio_stream->index;
      av_interleaved_write_frame(out_fmt, in_pkt);
      av_packet_unref(in_pkt);
      continue;
    }
    if (in_pkt->stream_index != video_idx) { av_packet_unref(in_pkt); continue; }
    ret = avcodec_send_packet(dec_ctx, in_pkt);
    av_packet_unref(in_pkt);
    if (ret < 0) TRANSCODE_FAIL("avcodec_send_packet", ret);

    while ((ret = avcodec_receive_frame(dec_ctx, frame)) >= 0) {
      sws_scale(sws, (const uint8_t *const *)frame->data, frame->linesize,
                0, dec_ctx->height, scaled->data, scaled->linesize);
      scaled->pts = (frame->pts != AV_NOPTS_VALUE)
          ? frame->pts
          : (last_pts != AV_NOPTS_VALUE ? last_pts + one_frame : 0);
      last_pts = scaled->pts;
      scaled->pict_type = AV_PICTURE_TYPE_NONE;

      avcodec_send_frame(enc_ctx, scaled);
      while (avcodec_receive_packet(enc_ctx, out_pkt) >= 0) {
        av_packet_rescale_ts(out_pkt, enc_ctx->time_base, out_stream->time_base);
        out_pkt->stream_index = out_stream->index;
        av_interleaved_write_frame(out_fmt, out_pkt);
      }
    }
  }
  avcodec_send_frame(enc_ctx, NULL);
  while (avcodec_receive_packet(enc_ctx, out_pkt) >= 0) {
    av_packet_rescale_ts(out_pkt, enc_ctx->time_base, out_stream->time_base);
    out_pkt->stream_index = out_stream->index;
    av_interleaved_write_frame(out_fmt, out_pkt);
  }
  av_write_trailer(out_fmt);
  avio_closep(&out_fmt->pb);

  sws_freeContext(sws);
  avcodec_free_context(&dec_ctx);
  avcodec_free_context(&enc_ctx);
  avformat_close_input(&in_fmt);
  avformat_free_context(out_fmt);
  av_frame_free(&frame);
  av_frame_free(&scaled);
  av_packet_free(&in_pkt);
  av_packet_free(&out_pkt);
  return 0;
}

/* Whole-file transcode: standalone MP4 in, standalone MP4 out.
 * encoder_name: "libopenh264" or "libx264" (see do_transcode above). */
EMSCRIPTEN_KEEPALIVE
int transcode(const char *input_path, const char *output_path,
              int out_width, int out_height, int bitrate_kbps,
              const char *encoder_name) {
  return do_transcode(input_path, output_path, out_width, out_height, bitrate_kbps, "mp4", encoder_name, 0);
}

/* Chunk transcode: one closed-GOP MPEG-TS chunk (see slice() below) in,
 * one HLS-ready MPEG-TS segment at the requested rendition out. */
EMSCRIPTEN_KEEPALIVE
int transcode_segment(const char *input_path, const char *output_path,
                       int out_width, int out_height, int bitrate_kbps,
                       const char *encoder_name) {
  return do_transcode(input_path, output_path, out_width, out_height, bitrate_kbps, "mpegts", encoder_name, 0);
}

/* slice() below only cuts at keyframes the source ALREADY has - cheap
 * (stream copy, no decode/encode) but means actual chunk size is
 * whatever the source's own keyframe interval happens to be, which can
 * be far bigger than any target_chunk_frames passed to slice() (a
 * "cut at or after N frames" target can't cut any sooner than the next
 * real keyframe). This is the real fix for that, not a config tweak:
 * a one-time full decode+re-encode of the whole input, forcing a
 * keyframe every gop_size frames, so a subsequent slice(output_path,
 * ..., gop_size) call finds a keyframe at every desired boundary
 * regardless of what the original source did. Real cost, not free like
 * slice() itself: one full encode pass over the whole video before any
 * chunking/dispatch can start - out_width/out_height (0/0 = keep source
 * resolution) matter here specifically because of that cost: this is an
 * intermediate artifact that gets encoded again per-rendition anyway,
 * so there's no reason to pay full source-resolution encode time when
 * every actual rendition is smaller (a real, measured difference - not
 * hypothetical - at 3.4MB/12s real test footage, encoding at source
 * resolution took 32s; capping at the highest configured rendition size
 * is meaningfully cheaper and loses nothing, since no rendition can
 * exceed this artifact's resolution anyway). libopenh264 in quality mode
 * (bitrate_kbps=0) is used unconditionally - speed matters more here
 * than this specific generation's compression efficiency. */
EMSCRIPTEN_KEEPALIVE
int reencode_for_chunking(const char *input_path, const char *output_path,
                          int gop_size, int out_width, int out_height) {
  return do_transcode(input_path, output_path, out_width, out_height, 0, "mp4", "libopenh264", gop_size);
}

/* Client-side (local, pre-dispatch) helper for a scrubbing-preview sprite
 * sheet: samples up to max_thumbnails frames evenly spaced across the
 * whole input's duration, scales each to thumb_width x thumb_height, and
 * writes it as a standalone MJPEG file at "{output_prefix}NNN.jpg" (NNN
 * zero-padded, 3 digits - same naming convention as slice()'s chunks).
 * Returns the number of thumbnails actually written (can be fewer than
 * max_thumbnails on a very short input), or a negative error code.
 *
 * Decodes the whole input rather than seeking: MEMFS supports fseek, but
 * av_seek_frame() only lands on a keyframe, and this project's own
 * encoder output already has irregular GOP boundaries (see slice()'s doc
 * comment) - seeking wouldn't reliably land near the requested timestamp.
 * A full decode pass costs more than seeking would on a long source, but
 * thumbnailing is a one-time per-source operation, not per-rendition, so
 * paying it once is the same tradeoff reencode_for_chunking() above
 * already makes.
 *
 * AV_PIX_FMT_YUVJ420P (JPEG full-range), not do_transcode()'s
 * AV_PIX_FMT_YUV420P (MPEG range) - a standalone JPEG file conventionally
 * uses full-range JFIF colorspace; encoding at studio range here would
 * make the thumbnails look washed out in a plain image viewer. */
EMSCRIPTEN_KEEPALIVE
int generate_thumbnails(const char *input_path, const char *output_prefix,
                         int max_thumbnails, int thumb_width, int thumb_height) {
  int ret;
  AVFormatContext *in_fmt = NULL;
  if ((ret = avformat_open_input(&in_fmt, input_path, NULL, NULL)) < 0)
    TRANSCODE_FAIL("thumbnails: avformat_open_input", ret);
  if ((ret = avformat_find_stream_info(in_fmt, NULL)) < 0)
    TRANSCODE_FAIL("thumbnails: avformat_find_stream_info", ret);

  int video_idx = -1;
  for (unsigned i = 0; i < in_fmt->nb_streams; i++) {
    if (in_fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) { video_idx = i; break; }
  }
  if (video_idx < 0) { fprintf(stderr, "[thumbnails] no video stream found\n"); return -1000; }
  if (in_fmt->duration <= 0) { fprintf(stderr, "[thumbnails] unknown/zero duration\n"); return -1005; }
  if (max_thumbnails <= 0) { fprintf(stderr, "[thumbnails] max_thumbnails must be > 0\n"); return -1006; }
  AVStream *in_video_stream = in_fmt->streams[video_idx];

  const AVCodec *dec_codec = avcodec_find_decoder(in_video_stream->codecpar->codec_id);
  AVCodecContext *dec_ctx = avcodec_alloc_context3(dec_codec);
  avcodec_parameters_to_context(dec_ctx, in_video_stream->codecpar);
  dec_ctx->thread_count = 1;
  if ((ret = avcodec_open2(dec_ctx, dec_codec, NULL)) < 0)
    TRANSCODE_FAIL("thumbnails: decoder avcodec_open2", ret);

  struct SwsContext *sws = sws_getContext(
      dec_ctx->width, dec_ctx->height, dec_ctx->pix_fmt,
      thumb_width, thumb_height, AV_PIX_FMT_YUVJ420P,
      SWS_BILINEAR, NULL, NULL, NULL);
  if (!sws) { fprintf(stderr, "[thumbnails] sws_getContext failed\n"); return -1001; }

  const AVCodec *enc_codec = avcodec_find_encoder_by_name("mjpeg");
  if (!enc_codec) { fprintf(stderr, "[thumbnails] mjpeg encoder not available in this build\n"); return -1004; }
  AVCodecContext *enc_ctx = avcodec_alloc_context3(enc_codec);
  enc_ctx->width = thumb_width;
  enc_ctx->height = thumb_height;
  enc_ctx->pix_fmt = AV_PIX_FMT_YUVJ420P;
  enc_ctx->time_base = (AVRational){1, 1};
  enc_ctx->thread_count = 1;
  if ((ret = avcodec_open2(enc_ctx, enc_codec, NULL)) < 0)
    TRANSCODE_FAIL("thumbnails: mjpeg encoder avcodec_open2", ret);

  AVPacket *in_pkt = av_packet_alloc();
  AVFrame *frame = av_frame_alloc();
  AVFrame *scaled = av_frame_alloc();
  scaled->format = AV_PIX_FMT_YUVJ420P;
  scaled->width = thumb_width;
  scaled->height = thumb_height;
  av_frame_get_buffer(scaled, 32);
  AVPacket *out_pkt = av_packet_alloc();

  /* Evenly-spaced target timestamps in the source stream's own time_base
   * units (not wall-clock seconds) - avoids a per-frame unit conversion
   * in the hot loop below. */
  int64_t duration_ts = av_rescale_q(in_fmt->duration, AV_TIME_BASE_Q, in_video_stream->time_base);
  int64_t target_step = duration_ts / max_thumbnails;
  int64_t next_target_ts = 0;
  int written = 0;
  char out_path[512];

  while (written < max_thumbnails && av_read_frame(in_fmt, in_pkt) >= 0) {
    if (in_pkt->stream_index != video_idx) { av_packet_unref(in_pkt); continue; }
    ret = avcodec_send_packet(dec_ctx, in_pkt);
    av_packet_unref(in_pkt);
    if (ret < 0) TRANSCODE_FAIL("thumbnails: avcodec_send_packet", ret);

    while (written < max_thumbnails && (ret = avcodec_receive_frame(dec_ctx, frame)) >= 0) {
      /* Real-world files can hand back frames with pts unset - fall back
       * to dts, and failing that just accept whichever frame is current
       * rather than getting stuck (this is a best-effort scrubbing
       * preview, not sync-critical output like do_transcode()'s). */
      int64_t pts = frame->pts != AV_NOPTS_VALUE ? frame->pts
          : (frame->pkt_dts != AV_NOPTS_VALUE ? frame->pkt_dts : next_target_ts);
      if (pts < next_target_ts) continue;

      sws_scale(sws, (const uint8_t *const *)frame->data, frame->linesize,
                0, dec_ctx->height, scaled->data, scaled->linesize);
      scaled->pts = written;

      avcodec_send_frame(enc_ctx, scaled);
      while (avcodec_receive_packet(enc_ctx, out_pkt) >= 0) {
        snprintf(out_path, sizeof(out_path), "%s%03d.jpg", output_prefix, written);
        FILE *f = fopen(out_path, "wb");
        if (f) { fwrite(out_pkt->data, 1, out_pkt->size, f); fclose(f); }
        av_packet_unref(out_pkt);
        written++;
        next_target_ts += target_step;
      }
    }
  }

  sws_freeContext(sws);
  avcodec_free_context(&dec_ctx);
  avcodec_free_context(&enc_ctx);
  avformat_close_input(&in_fmt);
  av_frame_free(&frame);
  av_frame_free(&scaled);
  av_packet_free(&in_pkt);
  av_packet_free(&out_pkt);
  return written;
}

/* Splits input_path into closed-GOP MPEG-TS chunks via stream copy (no
 * decode/encode - cheap) so each chunk is an independently decodable
 * unit of work. Chunks are cut at the first keyframe at or after
 * target_chunk_frames video frames since the current chunk started, so
 * actual chunk length varies with source GOP placement. Original
 * (absolute, not rebased-to-zero) timestamps are preserved in every
 * chunk - simpler than re-stamping, and correct as long as the
 * downstream player/playlist doesn't assume segment-local zero start.
 * Writes chunks to "{output_prefix}NNN.ts" (NNN zero-padded, 3 digits)
 * and returns the chunk count, or a negative error code. If the input
 * has an audio track, it's split at the same chunk boundaries (stream
 * copy, no re-encode) and included in every chunk alongside its video -
 * chunk boundaries are still driven by video keyframes only, audio just
 * rides along into whichever chunk is current when each audio packet is
 * read. Audio arriving before the very first video keyframe (no chunk
 * open yet) is dropped - at most a few hundred ms in practice. */
/* Debug/verification helper: opens path and, if it has an audio track,
 * actually decodes a few frames from it (not just checks for its
 * presence in the stream list - PMT/moov metadata can claim a stream
 * exists without its packets being valid). Returns (has_video<<1 |
 * has_audio); a real (>0) decoded_audio_frames count in the stderr log
 * line is the actual proof, not just the return value. Not part of the
 * work-function API - used to verify audio actually survived stream-copy
 * through slice()/transcode_segment() without needing a full player. */
EMSCRIPTEN_KEEPALIVE
int probe_streams(const char *path) {
  AVFormatContext *fmt = NULL;
  int ret;
  if ((ret = avformat_open_input(&fmt, path, NULL, NULL)) < 0) return ret;
  if ((ret = avformat_find_stream_info(fmt, NULL)) < 0) { avformat_close_input(&fmt); return ret; }

  int has_video = 0, has_audio = 0, audio_idx = -1;
  for (unsigned i = 0; i < fmt->nb_streams; i++) {
    enum AVMediaType t = fmt->streams[i]->codecpar->codec_type;
    if (t == AVMEDIA_TYPE_VIDEO) has_video = 1;
    else if (t == AVMEDIA_TYPE_AUDIO && audio_idx < 0) { has_audio = 1; audio_idx = i; }
  }

  int decoded_audio_frames = 0;
  if (audio_idx >= 0) {
    const AVCodec *dec = avcodec_find_decoder(fmt->streams[audio_idx]->codecpar->codec_id);
    AVCodecContext *actx = dec ? avcodec_alloc_context3(dec) : NULL;
    if (actx) avcodec_parameters_to_context(actx, fmt->streams[audio_idx]->codecpar);
    if (actx && avcodec_open2(actx, dec, NULL) >= 0) {
      AVPacket *pkt = av_packet_alloc();
      AVFrame *frame = av_frame_alloc();
      while (decoded_audio_frames < 5 && av_read_frame(fmt, pkt) >= 0) {
        if (pkt->stream_index == audio_idx && avcodec_send_packet(actx, pkt) >= 0) {
          while (avcodec_receive_frame(actx, frame) >= 0) decoded_audio_frames++;
        }
        av_packet_unref(pkt);
      }
      av_packet_free(&pkt);
      av_frame_free(&frame);
    }
    if (actx) avcodec_free_context(&actx);
  }

  fprintf(stderr, "[probe_streams] '%s': has_video=%d has_audio=%d decoded_audio_frames=%d\n",
          path, has_video, has_audio, decoded_audio_frames);
  avformat_close_input(&fmt);
  return (has_video << 1) | has_audio;
}

#define MAX_CHUNKS 256
static int g_chunk_frame_counts[MAX_CHUNKS];
static double g_source_fps = 0;

/* Frame count and source fps for chunk index `i` from the most recent
 * slice() call - lets the caller compute accurate HLS #EXTINF durations
 * (frame_count / fps) without re-probing each chunk file itself. */
EMSCRIPTEN_KEEPALIVE
int get_chunk_frame_count(int index) {
  if (index < 0 || index >= MAX_CHUNKS) return -1;
  return g_chunk_frame_counts[index];
}

EMSCRIPTEN_KEEPALIVE
double get_source_fps(void) {
  return g_source_fps;
}

EMSCRIPTEN_KEEPALIVE
int slice(const char *input_path, const char *output_prefix, int target_chunk_frames) {
  int ret;

  AVFormatContext *in_fmt = NULL;
  if ((ret = avformat_open_input(&in_fmt, input_path, NULL, NULL)) < 0)
    TRANSCODE_FAIL("slice: avformat_open_input", ret);
  if ((ret = avformat_find_stream_info(in_fmt, NULL)) < 0)
    TRANSCODE_FAIL("slice: avformat_find_stream_info", ret);

  int video_idx = -1, audio_idx = -1;
  for (unsigned i = 0; i < in_fmt->nb_streams; i++) {
    enum AVMediaType t = in_fmt->streams[i]->codecpar->codec_type;
    if (t == AVMEDIA_TYPE_VIDEO && video_idx < 0) video_idx = i;
    else if (t == AVMEDIA_TYPE_AUDIO && audio_idx < 0) audio_idx = i;
  }
  if (video_idx < 0) { fprintf(stderr, "[slice] no video stream found\n"); return -1000; }

  AVStream *in_stream = in_fmt->streams[video_idx];
  AVStream *in_audio_stream = audio_idx >= 0 ? in_fmt->streams[audio_idx] : NULL;
  AVRational fr = in_stream->avg_frame_rate.num ? in_stream->avg_frame_rate : in_stream->r_frame_rate;
  g_source_fps = fr.den ? av_q2d(fr) : 0;

  AVFormatContext *chunk_fmt = NULL;
  AVStream *chunk_stream = NULL;
  AVStream *chunk_audio_stream = NULL;
  int chunk_count = 0;
  int frames_in_chunk = 0;
  char chunk_path[512];
  AVPacket *pkt = av_packet_alloc();

  while (av_read_frame(in_fmt, pkt) >= 0) {
    if (pkt->stream_index == audio_idx) {
      if (chunk_fmt && chunk_audio_stream) {
        AVPacket *out_pkt = av_packet_clone(pkt);
        av_packet_unref(pkt);
        av_packet_rescale_ts(out_pkt, in_audio_stream->time_base, chunk_audio_stream->time_base);
        out_pkt->stream_index = chunk_audio_stream->index;
        av_interleaved_write_frame(chunk_fmt, out_pkt);
        av_packet_free(&out_pkt);
      } else {
        av_packet_unref(pkt);  /* no chunk open yet - drop (see doc comment above) */
      }
      continue;
    }
    if (pkt->stream_index != video_idx) { av_packet_unref(pkt); continue; }

    int is_keyframe = (pkt->flags & AV_PKT_FLAG_KEY) != 0;
    int should_start_new_chunk =
        is_keyframe && (chunk_fmt == NULL || frames_in_chunk >= target_chunk_frames);

    if (should_start_new_chunk) {
      if (chunk_fmt) {
        if (chunk_count - 1 < MAX_CHUNKS) g_chunk_frame_counts[chunk_count - 1] = frames_in_chunk;
        av_write_trailer(chunk_fmt);
        avio_closep(&chunk_fmt->pb);
        avformat_free_context(chunk_fmt);
      }
      if (chunk_count >= MAX_CHUNKS) { fprintf(stderr, "[slice] MAX_CHUNKS exceeded\n"); return -1003; }
      snprintf(chunk_path, sizeof(chunk_path), "%s%03d.ts", output_prefix, chunk_count);
      avformat_alloc_output_context2(&chunk_fmt, NULL, "mpegts", chunk_path);
      chunk_stream = avformat_new_stream(chunk_fmt, NULL);
      avcodec_parameters_copy(chunk_stream->codecpar, in_stream->codecpar);
      chunk_stream->time_base = in_stream->time_base;
      if (in_audio_stream) {
        chunk_audio_stream = avformat_new_stream(chunk_fmt, NULL);
        avcodec_parameters_copy(chunk_audio_stream->codecpar, in_audio_stream->codecpar);
        chunk_audio_stream->codecpar->codec_tag = 0;  /* see do_transcode()'s comment on the same line */
        chunk_audio_stream->time_base = in_audio_stream->time_base;
      }
      if ((ret = avio_open(&chunk_fmt->pb, chunk_path, AVIO_FLAG_WRITE)) < 0)
        TRANSCODE_FAIL("slice: avio_open", ret);
      if ((ret = avformat_write_header(chunk_fmt, NULL)) < 0)
        TRANSCODE_FAIL("slice: avformat_write_header", ret);
      chunk_count++;
      frames_in_chunk = 0;
    }

    AVPacket *out_pkt = av_packet_clone(pkt);
    av_packet_unref(pkt);
    av_packet_rescale_ts(out_pkt, in_stream->time_base, chunk_stream->time_base);
    out_pkt->stream_index = chunk_stream->index;
    av_interleaved_write_frame(chunk_fmt, out_pkt);
    av_packet_free(&out_pkt);
    frames_in_chunk++;
  }

  if (chunk_fmt) {
    if (chunk_count - 1 < MAX_CHUNKS) g_chunk_frame_counts[chunk_count - 1] = frames_in_chunk;
    av_write_trailer(chunk_fmt);
    avio_closep(&chunk_fmt->pb);
    avformat_free_context(chunk_fmt);
  }

  av_packet_free(&pkt);
  avformat_close_input(&in_fmt);
  return chunk_count;
}

/* Test-only: writes a synthetic H.264+AAC/MP4 file (num_frames video
 * frames at 10fps, keyframe every gop_size frames, plus a matching-
 * duration 440Hz mono tone) to the given MEMFS path, so transcode()/
 * slice() have real audio+video input to work against without needing
 * an external test video. Not part of the work-function API. */
EMSCRIPTEN_KEEPALIVE
int generate_test_input(const char *output_path, int num_frames, int gop_size) {
  const AVCodec *codec = avcodec_find_encoder_by_name("libopenh264");
  AVCodecContext *enc_ctx = avcodec_alloc_context3(codec);
  enc_ctx->width = 320;
  enc_ctx->height = 240;
  enc_ctx->time_base = (AVRational){1, 10};
  enc_ctx->framerate = (AVRational){10, 1};
  enc_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
  enc_ctx->thread_count = 1;
  enc_ctx->gop_size = gop_size;
  enc_ctx->profile = AV_PROFILE_H264_MAIN;
  av_opt_set_int(enc_ctx->priv_data, "allow_skip_frames", 1, 0);
  if (avcodec_open2(enc_ctx, codec, NULL) < 0) return -1;

  /* ---- audio encoder: 440Hz mono tone, matching video's duration ---- */
  const AVCodec *audio_codec = avcodec_find_encoder_by_name("aac");
  AVCodecContext *audio_enc_ctx = avcodec_alloc_context3(audio_codec);
  audio_enc_ctx->sample_rate = 8000;
  audio_enc_ctx->ch_layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_MONO;
  audio_enc_ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;  /* what the native "aac" encoder wants */
  audio_enc_ctx->bit_rate = 64000;
  audio_enc_ctx->time_base = (AVRational){1, audio_enc_ctx->sample_rate};
  if (avcodec_open2(audio_enc_ctx, audio_codec, NULL) < 0) return -5;

  AVFormatContext *fmt_ctx = NULL;
  avformat_alloc_output_context2(&fmt_ctx, NULL, "mp4", output_path);
  AVStream *stream = avformat_new_stream(fmt_ctx, NULL);
  avcodec_parameters_from_context(stream->codecpar, enc_ctx);
  stream->time_base = enc_ctx->time_base;
  AVStream *audio_stream = avformat_new_stream(fmt_ctx, NULL);
  avcodec_parameters_from_context(audio_stream->codecpar, audio_enc_ctx);
  audio_stream->time_base = audio_enc_ctx->time_base;
  if (avio_open(&fmt_ctx->pb, output_path, AVIO_FLAG_WRITE) < 0) return -2;
  if (avformat_write_header(fmt_ctx, NULL) < 0) return -3;

  AVFrame *frame = av_frame_alloc();
  frame->format = enc_ctx->pix_fmt;
  frame->width = 320;
  frame->height = 240;
  av_frame_get_buffer(frame, 32);
  AVPacket *pkt = av_packet_alloc();

  for (int i = 0; i < num_frames; i++) {
    av_frame_make_writable(frame);
    for (int y = 0; y < 240; y++)
      for (int x = 0; x < 320; x++)
        frame->data[0][y * frame->linesize[0] + x] = (x + y + i * 3) & 0xFF;
    for (int y = 0; y < 120; y++)
      for (int x = 0; x < 160; x++) {
        frame->data[1][y * frame->linesize[1] + x] = 128 + i;
        frame->data[2][y * frame->linesize[2] + x] = 64 + i;
      }
    frame->pts = i;
    avcodec_send_frame(enc_ctx, frame);
    while (avcodec_receive_packet(enc_ctx, pkt) >= 0) {
      av_packet_rescale_ts(pkt, enc_ctx->time_base, stream->time_base);
      pkt->stream_index = stream->index;
      av_interleaved_write_frame(fmt_ctx, pkt);
    }
  }
  avcodec_send_frame(enc_ctx, NULL);
  while (avcodec_receive_packet(enc_ctx, pkt) >= 0) {
    av_packet_rescale_ts(pkt, enc_ctx->time_base, stream->time_base);
    pkt->stream_index = stream->index;
    av_interleaved_write_frame(fmt_ctx, pkt);
  }

  /* Written as its own pass (not interleaved sample-by-sample with the
   * video loop above) purely for code simplicity - av_interleaved_write_frame
   * buffers and reorders by DTS across streams regardless of submission
   * order, so the muxer still produces correctly interleaved output. */
  AVFrame *aframe = av_frame_alloc();
  aframe->format = audio_enc_ctx->sample_fmt;
  aframe->ch_layout = audio_enc_ctx->ch_layout;
  aframe->sample_rate = audio_enc_ctx->sample_rate;
  aframe->nb_samples = audio_enc_ctx->frame_size;
  av_frame_get_buffer(aframe, 0);

  double duration_seconds = num_frames / 10.0;
  long total_audio_samples = (long)(duration_seconds * audio_enc_ctx->sample_rate);
  long samples_written = 0;
  int64_t audio_pts = 0;
  while (samples_written < total_audio_samples) {
    av_frame_make_writable(aframe);
    float *samples = (float *)aframe->data[0];  /* FLTP mono: one plane */
    for (int i = 0; i < aframe->nb_samples; i++)
      samples[i] = 0.2f * sinf(2.0f * (float)M_PI * 440.0f * (float)(samples_written + i) / audio_enc_ctx->sample_rate);
    aframe->pts = audio_pts;
    avcodec_send_frame(audio_enc_ctx, aframe);
    while (avcodec_receive_packet(audio_enc_ctx, pkt) >= 0) {
      av_packet_rescale_ts(pkt, audio_enc_ctx->time_base, audio_stream->time_base);
      pkt->stream_index = audio_stream->index;
      av_interleaved_write_frame(fmt_ctx, pkt);
    }
    audio_pts += aframe->nb_samples;
    samples_written += aframe->nb_samples;
  }
  avcodec_send_frame(audio_enc_ctx, NULL);
  while (avcodec_receive_packet(audio_enc_ctx, pkt) >= 0) {
    av_packet_rescale_ts(pkt, audio_enc_ctx->time_base, audio_stream->time_base);
    pkt->stream_index = audio_stream->index;
    av_interleaved_write_frame(fmt_ctx, pkt);
  }

  av_write_trailer(fmt_ctx);
  avio_closep(&fmt_ctx->pb);

  avcodec_free_context(&enc_ctx);
  avcodec_free_context(&audio_enc_ctx);
  avformat_free_context(fmt_ctx);
  av_frame_free(&frame);
  av_frame_free(&aframe);
  av_packet_free(&pkt);
  return 0;
}

/* main() is never used as the entry point (see the docs for why) - kept
 * only because Emscripten's runtime init expects a main to be linkable.
 * -sINVOKE_RUN=0 at link time prevents it from auto-running. */
int main(void) { return 0; }
