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
#include <libswresample/swresample.h>
#include <libavutil/opt.h>
#include <libavutil/dict.h>
#include <libavutil/channel_layout.h>
#include <libavutil/imgutils.h>
#include <libavutil/mastering_display_metadata.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersrc.h>
#include <libavfilter/buffersink.h>
#include <emscripten.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

/*
 * A synchronous WASM ccall blocks its worker's JavaScript event loop, so a
 * setInterval cannot keep a long transcode alive. Cross the WASM boundary from
 * the frame loop instead. Embedders opt in by supplying
 * Module.onTranscodeProgress(ratio, processed_frames, total_frames).
 */
EM_JS(void, report_social_progress,
      (double ratio, int processed_frames, int total_frames), {
  var callback = Module['onTranscodeProgress'];
  if (typeof callback === 'function') {
    callback(ratio, processed_frames, total_frames);
  }
});

/* fprintf(stderr, ...) only reaches the caller if the JS wrapper passes
 * explicit print/printErr callbacks - not wired to anything by default. */
#define TRANSCODE_FAIL(step, ret) \
  do { \
    fprintf(stderr, "[transcode] %s failed: %s (%d)\n", step, av_err2str(ret), ret); \
    return ret; \
  } while (0)

/* Multi-audio-track passthrough (Fr/En dual-track and similar) - every
 * input audio stream is copied through, not just the first. Arbitrary
 * cap, not a real-world constraint (real broadcast content rarely
 * exceeds a handful of audio tracks); generously sized so it's never the
 * practical limit. */
#define MAX_AUDIO_STREAMS 8

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
                         int gop_size, int normalize_loudness) {
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

  int video_idx = -1;
  int audio_idx[MAX_AUDIO_STREAMS];
  int audio_count = 0;
  for (unsigned i = 0; i < in_fmt->nb_streams; i++) {
    enum AVMediaType t = in_fmt->streams[i]->codecpar->codec_type;
    if (t == AVMEDIA_TYPE_VIDEO && video_idx < 0) video_idx = i;
    else if (t == AVMEDIA_TYPE_AUDIO && audio_count < MAX_AUDIO_STREAMS) audio_idx[audio_count++] = i;
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
  /* HDR10 passthrough: color_primaries/color_trc/colorspace on
   * dec_ctx are already populated from the input stream's own codecpar
   * (avcodec_parameters_to_context above copies them - real signaled
   * values from the source, e.g. BT.2020/PQ for HDR10, not something
   * this needs to detect itself), so this is a genuine passthrough, not
   * a hardcoded assumption. Static HDR metadata (mastering display
   * luminance/primaries, content light level) is per-frame side data,
   * not an AVCodecContext field - copied frame-by-frame in the decode
   * loop below, not here. Dolby Vision is explicitly out of scope (see
   * the how-to doc) - this only carries HDR10's own static metadata. */
  enc_ctx->color_primaries = dec_ctx->color_primaries;
  enc_ctx->color_trc = dec_ctx->color_trc;
  enc_ctx->colorspace = dec_ctx->colorspace;
  enc_ctx->chroma_sample_location = dec_ctx->chroma_sample_location;

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
  } else if (strcmp(encoder_name, "libx265") == 0) {
    /* Unlike x264 (--disable-thread, a real compile-time toggle) or
     * SVT-AV1 (lp=1, a real single-thread execution mode), x265 has no
     * compile-time single-thread build option at all - its wavefront/
     * frame-level parallelism is threaded by design (see build.sh's own
     * comment on this). "pools=none" disables its internal thread pool
     * entirely at RUNTIME instead - the only lever available - and
     * "frame-threads=1" is real belt-and-suspenders on top of that, not
     * redundant: pools=none stops pthread_create() from ever being
     * called, frame-threads=1 additionally stops x265 from even trying
     * to structure its own encode as multiple frame-parallel lanes in
     * the first place. Both matter here since wasm32 (this project
     * deliberately doesn't use SharedArrayBuffer/real pthreads - see the
     * how-to doc) has no real threading primitive for a stray
     * pthread_create() to fall back on if either were missed. */
    av_opt_set(enc_ctx->priv_data, "x265-params", "pools=none:frame-threads=1", 0);
    av_opt_set(enc_ctx->priv_data, "preset", "veryfast", 0);
    if (bitrate_kbps > 0) {
      enc_ctx->bit_rate = bitrate_kbps * 1000;
    } else {
      av_opt_set(enc_ctx->priv_data, "crf", "28", 0);  /* real CRF, x265's own scale (same 0-51 range as x264, HEVC's extra efficiency means a higher default number still looks comparable) */
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

  /* ---- EBU R128 loudness normalization (first audio track only, when
   * requested) - real decode -> avfilter graph (abuffer -> loudnorm ->
   * abuffersink) -> re-encode, the only place in this file audio
   * actually gets touched rather than stream-copied. Single-pass mode
   * only - the sole mode usable in this per-chunk-dispatched
   * architecture, since loudnorm's two-pass mode needs a full-file
   * analysis pass first, which no individual chunk has access to (see
   * the how-to doc for this tradeoff, and why it means loudness is
   * consistent WITHIN a chunk but not guaranteed consistent ACROSS
   * chunks the way a real whole-file two-pass normalize would be).
   * -23 LUFS is the real EBU R128 broadcast integrated-loudness target
   * (ffmpeg's own loudnorm default is -24 LUFS - close, but a different
   * spec, not used here). Scoped to track 0 only, not every track -
   * keeps this tractable while still being a genuine, working filter
   * graph; any additional tracks still stream-copy untouched below. */
  AVCodecContext *norm_dec_ctx = NULL;
  AVCodecContext *norm_enc_ctx = NULL;
  AVFilterGraph *norm_graph = NULL;
  AVFilterContext *norm_src_ctx = NULL;
  AVFilterContext *norm_sink_ctx = NULL;
  if (normalize_loudness && audio_count > 0) {
    AVStream *norm_in_stream = in_fmt->streams[audio_idx[0]];
    const AVCodec *norm_dec_codec = avcodec_find_decoder(norm_in_stream->codecpar->codec_id);
    norm_dec_ctx = avcodec_alloc_context3(norm_dec_codec);
    avcodec_parameters_to_context(norm_dec_ctx, norm_in_stream->codecpar);
    if ((ret = avcodec_open2(norm_dec_ctx, norm_dec_codec, NULL)) < 0)
      TRANSCODE_FAIL("loudnorm: audio decoder avcodec_open2", ret);

    const AVCodec *norm_enc_codec = avcodec_find_encoder_by_name("aac");
    norm_enc_ctx = avcodec_alloc_context3(norm_enc_codec);
    norm_enc_ctx->sample_rate = norm_dec_ctx->sample_rate;
    norm_enc_ctx->ch_layout = norm_dec_ctx->ch_layout;
    norm_enc_ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;  /* what "aac" wants - also loudnorm's own native format, no resample needed */
    norm_enc_ctx->bit_rate = 64000;
    norm_enc_ctx->time_base = (AVRational){1, norm_enc_ctx->sample_rate};
    if ((ret = avcodec_open2(norm_enc_ctx, norm_enc_codec, NULL)) < 0)
      TRANSCODE_FAIL("loudnorm: audio encoder avcodec_open2", ret);

    norm_graph = avfilter_graph_alloc();
    const AVFilter *abuffer = avfilter_get_by_name("abuffer");
    const AVFilter *loudnorm_filt = avfilter_get_by_name("loudnorm");
    const AVFilter *abuffersink = avfilter_get_by_name("abuffersink");
    if (!abuffer || !loudnorm_filt || !abuffersink) {
      fprintf(stderr, "[transcode] loudnorm: abuffer/loudnorm/abuffersink not available in this build\n");
      return -1006;
    }

    /* Two-step alloc + init, not the one-shot avfilter_graph_create_filter()
     * used everywhere else a filter is created in this graph: that
     * function initializes the filter immediately with whatever args it's
     * given (NULL here), and abuffer's init() requires a valid sample
     * format/rate/layout to succeed - setting them via
     * av_buffersrc_parameters_set() AFTER an args=NULL create call is too
     * late, the filter's already failed to init by then ("Sample format
     * was not set or was invalid", confirmed live). avfilter_graph_alloc_filter()
     * defers init so parameters_set() can run first, matching
     * avfilter_graph_create_filter()'s own doc comment on this exact
     * two-step alternative. */
    norm_src_ctx = avfilter_graph_alloc_filter(norm_graph, abuffer, "src");
    if (!norm_src_ctx) { fprintf(stderr, "[transcode] loudnorm: avfilter_graph_alloc_filter(abuffer) failed\n"); return -1007; }
    AVBufferSrcParameters *src_params = av_buffersrc_parameters_alloc();
    src_params->format = norm_dec_ctx->sample_fmt;
    src_params->time_base = (AVRational){1, norm_dec_ctx->sample_rate};
    src_params->sample_rate = norm_dec_ctx->sample_rate;
    src_params->ch_layout = norm_dec_ctx->ch_layout;
    av_buffersrc_parameters_set(norm_src_ctx, src_params);
    av_freep(&src_params);
    if ((ret = avfilter_init_str(norm_src_ctx, NULL)) < 0)
      TRANSCODE_FAIL("loudnorm: init abuffer", ret);

    AVFilterContext *loudnorm_ctx = NULL;
    if ((ret = avfilter_graph_create_filter(&loudnorm_ctx, loudnorm_filt, "loudnorm", "I=-23", NULL, norm_graph)) < 0)
      TRANSCODE_FAIL("loudnorm: create loudnorm", ret);

    /* Same two-step alloc + init as abuffer above, same reason: sink_fmts
     * is a "not a runtime option" AVOption that can only be set BEFORE
     * init (confirmed live: "Option 'sample_fmts' is not a runtime
     * option and so cannot be set after the object has been
     * initialized" from the one-shot avfilter_graph_create_filter()
     * this replaced). */
    norm_sink_ctx = avfilter_graph_alloc_filter(norm_graph, abuffersink, "sink");
    if (!norm_sink_ctx) { fprintf(stderr, "[transcode] loudnorm: avfilter_graph_alloc_filter(abuffersink) failed\n"); return -1008; }
    static const enum AVSampleFormat sink_fmts[] = { AV_SAMPLE_FMT_FLTP, AV_SAMPLE_FMT_NONE };
    if ((ret = av_opt_set_int_list(norm_sink_ctx, "sample_fmts", sink_fmts, AV_SAMPLE_FMT_NONE, AV_OPT_SEARCH_CHILDREN)) < 0)
      TRANSCODE_FAIL("loudnorm: set sink sample_fmts", ret);
    if ((ret = avfilter_init_str(norm_sink_ctx, NULL)) < 0)
      TRANSCODE_FAIL("loudnorm: init abuffersink", ret);
    /* loudnorm doesn't preserve the input's frame boundaries - it
     * buffers/analyzes audio internally and emits frames in whatever
     * sizes IT finds convenient (confirmed live: 19200, 2304, even
     * 556800 samples in one run), not aligned to what the AAC encoder
     * requires (a fixed frame_size, 1024 samples here - "nb_samples
     * (19200) > frame_size (1024)" from avcodec_send_frame() otherwise).
     * This tells the sink to re-chunk into exactly frame_size samples
     * per pulled frame before this code ever sees them, instead of
     * needing to buffer/re-slice manually here. */
    av_buffersink_set_frame_size(norm_sink_ctx, norm_enc_ctx->frame_size);

    if ((ret = avfilter_link(norm_src_ctx, 0, loudnorm_ctx, 0)) < 0)
      TRANSCODE_FAIL("loudnorm: link src->loudnorm", ret);
    if ((ret = avfilter_link(loudnorm_ctx, 0, norm_sink_ctx, 0)) < 0)
      TRANSCODE_FAIL("loudnorm: link loudnorm->sink", ret);
    if ((ret = avfilter_graph_config(norm_graph, NULL)) < 0)
      TRANSCODE_FAIL("loudnorm: graph config", ret);
  }

  AVFormatContext *out_fmt = NULL;
  avformat_alloc_output_context2(&out_fmt, NULL, container, output_path);
  AVStream *out_stream = avformat_new_stream(out_fmt, NULL);
  avcodec_parameters_from_context(out_stream->codecpar, enc_ctx);
  out_stream->time_base = enc_ctx->time_base;
  /* Audio is passed through untouched (no decode/re-encode) - rendition
   * differences (resolution/bitrate) only apply to video, so there's
   * nothing for a per-rendition audio re-encode to actually change,
   * UNLESS loudness normalization is on, in which case track 0 gets a
   * real re-encode instead (see above). Every input audio stream gets
   * its own output stream, not just the first - a Fr/En dual-track
   * source keeps both tracks all the way through, the same way a real
   * multi-language broadcast pipeline would need to. */
  AVStream *out_audio_streams[MAX_AUDIO_STREAMS] = {0};
  for (int a = 0; a < audio_count; a++) {
    out_audio_streams[a] = avformat_new_stream(out_fmt, NULL);
    if (a == 0 && norm_enc_ctx) {
      avcodec_parameters_from_context(out_audio_streams[a]->codecpar, norm_enc_ctx);
      out_audio_streams[a]->time_base = norm_enc_ctx->time_base;
      continue;
    }
    AVStream *in_audio_stream = in_fmt->streams[audio_idx[a]];
    avcodec_parameters_copy(out_audio_streams[a]->codecpar, in_audio_stream->codecpar);
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
    out_audio_streams[a]->codecpar->codec_tag = 0;
    out_audio_streams[a]->time_base = in_audio_stream->time_base;
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
  AVFrame *norm_frame = norm_dec_ctx ? av_frame_alloc() : NULL;
  AVFrame *norm_filtered = norm_dec_ctx ? av_frame_alloc() : NULL;
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
    int audio_match = -1;
    for (int a = 0; a < audio_count; a++) {
      if (in_pkt->stream_index == audio_idx[a]) { audio_match = a; break; }
    }
    if (audio_match == 0 && norm_dec_ctx) {
      /* Real decode -> filter -> re-encode for the normalized track,
       * instead of the straight rescale+write every other audio path in
       * this file uses. */
      ret = avcodec_send_packet(norm_dec_ctx, in_pkt);
      av_packet_unref(in_pkt);
      if (ret < 0) TRANSCODE_FAIL("loudnorm: avcodec_send_packet", ret);
      while (avcodec_receive_frame(norm_dec_ctx, norm_frame) >= 0) {
        (void)av_buffersrc_add_frame(norm_src_ctx, norm_frame);
        while (av_buffersink_get_frame(norm_sink_ctx, norm_filtered) >= 0) {
          avcodec_send_frame(norm_enc_ctx, norm_filtered);
          av_frame_unref(norm_filtered);
          while (avcodec_receive_packet(norm_enc_ctx, out_pkt) >= 0) {
            av_packet_rescale_ts(out_pkt, norm_enc_ctx->time_base, out_audio_streams[0]->time_base);
            out_pkt->stream_index = out_audio_streams[0]->index;
            av_interleaved_write_frame(out_fmt, out_pkt);
          }
        }
      }
      continue;
    }
    if (audio_match >= 0) {
      AVStream *in_audio_stream = in_fmt->streams[audio_idx[audio_match]];
      av_packet_rescale_ts(in_pkt, in_audio_stream->time_base, out_audio_streams[audio_match]->time_base);
      in_pkt->stream_index = out_audio_streams[audio_match]->index;
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

      /* HDR10 static metadata (mastering display luminance/primaries,
       * content light level) is per-frame side data, not an
       * AVCodecContext field - sws_scale() above only touches pixel
       * data, so it has to be copied across separately, per frame, here.
       * Removed first: av_frame_new_side_data()-family calls append
       * rather than replace, and `scaled` is one persistent frame reused
       * across every iteration of this loop (not freed/reallocated per
       * frame), so without this a multi-frame source would accumulate
       * duplicate side-data entries instead of one authoritative one. */
      av_frame_remove_side_data(scaled, AV_FRAME_DATA_MASTERING_DISPLAY_METADATA);
      const AVFrameSideData *mdm_in = av_frame_get_side_data(frame, AV_FRAME_DATA_MASTERING_DISPLAY_METADATA);
      if (mdm_in) {
        AVMasteringDisplayMetadata *mdm_out = av_mastering_display_metadata_create_side_data(scaled);
        if (mdm_out) memcpy(mdm_out, mdm_in->data, sizeof(*mdm_out));
      }
      av_frame_remove_side_data(scaled, AV_FRAME_DATA_CONTENT_LIGHT_LEVEL);
      const AVFrameSideData *cll_in = av_frame_get_side_data(frame, AV_FRAME_DATA_CONTENT_LIGHT_LEVEL);
      if (cll_in) {
        AVContentLightMetadata *cll_out = av_content_light_metadata_create_side_data(scaled);
        if (cll_out) memcpy(cll_out, cll_in->data, sizeof(*cll_out));
      }

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

  /* Flush the normalized-audio chain too, same drain pattern as the
   * video encoder above: NULL packet through the decoder to release any
   * buffered frames, NULL frame through the filter graph to signal EOF
   * and release anything loudnorm is still holding, NULL frame through
   * the encoder to flush its own internal buffering. */
  if (norm_dec_ctx) {
    avcodec_send_packet(norm_dec_ctx, NULL);
    while (avcodec_receive_frame(norm_dec_ctx, norm_frame) >= 0) {
      (void)av_buffersrc_add_frame(norm_src_ctx, norm_frame);
    }
    (void)av_buffersrc_add_frame(norm_src_ctx, NULL);
    while (av_buffersink_get_frame(norm_sink_ctx, norm_filtered) >= 0) {
      avcodec_send_frame(norm_enc_ctx, norm_filtered);
      av_frame_unref(norm_filtered);
      while (avcodec_receive_packet(norm_enc_ctx, out_pkt) >= 0) {
        av_packet_rescale_ts(out_pkt, norm_enc_ctx->time_base, out_audio_streams[0]->time_base);
        out_pkt->stream_index = out_audio_streams[0]->index;
        av_interleaved_write_frame(out_fmt, out_pkt);
      }
    }
    avcodec_send_frame(norm_enc_ctx, NULL);
    while (avcodec_receive_packet(norm_enc_ctx, out_pkt) >= 0) {
      av_packet_rescale_ts(out_pkt, norm_enc_ctx->time_base, out_audio_streams[0]->time_base);
      out_pkt->stream_index = out_audio_streams[0]->index;
      av_interleaved_write_frame(out_fmt, out_pkt);
    }
  }

  av_write_trailer(out_fmt);
  avio_closep(&out_fmt->pb);

  sws_freeContext(sws);
  avcodec_free_context(&dec_ctx);
  avcodec_free_context(&enc_ctx);
  if (norm_dec_ctx) avcodec_free_context(&norm_dec_ctx);
  if (norm_enc_ctx) avcodec_free_context(&norm_enc_ctx);
  if (norm_graph) avfilter_graph_free(&norm_graph);  /* also frees norm_src_ctx/norm_sink_ctx and the loudnorm filter context within it */
  if (norm_frame) av_frame_free(&norm_frame);
  if (norm_filtered) av_frame_free(&norm_filtered);
  avformat_close_input(&in_fmt);
  avformat_free_context(out_fmt);
  av_frame_free(&frame);
  av_frame_free(&scaled);
  av_packet_free(&in_pkt);
  av_packet_free(&out_pkt);
  return 0;
}

/* Whole-file transcode: standalone MP4 in, standalone MP4 out.
 * encoder_name: "libopenh264" or "libx264" (see do_transcode above).
 * normalize_loudness: EBU R128 single-pass loudness normalization on
 * the first audio track (see do_transcode's own doc comment on that
 * tradeoff) - 0/omitted keeps the existing pure-stream-copy behavior. */
EMSCRIPTEN_KEEPALIVE
int transcode(const char *input_path, const char *output_path,
              int out_width, int out_height, int bitrate_kbps,
              const char *encoder_name, int normalize_loudness) {
  return do_transcode(input_path, output_path, out_width, out_height, bitrate_kbps, "mp4", encoder_name, 0, normalize_loudness);
}

/* Chunk transcode: one closed-GOP MPEG-TS chunk (see slice() below) in,
 * one HLS-ready MPEG-TS segment at the requested rendition out. */
EMSCRIPTEN_KEEPALIVE
int transcode_segment(const char *input_path, const char *output_path,
                       int out_width, int out_height, int bitrate_kbps,
                       const char *encoder_name, int normalize_loudness) {
  return do_transcode(input_path, output_path, out_width, out_height, bitrate_kbps, "mpegts", encoder_name, 0, normalize_loudness);
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
  return do_transcode(input_path, output_path, out_width, out_height, 0, "mp4", "libopenh264", gop_size, 0);
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
static int g_last_probe_audio_tracks = 0;
static int g_last_probe_min_decoded_audio_frames = 0;

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

  int has_video = 0, has_audio = 0;
  int audio_idx[MAX_AUDIO_STREAMS];
  int audio_count = 0;
  for (unsigned i = 0; i < fmt->nb_streams; i++) {
    enum AVMediaType t = fmt->streams[i]->codecpar->codec_type;
    if (t == AVMEDIA_TYPE_VIDEO) has_video = 1;
    else if (t == AVMEDIA_TYPE_AUDIO && audio_count < MAX_AUDIO_STREAMS) { has_audio = 1; audio_idx[audio_count++] = i; }
  }

  /* Decodes a few frames from EVERY audio track, not just the first -
   * verifies multi-track passthrough actually survived slice()/
   * transcode_segment(), the same way this already verified single-track
   * passthrough before multi-track support existed. */
  int decoded_audio_frames[MAX_AUDIO_STREAMS] = {0};
  if (audio_count > 0) {
    AVCodecContext *actx[MAX_AUDIO_STREAMS] = {0};
    for (int a = 0; a < audio_count; a++) {
      const AVCodec *dec = avcodec_find_decoder(fmt->streams[audio_idx[a]]->codecpar->codec_id);
      actx[a] = dec ? avcodec_alloc_context3(dec) : NULL;
      if (actx[a]) avcodec_parameters_to_context(actx[a], fmt->streams[audio_idx[a]]->codecpar);
      if (actx[a] && avcodec_open2(actx[a], dec, NULL) < 0) { avcodec_free_context(&actx[a]); actx[a] = NULL; }
    }
    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    int total_decoded = 0, total_target = audio_count * 5;
    while (total_decoded < total_target && av_read_frame(fmt, pkt) >= 0) {
      for (int a = 0; a < audio_count; a++) {
        if (pkt->stream_index == audio_idx[a] && decoded_audio_frames[a] < 5 && actx[a]
            && avcodec_send_packet(actx[a], pkt) >= 0) {
          while (avcodec_receive_frame(actx[a], frame) >= 0) { decoded_audio_frames[a]++; total_decoded++; }
        }
      }
      av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    av_frame_free(&frame);
    for (int a = 0; a < audio_count; a++) if (actx[a]) avcodec_free_context(&actx[a]);
  }

  fprintf(stderr, "[probe_streams] '%s': has_video=%d has_audio=%d audio_tracks=%d decoded_audio_frames=[",
          path, has_video, has_audio, audio_count);
  for (int a = 0; a < audio_count; a++) fprintf(stderr, "%s%d", a ? "," : "", decoded_audio_frames[a]);
  fprintf(stderr, "]\n");

  /* Exposed via get_last_probe_audio_tracks()/get_last_probe_min_decoded_audio_frames()
   * below so a JS caller can assert on multi-track passthrough
   * programmatically, not just by eyeballing the stderr line above. */
  g_last_probe_audio_tracks = audio_count;
  g_last_probe_min_decoded_audio_frames = audio_count > 0 ? decoded_audio_frames[0] : 0;
  for (int a = 1; a < audio_count; a++) {
    if (decoded_audio_frames[a] < g_last_probe_min_decoded_audio_frames) {
      g_last_probe_min_decoded_audio_frames = decoded_audio_frames[a];
    }
  }

  avformat_close_input(&fmt);
  return (has_video << 1) | has_audio;
}

/* audio_tracks from the most recent probe_streams() call, and the
 * MINIMUM decoded-frame count across all of that call's tracks (not
 * just the first) - a real multi-track passthrough assertion needs
 * every track to have actually decoded something, not just the highest
 * one. */
EMSCRIPTEN_KEEPALIVE
int get_last_probe_audio_tracks(void) { return g_last_probe_audio_tracks; }
EMSCRIPTEN_KEEPALIVE
int get_last_probe_min_decoded_audio_frames(void) { return g_last_probe_min_decoded_audio_frames; }

/* Debug/verification helper for HDR10 passthrough: reports the video
 * stream's signaled color metadata (color_primaries/color_trc/
 * color_space - container/codecpar-level, e.g. AVCOL_PRI_BT2020=9/
 * AVCOL_TRC_SMPTE2084=16 for HDR10) plus whether the first decoded frame
 * carries HDR10 static side data (mastering display metadata / content
 * light level) - same "actually decode and check" spirit as
 * probe_streams() above, not just a metadata-presence check. Not part
 * of the work-function API. Returns color_primaries (>=0) on success, a
 * negative ffmpeg error code on failure - the real proof is in the
 * stderr log line, same pattern as probe_streams(). */
EMSCRIPTEN_KEEPALIVE
int probe_hdr(const char *path) {
  AVFormatContext *fmt = NULL;
  int ret;
  if ((ret = avformat_open_input(&fmt, path, NULL, NULL)) < 0) return ret;
  if ((ret = avformat_find_stream_info(fmt, NULL)) < 0) { avformat_close_input(&fmt); return ret; }

  int video_idx = -1;
  for (unsigned i = 0; i < fmt->nb_streams; i++) {
    if (fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) { video_idx = i; break; }
  }
  if (video_idx < 0) { avformat_close_input(&fmt); return -1000; }
  AVCodecParameters *cp = fmt->streams[video_idx]->codecpar;

  int has_mdm = 0, has_cll = 0;
  const AVCodec *dec = avcodec_find_decoder(cp->codec_id);
  AVCodecContext *dctx = dec ? avcodec_alloc_context3(dec) : NULL;
  if (dctx) avcodec_parameters_to_context(dctx, cp);
  if (dctx && avcodec_open2(dctx, dec, NULL) >= 0) {
    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    int got_frame = 0;
    while (!got_frame && av_read_frame(fmt, pkt) >= 0) {
      if (pkt->stream_index == video_idx && avcodec_send_packet(dctx, pkt) >= 0
          && avcodec_receive_frame(dctx, frame) >= 0) {
        got_frame = 1;
        has_mdm = av_frame_get_side_data(frame, AV_FRAME_DATA_MASTERING_DISPLAY_METADATA) != NULL;
        has_cll = av_frame_get_side_data(frame, AV_FRAME_DATA_CONTENT_LIGHT_LEVEL) != NULL;
      }
      av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    av_frame_free(&frame);
  }
  if (dctx) avcodec_free_context(&dctx);

  fprintf(stderr, "[probe_hdr] '%s': color_primaries=%d color_trc=%d color_space=%d "
          "has_mastering_display_metadata=%d has_content_light_level=%d\n",
          path, cp->color_primaries, cp->color_trc, cp->color_space, has_mdm, has_cll);

  /* Captured before closing: avformat_close_input() frees fmt and every
   * AVStream (and its codecpar) hanging off it, so `cp` is a dangling
   * pointer the instant it returns - reading cp->color_primaries in the
   * return statement below (i.e. after close) would be a genuine
   * use-after-free, not just stale data (confirmed live: the fprintf
   * above, which reads it BEFORE close, correctly showed 9/BT.2020, but
   * the naive `return cp->color_primaries;` after close read back 2/
   * UNSPECIFIED instead - undefined behavior that happened to look like
   * a real, plausible-but-wrong value instead of an obvious crash). */
  int result_color_primaries = cp->color_primaries;
  avformat_close_input(&fmt);
  return result_color_primaries;
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

  int video_idx = -1;
  int audio_idx[MAX_AUDIO_STREAMS];
  int audio_count = 0;
  for (unsigned i = 0; i < in_fmt->nb_streams; i++) {
    enum AVMediaType t = in_fmt->streams[i]->codecpar->codec_type;
    if (t == AVMEDIA_TYPE_VIDEO && video_idx < 0) video_idx = i;
    else if (t == AVMEDIA_TYPE_AUDIO && audio_count < MAX_AUDIO_STREAMS) audio_idx[audio_count++] = i;
  }
  if (video_idx < 0) { fprintf(stderr, "[slice] no video stream found\n"); return -1000; }

  AVStream *in_stream = in_fmt->streams[video_idx];
  AVRational fr = in_stream->avg_frame_rate.num ? in_stream->avg_frame_rate : in_stream->r_frame_rate;
  g_source_fps = fr.den ? av_q2d(fr) : 0;

  AVFormatContext *chunk_fmt = NULL;
  AVStream *chunk_stream = NULL;
  AVStream *chunk_audio_streams[MAX_AUDIO_STREAMS] = {0};
  int chunk_count = 0;
  int frames_in_chunk = 0;
  char chunk_path[512];
  AVPacket *pkt = av_packet_alloc();

  while (av_read_frame(in_fmt, pkt) >= 0) {
    int audio_match = -1;
    for (int a = 0; a < audio_count; a++) {
      if (pkt->stream_index == audio_idx[a]) { audio_match = a; break; }
    }
    if (audio_match >= 0) {
      if (chunk_fmt && chunk_audio_streams[audio_match]) {
        AVStream *in_audio_stream = in_fmt->streams[audio_idx[audio_match]];
        AVPacket *out_pkt = av_packet_clone(pkt);
        av_packet_unref(pkt);
        av_packet_rescale_ts(out_pkt, in_audio_stream->time_base, chunk_audio_streams[audio_match]->time_base);
        out_pkt->stream_index = chunk_audio_streams[audio_match]->index;
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
      for (int a = 0; a < audio_count; a++) {
        AVStream *in_audio_stream = in_fmt->streams[audio_idx[a]];
        chunk_audio_streams[a] = avformat_new_stream(chunk_fmt, NULL);
        avcodec_parameters_copy(chunk_audio_streams[a]->codecpar, in_audio_stream->codecpar);
        chunk_audio_streams[a]->codecpar->codec_tag = 0;  /* see do_transcode()'s comment on the same line */
        chunk_audio_streams[a]->time_base = in_audio_stream->time_base;
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

/* Encodes and writes one AAC mono tone audio track as its own pass (see
 * generate_test_input()'s own comment on why writing tracks as separate
 * passes after the video loop is fine - av_interleaved_write_frame
 * reorders by DTS regardless of submission order). freq_hz distinguishes
 * multiple generated tracks from each other (e.g. 440Hz/880Hz standing
 * in for distinct language tracks in a synthetic Fr/En-style dual-track
 * test clip) - real content would carry actually different audio, this
 * just needs to be a genuinely separate, independently-verifiable
 * stream, which a different frequency trivially gives it. */
static void write_tone_track(AVFormatContext *fmt_ctx, AVCodecContext *audio_enc_ctx,
                              AVStream *audio_stream, AVPacket *pkt,
                              double duration_seconds, double freq_hz) {
  AVFrame *aframe = av_frame_alloc();
  aframe->format = audio_enc_ctx->sample_fmt;
  aframe->ch_layout = audio_enc_ctx->ch_layout;
  aframe->sample_rate = audio_enc_ctx->sample_rate;
  aframe->nb_samples = audio_enc_ctx->frame_size;
  av_frame_get_buffer(aframe, 0);

  long total_audio_samples = (long)(duration_seconds * audio_enc_ctx->sample_rate);
  long samples_written = 0;
  int64_t audio_pts = 0;
  while (samples_written < total_audio_samples) {
    av_frame_make_writable(aframe);
    float *samples = (float *)aframe->data[0];  /* FLTP mono: one plane */
    for (int i = 0; i < aframe->nb_samples; i++)
      samples[i] = 0.2f * sinf(2.0f * (float)M_PI * (float)freq_hz * (float)(samples_written + i) / audio_enc_ctx->sample_rate);
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
  av_frame_free(&aframe);
}

/* Test-only: writes a synthetic H.264+AAC/MP4 file (num_frames video
 * frames at 10fps, keyframe every gop_size frames, plus a matching-
 * duration 440Hz mono tone, and a second 880Hz track too if
 * extra_audio_track is set) to the given MEMFS path, so transcode()/
 * slice() have real audio+video input to work against without needing
 * an external test video. Not part of the work-function API.
 * width/height (0/0 = keep the original 320x240 default) must both be
 * even - YUV420P subsamples chroma by 2 in each dimension, and the
 * pixel-fill loop below divides both by 2 for the chroma planes without
 * rounding. Not validated here since this is test-only code, not a
 * work-function entry point real uploads flow through.
 * hdr: tags every frame BT.2020/PQ color info plus real HDR10 static
 * metadata (mastering display primaries/luminance, content light level)
 * - the exact reference values x265's own docs use for HDR10 examples,
 * not made up - so do_transcode()'s HDR10 passthrough has something
 * genuine to prove itself against. */
EMSCRIPTEN_KEEPALIVE
int generate_test_input(const char *output_path, int num_frames, int gop_size, int width, int height,
                         int extra_audio_track, int hdr) {
  if (width <= 0) width = 320;
  if (height <= 0) height = 240;
  const AVCodec *codec = avcodec_find_encoder_by_name("libopenh264");
  AVCodecContext *enc_ctx = avcodec_alloc_context3(codec);
  enc_ctx->width = width;
  enc_ctx->height = height;
  if (hdr) {
    enc_ctx->color_primaries = AVCOL_PRI_BT2020;
    enc_ctx->color_trc = AVCOL_TRC_SMPTE2084;  /* PQ */
    enc_ctx->colorspace = AVCOL_SPC_BT2020_NCL;
  }
  enc_ctx->time_base = (AVRational){1, 10};
  enc_ctx->framerate = (AVRational){10, 1};
  enc_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
  enc_ctx->thread_count = 1;
  enc_ctx->gop_size = gop_size;
  enc_ctx->profile = AV_PROFILE_H264_MAIN;
  av_opt_set_int(enc_ctx->priv_data, "allow_skip_frames", 1, 0);
  if (avcodec_open2(enc_ctx, codec, NULL) < 0) return -1;

  /* ---- audio encoder(s): 440Hz mono tone (track 1), + 880Hz (track 2)
   * if extra_audio_track is set - both matching the video's duration.
   * Separate AVCodecContext per track, same as separate AVStream per
   * track - encoder state (frame_size, internal buffering) isn't
   * shareable across independent output streams. */
  const AVCodec *audio_codec = avcodec_find_encoder_by_name("aac");
  AVCodecContext *audio_enc_ctx = avcodec_alloc_context3(audio_codec);
  audio_enc_ctx->sample_rate = 8000;
  audio_enc_ctx->ch_layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_MONO;
  audio_enc_ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;  /* what the native "aac" encoder wants */
  audio_enc_ctx->bit_rate = 64000;
  audio_enc_ctx->time_base = (AVRational){1, audio_enc_ctx->sample_rate};
  if (avcodec_open2(audio_enc_ctx, audio_codec, NULL) < 0) return -5;

  AVCodecContext *audio_enc_ctx2 = NULL;
  if (extra_audio_track) {
    audio_enc_ctx2 = avcodec_alloc_context3(audio_codec);
    audio_enc_ctx2->sample_rate = 8000;
    audio_enc_ctx2->ch_layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_MONO;
    audio_enc_ctx2->sample_fmt = AV_SAMPLE_FMT_FLTP;
    audio_enc_ctx2->bit_rate = 64000;
    audio_enc_ctx2->time_base = (AVRational){1, audio_enc_ctx2->sample_rate};
    if (avcodec_open2(audio_enc_ctx2, audio_codec, NULL) < 0) return -5;
  }

  AVFormatContext *fmt_ctx = NULL;
  avformat_alloc_output_context2(&fmt_ctx, NULL, "mp4", output_path);
  AVStream *stream = avformat_new_stream(fmt_ctx, NULL);
  avcodec_parameters_from_context(stream->codecpar, enc_ctx);
  stream->time_base = enc_ctx->time_base;
  AVStream *audio_stream = avformat_new_stream(fmt_ctx, NULL);
  avcodec_parameters_from_context(audio_stream->codecpar, audio_enc_ctx);
  audio_stream->time_base = audio_enc_ctx->time_base;
  AVStream *audio_stream2 = NULL;
  if (extra_audio_track) {
    audio_stream2 = avformat_new_stream(fmt_ctx, NULL);
    avcodec_parameters_from_context(audio_stream2->codecpar, audio_enc_ctx2);
    audio_stream2->time_base = audio_enc_ctx2->time_base;
  }
  if (avio_open(&fmt_ctx->pb, output_path, AVIO_FLAG_WRITE) < 0) return -2;
  if (avformat_write_header(fmt_ctx, NULL) < 0) return -3;

  AVFrame *frame = av_frame_alloc();
  frame->format = enc_ctx->pix_fmt;
  frame->width = width;
  frame->height = height;
  av_frame_get_buffer(frame, 32);
  AVPacket *pkt = av_packet_alloc();

  for (int i = 0; i < num_frames; i++) {
    av_frame_make_writable(frame);
    for (int y = 0; y < height; y++)
      for (int x = 0; x < width; x++)
        frame->data[0][y * frame->linesize[0] + x] = (x + y + i * 3) & 0xFF;
    for (int y = 0; y < height / 2; y++)
      for (int x = 0; x < width / 2; x++) {
        frame->data[1][y * frame->linesize[1] + x] = 128 + i;
        frame->data[2][y * frame->linesize[2] + x] = 64 + i;
      }
    frame->pts = i;

    if (hdr) {
      /* Reference HDR10 mastering-display values (BT.2020 P3-D65-style
       * primaries, 1000 cd/m^2 max / 0.0001 cd/m^2 min mastering display
       * luminance) - the same numbers x265's own HDR10 documentation
       * uses as its worked example, not arbitrary. Removed first: see
       * do_transcode()'s identical comment on why (this frame object is
       * reused across every iteration of this loop). */
      av_frame_remove_side_data(frame, AV_FRAME_DATA_MASTERING_DISPLAY_METADATA);
      AVMasteringDisplayMetadata *mdm = av_mastering_display_metadata_create_side_data(frame);
      if (mdm) {
        mdm->display_primaries[0][0] = av_make_q(35400, 50000);  /* R x */
        mdm->display_primaries[0][1] = av_make_q(14600, 50000);  /* R y */
        mdm->display_primaries[1][0] = av_make_q(8500, 50000);   /* G x */
        mdm->display_primaries[1][1] = av_make_q(39850, 50000);  /* G y */
        mdm->display_primaries[2][0] = av_make_q(6550, 50000);   /* B x */
        mdm->display_primaries[2][1] = av_make_q(2300, 50000);   /* B y */
        mdm->white_point[0] = av_make_q(15635, 50000);
        mdm->white_point[1] = av_make_q(16450, 50000);
        mdm->min_luminance = av_make_q(1, 10000);
        mdm->max_luminance = av_make_q(10000000, 10000);  /* 1000 cd/m^2 */
        mdm->has_primaries = 1;
        mdm->has_luminance = 1;
      }
      av_frame_remove_side_data(frame, AV_FRAME_DATA_CONTENT_LIGHT_LEVEL);
      AVContentLightMetadata *cll = av_content_light_metadata_create_side_data(frame);
      if (cll) { cll->MaxCLL = 1000; cll->MaxFALL = 400; }
    }

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

  /* Written as its own pass per track (not interleaved sample-by-sample
   * with the video loop above) purely for code simplicity -
   * av_interleaved_write_frame buffers and reorders by DTS across
   * streams regardless of submission order, so the muxer still produces
   * correctly interleaved output. */
  double duration_seconds = num_frames / 10.0;
  write_tone_track(fmt_ctx, audio_enc_ctx, audio_stream, pkt, duration_seconds, 440.0);
  if (extra_audio_track) {
    write_tone_track(fmt_ctx, audio_enc_ctx2, audio_stream2, pkt, duration_seconds, 880.0);
  }

  av_write_trailer(fmt_ctx);
  avio_closep(&fmt_ctx->pb);

  avcodec_free_context(&enc_ctx);
  avcodec_free_context(&audio_enc_ctx);
  if (audio_enc_ctx2) avcodec_free_context(&audio_enc_ctx2);
  avformat_free_context(fmt_ctx);
  av_frame_free(&frame);
  av_packet_free(&pkt);
  return 0;
}

/* =====================================================================
 * Social / MediaRecorder path (xFrame app)
 * frame_mode: 0=stretch, 1=cover/crop, 2=contain/pad
 * Always re-encodes first audio track to AAC-LC (Opus → AAC for WebM).
 * ===================================================================== */

static void evenize(int *v) {
  if (*v < 2) *v = 2;
  *v &= ~1;
}

static void compute_cover_crop(int src_w, int src_h, int dst_w, int dst_h,
                               int *crop_x, int *crop_y, int *crop_w, int *crop_h) {
  double src_ar = (double)src_w / (double)src_h;
  double dst_ar = (double)dst_w / (double)dst_h;
  if (src_ar > dst_ar) {
    *crop_h = src_h;
    *crop_w = (int)(src_h * dst_ar);
    evenize(crop_w);
    *crop_x = ((src_w - *crop_w) / 2) & ~1;
    *crop_y = 0;
  } else {
    *crop_w = src_w;
    *crop_h = (int)(src_w / dst_ar);
    evenize(crop_h);
    *crop_x = 0;
    *crop_y = ((src_h - *crop_h) / 2) & ~1;
  }
  if (*crop_w < 2) *crop_w = 2;
  if (*crop_h < 2) *crop_h = 2;
}

static void compute_contain_fit(int src_w, int src_h, int dst_w, int dst_h,
                                int *fit_w, int *fit_h, int *pad_x, int *pad_y) {
  double scale = fmin((double)dst_w / (double)src_w, (double)dst_h / (double)src_h);
  *fit_w = (int)(src_w * scale);
  *fit_h = (int)(src_h * scale);
  evenize(fit_w);
  evenize(fit_h);
  if (*fit_w > dst_w) *fit_w = dst_w & ~1;
  if (*fit_h > dst_h) *fit_h = dst_h & ~1;
  *pad_x = ((dst_w - *fit_w) / 2) & ~1;
  *pad_y = ((dst_h - *fit_h) / 2) & ~1;
}

/* Keyframe-aligned stream-copy slicer. Muxer/extension keep the source
 * codec (WebM for VP8/VP9, MP4 for VP9 or H.264). MPEG-TS (`slice()`)
 * cannot carry VP9 as video — it becomes a private data stream. */
static int slice_stream_copy(const char *input_path, const char *output_prefix,
                             int target_chunk_frames,
                             const char *muxer_name, const char *file_ext) {
  int ret;
  AVFormatContext *in_fmt = NULL;
  if ((ret = avformat_open_input(&in_fmt, input_path, NULL, NULL)) < 0)
    TRANSCODE_FAIL("slice_copy: avformat_open_input", ret);
  if ((ret = avformat_find_stream_info(in_fmt, NULL)) < 0)
    TRANSCODE_FAIL("slice_copy: avformat_find_stream_info", ret);

  int video_idx = -1;
  int audio_idx[MAX_AUDIO_STREAMS];
  int audio_count = 0;
  for (unsigned i = 0; i < in_fmt->nb_streams; i++) {
    enum AVMediaType t = in_fmt->streams[i]->codecpar->codec_type;
    if (t == AVMEDIA_TYPE_VIDEO && video_idx < 0) video_idx = i;
    else if (t == AVMEDIA_TYPE_AUDIO && audio_count < MAX_AUDIO_STREAMS) audio_idx[audio_count++] = i;
  }
  if (video_idx < 0) { fprintf(stderr, "[slice_copy] no video stream\n"); return -1000; }

  AVStream *in_stream = in_fmt->streams[video_idx];
  AVRational fr = in_stream->avg_frame_rate.num ? in_stream->avg_frame_rate : in_stream->r_frame_rate;
  g_source_fps = fr.den ? av_q2d(fr) : 30.0;

  AVFormatContext *chunk_fmt = NULL;
  AVStream *chunk_stream = NULL;
  AVStream *chunk_audio_streams[MAX_AUDIO_STREAMS] = {0};
  int chunk_count = 0;
  int frames_in_chunk = 0;
  char chunk_path[512];
  AVPacket *pkt = av_packet_alloc();

  while (av_read_frame(in_fmt, pkt) >= 0) {
    int audio_match = -1;
    for (int a = 0; a < audio_count; a++) {
      if (pkt->stream_index == audio_idx[a]) { audio_match = a; break; }
    }
    if (audio_match >= 0) {
      if (chunk_fmt && chunk_audio_streams[audio_match]) {
        AVStream *in_audio_stream = in_fmt->streams[audio_idx[audio_match]];
        AVPacket *out_pkt = av_packet_clone(pkt);
        av_packet_unref(pkt);
        av_packet_rescale_ts(out_pkt, in_audio_stream->time_base, chunk_audio_streams[audio_match]->time_base);
        out_pkt->stream_index = chunk_audio_streams[audio_match]->index;
        av_interleaved_write_frame(chunk_fmt, out_pkt);
        av_packet_free(&out_pkt);
      } else {
        av_packet_unref(pkt);
      }
      continue;
    }
    if (pkt->stream_index != video_idx) { av_packet_unref(pkt); continue; }

    int is_keyframe = (pkt->flags & AV_PKT_FLAG_KEY) != 0;
    int should_start = is_keyframe && (chunk_fmt == NULL || frames_in_chunk >= target_chunk_frames);
    if (should_start) {
      if (chunk_fmt) {
        if (chunk_count - 1 < MAX_CHUNKS) g_chunk_frame_counts[chunk_count - 1] = frames_in_chunk;
        av_write_trailer(chunk_fmt);
        avio_closep(&chunk_fmt->pb);
        avformat_free_context(chunk_fmt);
      }
      if (chunk_count >= MAX_CHUNKS) { fprintf(stderr, "[slice_copy] MAX_CHUNKS exceeded\n"); return -1003; }
      snprintf(chunk_path, sizeof(chunk_path), "%s%03d.%s", output_prefix, chunk_count, file_ext);
      avformat_alloc_output_context2(&chunk_fmt, NULL, muxer_name, chunk_path);
      chunk_stream = avformat_new_stream(chunk_fmt, NULL);
      avcodec_parameters_copy(chunk_stream->codecpar, in_stream->codecpar);
      chunk_stream->codecpar->codec_tag = 0;
      chunk_stream->time_base = in_stream->time_base;
      for (int a = 0; a < audio_count; a++) {
        AVStream *in_audio_stream = in_fmt->streams[audio_idx[a]];
        chunk_audio_streams[a] = avformat_new_stream(chunk_fmt, NULL);
        avcodec_parameters_copy(chunk_audio_streams[a]->codecpar, in_audio_stream->codecpar);
        chunk_audio_streams[a]->codecpar->codec_tag = 0;
        chunk_audio_streams[a]->time_base = in_audio_stream->time_base;
      }
      if ((ret = avio_open(&chunk_fmt->pb, chunk_path, AVIO_FLAG_WRITE)) < 0)
        TRANSCODE_FAIL("slice_copy: avio_open", ret);
      AVDictionary *opts = NULL;
      if (strcmp(muxer_name, "mp4") == 0)
        av_dict_set(&opts, "movflags", "+faststart", 0);
      if ((ret = avformat_write_header(chunk_fmt, opts ? &opts : NULL)) < 0)
        TRANSCODE_FAIL("slice_copy: avformat_write_header", ret);
      av_dict_free(&opts);
      chunk_count++;
      frames_in_chunk = 0;
    }
    if (!chunk_fmt) { av_packet_unref(pkt); continue; }

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

EMSCRIPTEN_KEEPALIVE
int slice_webm(const char *input_path, const char *output_prefix, int target_chunk_frames) {
  return slice_stream_copy(input_path, output_prefix, target_chunk_frames, "webm", "webm");
}

EMSCRIPTEN_KEEPALIVE
int slice_mp4(const char *input_path, const char *output_prefix, int target_chunk_frames) {
  return slice_stream_copy(input_path, output_prefix, target_chunk_frames, "mp4", "mp4");
}

/* Social segment: WebM or MP4 (VP8/VP9/H.264 + Opus/AAC) → H.264(+AAC) MPEG-TS. */
/* Social segment: WebM/VP8/VP9(+Opus) → H.264(+AAC) MPEG-TS with framing. */
EMSCRIPTEN_KEEPALIVE
int transcode_social_segment(const char *input_path, const char *output_path,
                             int out_width, int out_height, int video_bitrate_kbps,
                             int audio_bitrate_kbps, int gop_size, int frame_mode,
                             const char *encoder_name) {
  int ret;
  if (!encoder_name || !encoder_name[0]) encoder_name = "libopenh264";
  if (audio_bitrate_kbps <= 0) audio_bitrate_kbps = 160;
  if (gop_size <= 0) gop_size = 60;

  AVFormatContext *in_fmt = NULL;
  if ((ret = avformat_open_input(&in_fmt, input_path, NULL, NULL)) < 0)
    TRANSCODE_FAIL("social: avformat_open_input", ret);
  if ((ret = avformat_find_stream_info(in_fmt, NULL)) < 0)
    TRANSCODE_FAIL("social: avformat_find_stream_info", ret);

  int video_idx = -1, audio_idx = -1;
  for (unsigned i = 0; i < in_fmt->nb_streams; i++) {
    enum AVMediaType t = in_fmt->streams[i]->codecpar->codec_type;
    if (t == AVMEDIA_TYPE_VIDEO && video_idx < 0) video_idx = i;
    else if (t == AVMEDIA_TYPE_AUDIO && audio_idx < 0) audio_idx = i;
  }
  if (video_idx < 0) { fprintf(stderr, "[social] no video\n"); return -1000; }

  AVStream *in_video = in_fmt->streams[video_idx];
  const AVCodec *dec_codec = avcodec_find_decoder(in_video->codecpar->codec_id);
  if (!dec_codec) { fprintf(stderr, "[social] no decoder for codec_id=%d\n", in_video->codecpar->codec_id); return -1004; }
  AVCodecContext *dec_ctx = avcodec_alloc_context3(dec_codec);
  avcodec_parameters_to_context(dec_ctx, in_video->codecpar);
  dec_ctx->thread_count = 1;
  if ((ret = avcodec_open2(dec_ctx, dec_codec, NULL)) < 0)
    TRANSCODE_FAIL("social: video decoder open", ret);

  int dst_w = out_width > 0 ? out_width : dec_ctx->width;
  int dst_h = out_height > 0 ? out_height : dec_ctx->height;
  evenize(&dst_w);
  evenize(&dst_h);

  int crop_x = 0, crop_y = 0, crop_w = dec_ctx->width, crop_h = dec_ctx->height;
  int fit_w = dst_w, fit_h = dst_h, pad_x = 0, pad_y = 0;
  int sws_src_w = dec_ctx->width, sws_src_h = dec_ctx->height;
  int sws_dst_w = dst_w, sws_dst_h = dst_h;
  if (frame_mode == 1) {
    compute_cover_crop(dec_ctx->width, dec_ctx->height, dst_w, dst_h, &crop_x, &crop_y, &crop_w, &crop_h);
    sws_src_w = crop_w; sws_src_h = crop_h;
  } else if (frame_mode == 2) {
    compute_contain_fit(dec_ctx->width, dec_ctx->height, dst_w, dst_h, &fit_w, &fit_h, &pad_x, &pad_y);
    sws_dst_w = fit_w; sws_dst_h = fit_h;
  }

  struct SwsContext *sws = sws_getContext(
      sws_src_w, sws_src_h, dec_ctx->pix_fmt,
      sws_dst_w, sws_dst_h, AV_PIX_FMT_YUV420P,
      SWS_BILINEAR, NULL, NULL, NULL);
  if (!sws) { fprintf(stderr, "[social] sws_getContext failed\n"); return -1001; }

  const AVCodec *enc_codec = avcodec_find_encoder_by_name(encoder_name);
  if (!enc_codec) { fprintf(stderr, "[social] unknown encoder '%s'\n", encoder_name); return -1004; }
  AVCodecContext *enc_ctx = avcodec_alloc_context3(enc_codec);
  enc_ctx->width = dst_w;
  enc_ctx->height = dst_h;
  enc_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
  /*
   * Keep the source timestamp clock.  This path used to force 30 fps and
   * assign frame PTS as 0,1,2,... below.  That changes the playback speed of
   * every non-30-fps (and every variable-frame-rate) source while audio keeps
   * its real sample-clock duration -- e.g. 6 fps video ran exactly 5x fast.
   */
  AVRational source_tb = in_video->time_base;
  if (source_tb.num <= 0 || source_tb.den <= 0)
    source_tb = (AVRational){1, 1000};
  AVRational source_fr = in_video->avg_frame_rate.num > 0
      ? in_video->avg_frame_rate : in_video->r_frame_rate;
  double source_fps = source_fr.den > 0 ? av_q2d(source_fr) : 0.0;
  if (source_fps < 1.0 || source_fps > 120.0)
    source_fr = (AVRational){30, 1};
  double progress_fps = source_fps;
  if (progress_fps < 1.0 || progress_fps > 120.0)
    progress_fps = av_q2d(source_fr);
  int64_t estimated_total_frames = in_video->nb_frames;
  if (estimated_total_frames <= 0 && in_video->duration > 0) {
    estimated_total_frames = (int64_t)ceil(
        in_video->duration * av_q2d(in_video->time_base) * progress_fps);
  }
  if (estimated_total_frames <= 0 && in_fmt->duration > 0) {
    estimated_total_frames = (int64_t)ceil(
        ((double)in_fmt->duration / AV_TIME_BASE) * progress_fps);
  }
  enc_ctx->time_base = source_tb;
  enc_ctx->framerate = source_fr;
  enc_ctx->gop_size = gop_size;
  enc_ctx->max_b_frames = 0;
  enc_ctx->thread_count = 1;
  enc_ctx->color_range = AVCOL_RANGE_MPEG;
  enc_ctx->color_primaries = AVCOL_PRI_BT709;
  enc_ctx->color_trc = AVCOL_TRC_BT709;
  enc_ctx->colorspace = AVCOL_SPC_BT709;
  if (video_bitrate_kbps > 0) enc_ctx->bit_rate = video_bitrate_kbps * 1000LL;
  if (strstr(encoder_name, "openh264")) {
    av_opt_set_int(enc_ctx->priv_data, "allow_skip_frames", 1, 0);
    if (video_bitrate_kbps > 0) av_opt_set(enc_ctx->priv_data, "rc_mode", "bitrate", 0);
  }
  if ((ret = avcodec_open2(enc_ctx, enc_codec, NULL)) < 0)
    TRANSCODE_FAIL("social: video encoder open", ret);

  /* Audio: decode → swr → AAC */
  AVCodecContext *aud_dec = NULL;
  AVCodecContext *aud_enc = NULL;
  SwrContext *swr = NULL;
  if (audio_idx >= 0) {
    AVStream *in_audio = in_fmt->streams[audio_idx];
    const AVCodec *adec = avcodec_find_decoder(in_audio->codecpar->codec_id);
    if (adec) {
      aud_dec = avcodec_alloc_context3(adec);
      avcodec_parameters_to_context(aud_dec, in_audio->codecpar);
      if (avcodec_open2(aud_dec, adec, NULL) < 0) {
        avcodec_free_context(&aud_dec);
        aud_dec = NULL;
      }
    }
    if (aud_dec) {
      const AVCodec *aenc = avcodec_find_encoder_by_name("aac");
      aud_enc = avcodec_alloc_context3(aenc);
      aud_enc->sample_rate = 48000;
      av_channel_layout_default(&aud_enc->ch_layout, 2);
      aud_enc->sample_fmt = AV_SAMPLE_FMT_FLTP;
      aud_enc->bit_rate = audio_bitrate_kbps * 1000LL;
      aud_enc->time_base = (AVRational){1, aud_enc->sample_rate};
      if ((ret = avcodec_open2(aud_enc, aenc, NULL)) < 0)
        TRANSCODE_FAIL("social: aac encoder open", ret);
      ret = swr_alloc_set_opts2(&swr,
          &aud_enc->ch_layout, aud_enc->sample_fmt, aud_enc->sample_rate,
          &aud_dec->ch_layout, aud_dec->sample_fmt, aud_dec->sample_rate,
          0, NULL);
      if (ret < 0 || swr_init(swr) < 0)
        TRANSCODE_FAIL("social: swr_init", ret < 0 ? ret : -1);
    }
  }

  AVFormatContext *out_fmt = NULL;
  avformat_alloc_output_context2(&out_fmt, NULL, "mpegts", output_path);
  AVStream *out_v = avformat_new_stream(out_fmt, NULL);
  avcodec_parameters_from_context(out_v->codecpar, enc_ctx);
  out_v->time_base = enc_ctx->time_base;
  AVStream *out_a = NULL;
  if (aud_enc) {
    out_a = avformat_new_stream(out_fmt, NULL);
    avcodec_parameters_from_context(out_a->codecpar, aud_enc);
    out_a->time_base = aud_enc->time_base;
    out_a->codecpar->codec_tag = 0;
  }
  if ((ret = avio_open(&out_fmt->pb, output_path, AVIO_FLAG_WRITE)) < 0)
    TRANSCODE_FAIL("social: avio_open", ret);
  if ((ret = avformat_write_header(out_fmt, NULL)) < 0)
    TRANSCODE_FAIL("social: write_header", ret);

  AVPacket *in_pkt = av_packet_alloc();
  AVFrame *frame = av_frame_alloc();
  AVFrame *scaled = av_frame_alloc();
  scaled->format = AV_PIX_FMT_YUV420P;
  scaled->width = dst_w;
  scaled->height = dst_h;
  av_frame_get_buffer(scaled, 32);
  AVFrame *fit_frame = NULL;
  if (frame_mode == 2) {
    fit_frame = av_frame_alloc();
    fit_frame->format = AV_PIX_FMT_YUV420P;
    fit_frame->width = fit_w;
    fit_frame->height = fit_h;
    av_frame_get_buffer(fit_frame, 32);
  }
  AVPacket *out_pkt = av_packet_alloc();
  AVFrame *aframe = aud_dec ? av_frame_alloc() : NULL;
  AVFrame *aframe_res = aud_enc ? av_frame_alloc() : NULL;
  int64_t first_video_pts = AV_NOPTS_VALUE;
  int64_t last_video_pts = AV_NOPTS_VALUE;
  int64_t fallback_frame_step =
      av_rescale_q(1, av_inv_q(enc_ctx->framerate), enc_ctx->time_base);
  if (fallback_frame_step < 1) fallback_frame_step = 1;
  int64_t audio_pts = 0;
  uint8_t *audio_fifo = NULL;
  int audio_fifo_samples = 0;
  int audio_fifo_cap = 0;
  int processed_video_frames = 0;
  double last_progress_ms = emscripten_get_now();
  report_social_progress(
      estimated_total_frames > 0 ? 0.0 : -1.0,
      0,
      estimated_total_frames > 0 ? (int)estimated_total_frames : 0);

  while (av_read_frame(in_fmt, in_pkt) >= 0) {
    if (aud_dec && in_pkt->stream_index == audio_idx) {
      if (avcodec_send_packet(aud_dec, in_pkt) >= 0) {
        while (avcodec_receive_frame(aud_dec, aframe) >= 0) {
          int dst_nb = av_rescale_rnd(swr_get_delay(swr, aud_dec->sample_rate) + aframe->nb_samples,
                                      aud_enc->sample_rate, aud_dec->sample_rate, AV_ROUND_UP);
          if (dst_nb <= 0) continue;
          if (audio_fifo_samples + dst_nb > audio_fifo_cap) {
            audio_fifo_cap = audio_fifo_samples + dst_nb + aud_enc->frame_size * 4;
            audio_fifo = (uint8_t *)av_realloc(audio_fifo, audio_fifo_cap * sizeof(float) * 2);
          }
          uint8_t *out_planes[2];
          /* Temporary planar buffer */
          float *tmp[2];
          tmp[0] = (float *)av_malloc(dst_nb * sizeof(float));
          tmp[1] = (float *)av_malloc(dst_nb * sizeof(float));
          out_planes[0] = (uint8_t *)tmp[0];
          out_planes[1] = (uint8_t *)tmp[1];
          int converted = swr_convert(swr, out_planes, dst_nb,
                                      (const uint8_t **)aframe->extended_data, aframe->nb_samples);
          if (converted > 0) {
            /* Interleave into fifo as L,R float pairs for later planar re-pack — store planar concat */
            for (int i = 0; i < converted; i++) {
              ((float *)audio_fifo)[audio_fifo_samples * 2 + i * 2] = tmp[0][i];
              ((float *)audio_fifo)[audio_fifo_samples * 2 + i * 2 + 1] = tmp[1][i];
            }
            /* Fix: store as non-interleaved in two regions is harder; use interleaved then split */
            audio_fifo_samples += converted;
          }
          av_free(tmp[0]);
          av_free(tmp[1]);

          while (audio_fifo_samples >= aud_enc->frame_size) {
            aframe_res->format = AV_SAMPLE_FMT_FLTP;
            aframe_res->ch_layout = aud_enc->ch_layout;
            aframe_res->sample_rate = aud_enc->sample_rate;
            aframe_res->nb_samples = aud_enc->frame_size;
            av_frame_get_buffer(aframe_res, 0);
            float *l = (float *)aframe_res->data[0];
            float *r = (float *)aframe_res->data[1];
            for (int i = 0; i < aud_enc->frame_size; i++) {
              l[i] = ((float *)audio_fifo)[i * 2];
              r[i] = ((float *)audio_fifo)[i * 2 + 1];
            }
            int remain = audio_fifo_samples - aud_enc->frame_size;
            if (remain > 0) {
              memmove(audio_fifo,
                      (float *)audio_fifo + aud_enc->frame_size * 2,
                      (size_t)remain * 2 * sizeof(float));
            }
            audio_fifo_samples = remain;
            aframe_res->pts = audio_pts;
            audio_pts += aud_enc->frame_size;
            avcodec_send_frame(aud_enc, aframe_res);
            av_frame_unref(aframe_res);
            while (avcodec_receive_packet(aud_enc, out_pkt) >= 0) {
              av_packet_rescale_ts(out_pkt, aud_enc->time_base, out_a->time_base);
              out_pkt->stream_index = out_a->index;
              av_interleaved_write_frame(out_fmt, out_pkt);
            }
          }
        }
      }
      av_packet_unref(in_pkt);
      continue;
    }
    if (in_pkt->stream_index != video_idx) { av_packet_unref(in_pkt); continue; }
    if (avcodec_send_packet(dec_ctx, in_pkt) < 0) { av_packet_unref(in_pkt); continue; }
    av_packet_unref(in_pkt);
    while (avcodec_receive_frame(dec_ctx, frame) >= 0) {
      const uint8_t *src_data[4];
      int src_linesize[4];
      if (frame_mode == 1) {
        /* Offset pointers into the crop rectangle */
        int shift_y = crop_y;
        int shift_x = crop_x;
        for (int p = 0; p < 4; p++) {
          src_data[p] = NULL;
          src_linesize[p] = 0;
        }
        src_linesize[0] = frame->linesize[0];
        src_linesize[1] = frame->linesize[1];
        src_linesize[2] = frame->linesize[2];
        src_data[0] = frame->data[0] + shift_y * frame->linesize[0] + shift_x;
        src_data[1] = frame->data[1] + (shift_y / 2) * frame->linesize[1] + (shift_x / 2);
        src_data[2] = frame->data[2] + (shift_y / 2) * frame->linesize[2] + (shift_x / 2);
        sws_scale(sws, src_data, src_linesize, 0, crop_h, scaled->data, scaled->linesize);
      } else if (frame_mode == 2) {
        sws_scale(sws, (const uint8_t *const *)frame->data, frame->linesize,
                  0, dec_ctx->height, fit_frame->data, fit_frame->linesize);
        /* Clear destination to black (limited-range Y=16, UV=128) then copy fit */
        memset(scaled->data[0], 16, scaled->linesize[0] * dst_h);
        memset(scaled->data[1], 128, scaled->linesize[1] * (dst_h / 2));
        memset(scaled->data[2], 128, scaled->linesize[2] * (dst_h / 2));
        for (int y = 0; y < fit_h; y++) {
          memcpy(scaled->data[0] + (y + pad_y) * scaled->linesize[0] + pad_x,
                 fit_frame->data[0] + y * fit_frame->linesize[0], fit_w);
        }
        for (int y = 0; y < fit_h / 2; y++) {
          memcpy(scaled->data[1] + (y + pad_y / 2) * scaled->linesize[1] + pad_x / 2,
                 fit_frame->data[1] + y * fit_frame->linesize[1], fit_w / 2);
          memcpy(scaled->data[2] + (y + pad_y / 2) * scaled->linesize[2] + pad_x / 2,
                 fit_frame->data[2] + y * fit_frame->linesize[2], fit_w / 2);
        }
      } else {
        sws_scale(sws, (const uint8_t *const *)frame->data, frame->linesize,
                  0, dec_ctx->height, scaled->data, scaled->linesize);
      }
      /*
       * Preserve elapsed source time, but make each independently processed
       * segment start at zero for the TS stitcher.  best_effort_timestamp is
       * in the input stream time base and also handles reordered decode.
       * Only synthesize a nominal frame interval when the decoder supplies no
       * timestamp (or a broken/non-increasing one).
       */
      int64_t source_pts = frame->best_effort_timestamp;
      int64_t next_video_pts;
      if (source_pts != AV_NOPTS_VALUE) {
        if (first_video_pts == AV_NOPTS_VALUE) first_video_pts = source_pts;
        next_video_pts = av_rescale_q(source_pts - first_video_pts,
                                      source_tb, enc_ctx->time_base);
      } else {
        next_video_pts = last_video_pts == AV_NOPTS_VALUE
            ? 0 : last_video_pts + fallback_frame_step;
      }
      if (last_video_pts != AV_NOPTS_VALUE && next_video_pts <= last_video_pts)
        next_video_pts = last_video_pts + fallback_frame_step;
      scaled->pts = next_video_pts;
      last_video_pts = next_video_pts;
      scaled->pict_type = AV_PICTURE_TYPE_NONE;
      avcodec_send_frame(enc_ctx, scaled);
      while (avcodec_receive_packet(enc_ctx, out_pkt) >= 0) {
        av_packet_rescale_ts(out_pkt, enc_ctx->time_base, out_v->time_base);
        out_pkt->stream_index = out_v->index;
        av_interleaved_write_frame(out_fmt, out_pkt);
      }
      processed_video_frames++;
      double progress_ms = emscripten_get_now();
      if (progress_ms - last_progress_ms >= 1000.0) {
        double ratio = estimated_total_frames > 0
            ? (double)processed_video_frames / (double)estimated_total_frames
            : -1.0;
        if (ratio > 0.99) ratio = 0.99;
        report_social_progress(
            ratio,
            processed_video_frames,
            estimated_total_frames > 0 ? (int)estimated_total_frames : 0);
        last_progress_ms = progress_ms;
      }
    }
  }

  avcodec_send_frame(enc_ctx, NULL);
  while (avcodec_receive_packet(enc_ctx, out_pkt) >= 0) {
    av_packet_rescale_ts(out_pkt, enc_ctx->time_base, out_v->time_base);
    out_pkt->stream_index = out_v->index;
    av_interleaved_write_frame(out_fmt, out_pkt);
  }
  if (aud_enc) {
    avcodec_send_frame(aud_enc, NULL);
    while (avcodec_receive_packet(aud_enc, out_pkt) >= 0) {
      av_packet_rescale_ts(out_pkt, aud_enc->time_base, out_a->time_base);
      out_pkt->stream_index = out_a->index;
      av_interleaved_write_frame(out_fmt, out_pkt);
    }
  }

  av_write_trailer(out_fmt);
  avio_closep(&out_fmt->pb);
  avformat_free_context(out_fmt);
  sws_freeContext(sws);
  if (swr) swr_free(&swr);
  av_free(audio_fifo);
  avcodec_free_context(&dec_ctx);
  avcodec_free_context(&enc_ctx);
  if (aud_dec) avcodec_free_context(&aud_dec);
  if (aud_enc) avcodec_free_context(&aud_enc);
  avformat_close_input(&in_fmt);
  av_frame_free(&frame);
  av_frame_free(&scaled);
  if (fit_frame) av_frame_free(&fit_frame);
  if (aframe) av_frame_free(&aframe);
  if (aframe_res) av_frame_free(&aframe_res);
  av_packet_free(&in_pkt);
  av_packet_free(&out_pkt);
  report_social_progress(
      1.0,
      processed_video_frames,
      estimated_total_frames > 0 ? (int)estimated_total_frames : processed_video_frames);
  return 0;
}

/*
 * Frame-accurate extract of [start_sec, end_sec) into a standalone MPEG-TS
 * segment (H.264 + AAC) at the source resolution. Used by the browser to
 * stage a director's cut before keyframe chunking / DCP dispatch.
 */
EMSCRIPTEN_KEEPALIVE
int extract_time_range(const char *input_path, const char *output_path,
                       double start_sec, double end_sec,
                       int video_bitrate_kbps, int audio_bitrate_kbps) {
  int ret;
  if (!input_path || !output_path) return -1;
  if (!(end_sec > start_sec)) {
    fprintf(stderr, "[extract] invalid range %.3f..%.3f\n", start_sec, end_sec);
    return -1005;
  }
  if (start_sec < 0) start_sec = 0;
  if (video_bitrate_kbps <= 0) video_bitrate_kbps = 6000;
  if (audio_bitrate_kbps <= 0) audio_bitrate_kbps = 160;

  AVFormatContext *in_fmt = NULL;
  if ((ret = avformat_open_input(&in_fmt, input_path, NULL, NULL)) < 0)
    TRANSCODE_FAIL("extract: avformat_open_input", ret);
  if ((ret = avformat_find_stream_info(in_fmt, NULL)) < 0)
    TRANSCODE_FAIL("extract: avformat_find_stream_info", ret);

  int video_idx = -1, audio_idx = -1;
  for (unsigned i = 0; i < in_fmt->nb_streams; i++) {
    enum AVMediaType t = in_fmt->streams[i]->codecpar->codec_type;
    if (t == AVMEDIA_TYPE_VIDEO && video_idx < 0) video_idx = i;
    else if (t == AVMEDIA_TYPE_AUDIO && audio_idx < 0) audio_idx = i;
  }
  if (video_idx < 0) {
    fprintf(stderr, "[extract] no video\n");
    avformat_close_input(&in_fmt);
    return -1000;
  }

  AVStream *in_video = in_fmt->streams[video_idx];
  const AVCodec *dec_codec = avcodec_find_decoder(in_video->codecpar->codec_id);
  if (!dec_codec) {
    fprintf(stderr, "[extract] no decoder for codec_id=%d\n", in_video->codecpar->codec_id);
    avformat_close_input(&in_fmt);
    return -1004;
  }
  AVCodecContext *dec_ctx = avcodec_alloc_context3(dec_codec);
  avcodec_parameters_to_context(dec_ctx, in_video->codecpar);
  dec_ctx->thread_count = 1;
  if ((ret = avcodec_open2(dec_ctx, dec_codec, NULL)) < 0)
    TRANSCODE_FAIL("extract: video decoder open", ret);

  int dst_w = dec_ctx->width;
  int dst_h = dec_ctx->height;
  evenize(&dst_w);
  evenize(&dst_h);

  struct SwsContext *sws = sws_getContext(
      dec_ctx->width, dec_ctx->height, dec_ctx->pix_fmt,
      dst_w, dst_h, AV_PIX_FMT_YUV420P,
      SWS_BILINEAR, NULL, NULL, NULL);
  if (!sws) {
    fprintf(stderr, "[extract] sws_getContext failed\n");
    return -1001;
  }

  const AVCodec *enc_codec = avcodec_find_encoder_by_name("libopenh264");
  if (!enc_codec) {
    fprintf(stderr, "[extract] libopenh264 missing\n");
    return -1004;
  }
  AVCodecContext *enc_ctx = avcodec_alloc_context3(enc_codec);
  enc_ctx->width = dst_w;
  enc_ctx->height = dst_h;
  enc_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
  AVRational source_tb = in_video->time_base;
  if (source_tb.num <= 0 || source_tb.den <= 0)
    source_tb = (AVRational){1, 1000};
  AVRational source_fr = in_video->avg_frame_rate.num > 0
      ? in_video->avg_frame_rate : in_video->r_frame_rate;
  double source_fps = source_fr.den > 0 ? av_q2d(source_fr) : 0.0;
  if (source_fps < 1.0 || source_fps > 120.0)
    source_fr = (AVRational){30, 1};
  enc_ctx->time_base = source_tb;
  enc_ctx->framerate = source_fr;
  enc_ctx->gop_size = (int)fmax(1.0, source_fps * 2.0);
  enc_ctx->max_b_frames = 0;
  enc_ctx->thread_count = 1;
  enc_ctx->bit_rate = video_bitrate_kbps * 1000LL;
  av_opt_set_int(enc_ctx->priv_data, "allow_skip_frames", 1, 0);
  av_opt_set(enc_ctx->priv_data, "rc_mode", "bitrate", 0);
  if ((ret = avcodec_open2(enc_ctx, enc_codec, NULL)) < 0)
    TRANSCODE_FAIL("extract: video encoder open", ret);

  AVCodecContext *aud_dec = NULL;
  AVCodecContext *aud_enc = NULL;
  SwrContext *swr = NULL;
  AVStream *in_audio = NULL;
  if (audio_idx >= 0) {
    in_audio = in_fmt->streams[audio_idx];
    const AVCodec *adec = avcodec_find_decoder(in_audio->codecpar->codec_id);
    if (adec) {
      aud_dec = avcodec_alloc_context3(adec);
      avcodec_parameters_to_context(aud_dec, in_audio->codecpar);
      if (avcodec_open2(aud_dec, adec, NULL) < 0) {
        avcodec_free_context(&aud_dec);
        aud_dec = NULL;
      }
    }
    if (aud_dec) {
      const AVCodec *aenc = avcodec_find_encoder_by_name("aac");
      aud_enc = avcodec_alloc_context3(aenc);
      aud_enc->sample_rate = 48000;
      av_channel_layout_default(&aud_enc->ch_layout, 2);
      aud_enc->sample_fmt = AV_SAMPLE_FMT_FLTP;
      aud_enc->bit_rate = audio_bitrate_kbps * 1000LL;
      aud_enc->time_base = (AVRational){1, aud_enc->sample_rate};
      if ((ret = avcodec_open2(aud_enc, aenc, NULL)) < 0)
        TRANSCODE_FAIL("extract: aac encoder open", ret);
      ret = swr_alloc_set_opts2(&swr,
          &aud_enc->ch_layout, aud_enc->sample_fmt, aud_enc->sample_rate,
          &aud_dec->ch_layout, aud_dec->sample_fmt, aud_dec->sample_rate,
          0, NULL);
      if (ret < 0 || swr_init(swr) < 0)
        TRANSCODE_FAIL("extract: swr_init", ret < 0 ? ret : -1);
    }
  }

  AVFormatContext *out_fmt = NULL;
  avformat_alloc_output_context2(&out_fmt, NULL, "mpegts", output_path);
  AVStream *out_v = avformat_new_stream(out_fmt, NULL);
  avcodec_parameters_from_context(out_v->codecpar, enc_ctx);
  out_v->time_base = enc_ctx->time_base;
  AVStream *out_a = NULL;
  if (aud_enc) {
    out_a = avformat_new_stream(out_fmt, NULL);
    avcodec_parameters_from_context(out_a->codecpar, aud_enc);
    out_a->time_base = aud_enc->time_base;
    out_a->codecpar->codec_tag = 0;
  }
  if ((ret = avio_open(&out_fmt->pb, output_path, AVIO_FLAG_WRITE)) < 0)
    TRANSCODE_FAIL("extract: avio_open", ret);
  if ((ret = avformat_write_header(out_fmt, NULL)) < 0)
    TRANSCODE_FAIL("extract: write_header", ret);

  int64_t start_ts = av_rescale_q((int64_t)(start_sec * 1000.0), (AVRational){1, 1000}, source_tb);
  int64_t end_ts = av_rescale_q((int64_t)(end_sec * 1000.0), (AVRational){1, 1000}, source_tb);

  if (start_sec > 0.01) {
    int64_t seek_ts = start_ts;
    if (in_video->start_time != AV_NOPTS_VALUE) seek_ts += in_video->start_time;
    av_seek_frame(in_fmt, video_idx, seek_ts, AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(dec_ctx);
    if (aud_dec) avcodec_flush_buffers(aud_dec);
  }

  AVPacket *in_pkt = av_packet_alloc();
  AVFrame *frame = av_frame_alloc();
  AVFrame *scaled = av_frame_alloc();
  scaled->format = AV_PIX_FMT_YUV420P;
  scaled->width = dst_w;
  scaled->height = dst_h;
  av_frame_get_buffer(scaled, 32);
  AVPacket *out_pkt = av_packet_alloc();
  AVFrame *aframe = aud_dec ? av_frame_alloc() : NULL;
  AVFrame *aframe_res = aud_enc ? av_frame_alloc() : NULL;
  int64_t first_video_pts = AV_NOPTS_VALUE;
  int64_t last_video_pts = AV_NOPTS_VALUE;
  int64_t fallback_frame_step =
      av_rescale_q(1, av_inv_q(enc_ctx->framerate), enc_ctx->time_base);
  if (fallback_frame_step < 1) fallback_frame_step = 1;
  int64_t audio_pts = 0;
  uint8_t *audio_fifo = NULL;
  int audio_fifo_samples = 0;
  int audio_fifo_cap = 0;
  int wrote_video = 0;
  int video_done = 0;
  int audio_done = !aud_dec;

  /* Encode one AAC frame from the head of audio_fifo (caller ensures enough samples). */
  #define EXTRACT_ENCODE_AUDIO_FRAME() do { \
    aframe_res->format = AV_SAMPLE_FMT_FLTP; \
    aframe_res->ch_layout = aud_enc->ch_layout; \
    aframe_res->sample_rate = aud_enc->sample_rate; \
    aframe_res->nb_samples = aud_enc->frame_size; \
    av_frame_get_buffer(aframe_res, 0); \
    float *_l = (float *)aframe_res->data[0]; \
    float *_r = (float *)aframe_res->data[1]; \
    for (int _i = 0; _i < aud_enc->frame_size; _i++) { \
      _l[_i] = ((float *)audio_fifo)[_i * 2]; \
      _r[_i] = ((float *)audio_fifo)[_i * 2 + 1]; \
    } \
    int _remain = audio_fifo_samples - aud_enc->frame_size; \
    if (_remain > 0) { \
      memmove(audio_fifo, \
              (float *)audio_fifo + aud_enc->frame_size * 2, \
              (size_t)_remain * 2 * sizeof(float)); \
    } \
    audio_fifo_samples = _remain; \
    aframe_res->pts = audio_pts; \
    audio_pts += aud_enc->frame_size; \
    avcodec_send_frame(aud_enc, aframe_res); \
    av_frame_unref(aframe_res); \
    while (avcodec_receive_packet(aud_enc, out_pkt) >= 0) { \
      av_packet_rescale_ts(out_pkt, aud_enc->time_base, out_a->time_base); \
      out_pkt->stream_index = out_a->index; \
      av_interleaved_write_frame(out_fmt, out_pkt); \
    } \
  } while (0)

  #define EXTRACT_PUSH_AUDIO_SAMPLES(src0, src1, n) do { \
    int _n = (n); \
    if (_n <= 0) break; \
    if (audio_fifo_samples + _n > audio_fifo_cap) { \
      audio_fifo_cap = audio_fifo_samples + _n + aud_enc->frame_size * 4; \
      audio_fifo = (uint8_t *)av_realloc(audio_fifo, audio_fifo_cap * sizeof(float) * 2); \
    } \
    for (int _i = 0; _i < _n; _i++) { \
      ((float *)audio_fifo)[audio_fifo_samples * 2 + _i * 2] = (src0)[_i]; \
      ((float *)audio_fifo)[audio_fifo_samples * 2 + _i * 2 + 1] = (src1)[_i]; \
    } \
    audio_fifo_samples += _n; \
    while (audio_fifo_samples >= aud_enc->frame_size) { \
      EXTRACT_ENCODE_AUDIO_FRAME(); \
    } \
  } while (0)

  while ((!video_done || !audio_done) && av_read_frame(in_fmt, in_pkt) >= 0) {
    if (aud_dec && in_pkt->stream_index == audio_idx) {
      if (audio_done) {
        av_packet_unref(in_pkt);
        continue;
      }
      int64_t pkt_ts = in_pkt->pts != AV_NOPTS_VALUE ? in_pkt->pts
          : (in_pkt->dts != AV_NOPTS_VALUE ? in_pkt->dts : AV_NOPTS_VALUE);
      double pkt_sec = -1;
      if (pkt_ts != AV_NOPTS_VALUE && in_audio) {
        int64_t adj = pkt_ts;
        if (in_audio->start_time != AV_NOPTS_VALUE) adj -= in_audio->start_time;
        pkt_sec = adj * av_q2d(in_audio->time_base);
      }
      /* Keep packets that may still decode into the window; stop once audio is past end. */
      if (pkt_sec >= 0 && pkt_sec + 0.05 < start_sec) {
        av_packet_unref(in_pkt);
        continue;
      }
      if (pkt_sec >= end_sec + 0.05) {
        audio_done = 1;
        av_packet_unref(in_pkt);
        continue;
      }
      if (avcodec_send_packet(aud_dec, in_pkt) >= 0) {
        while (avcodec_receive_frame(aud_dec, aframe) >= 0) {
          int64_t a_ts = aframe->best_effort_timestamp;
          if (a_ts == AV_NOPTS_VALUE) a_ts = aframe->pts;
          if (a_ts != AV_NOPTS_VALUE && in_audio) {
            int64_t adj = a_ts;
            if (in_audio->start_time != AV_NOPTS_VALUE) adj -= in_audio->start_time;
            double a_sec = adj * av_q2d(in_audio->time_base);
            double a_dur = aframe->nb_samples * av_q2d(in_audio->time_base);
            /* Drop frames wholly before the window; stop once frames begin at/after end. */
            if (a_sec + a_dur <= start_sec) continue;
            if (a_sec >= end_sec) {
              audio_done = 1;
              continue;
            }
          }
          int dst_nb = av_rescale_rnd(swr_get_delay(swr, aud_dec->sample_rate) + aframe->nb_samples,
                                      aud_enc->sample_rate, aud_dec->sample_rate, AV_ROUND_UP);
          if (dst_nb <= 0) continue;
          float *tmp[2];
          uint8_t *out_planes[2];
          tmp[0] = (float *)av_malloc(dst_nb * sizeof(float));
          tmp[1] = (float *)av_malloc(dst_nb * sizeof(float));
          out_planes[0] = (uint8_t *)tmp[0];
          out_planes[1] = (uint8_t *)tmp[1];
          int converted = swr_convert(swr, out_planes, dst_nb,
                                      (const uint8_t **)aframe->extended_data, aframe->nb_samples);
          if (converted > 0) EXTRACT_PUSH_AUDIO_SAMPLES(tmp[0], tmp[1], converted);
          av_free(tmp[0]);
          av_free(tmp[1]);
        }
      }
      av_packet_unref(in_pkt);
      continue;
    }

    if (in_pkt->stream_index != video_idx) {
      av_packet_unref(in_pkt);
      continue;
    }
    if (video_done) {
      av_packet_unref(in_pkt);
      continue;
    }
    if (avcodec_send_packet(dec_ctx, in_pkt) < 0) {
      av_packet_unref(in_pkt);
      continue;
    }
    av_packet_unref(in_pkt);

    while (avcodec_receive_frame(dec_ctx, frame) >= 0) {
      int64_t source_pts = frame->best_effort_timestamp;
      if (source_pts == AV_NOPTS_VALUE) source_pts = frame->pts;
      if (source_pts != AV_NOPTS_VALUE) {
        int64_t adj = source_pts;
        if (in_video->start_time != AV_NOPTS_VALUE) adj -= in_video->start_time;
        if (adj < start_ts) continue;
        if (adj >= end_ts) {
          video_done = 1;
          break;
        }
      }

      sws_scale(sws, (const uint8_t *const *)frame->data, frame->linesize,
                0, dec_ctx->height, scaled->data, scaled->linesize);

      int64_t next_video_pts;
      if (source_pts != AV_NOPTS_VALUE) {
        int64_t adj = source_pts;
        if (in_video->start_time != AV_NOPTS_VALUE) adj -= in_video->start_time;
        if (first_video_pts == AV_NOPTS_VALUE) first_video_pts = adj;
        next_video_pts = av_rescale_q(adj - first_video_pts, source_tb, enc_ctx->time_base);
      } else {
        next_video_pts = last_video_pts == AV_NOPTS_VALUE
            ? 0 : last_video_pts + fallback_frame_step;
      }
      if (last_video_pts != AV_NOPTS_VALUE && next_video_pts <= last_video_pts)
        next_video_pts = last_video_pts + fallback_frame_step;
      scaled->pts = next_video_pts;
      last_video_pts = next_video_pts;
      scaled->pict_type = AV_PICTURE_TYPE_NONE;
      avcodec_send_frame(enc_ctx, scaled);
      while (avcodec_receive_packet(enc_ctx, out_pkt) >= 0) {
        av_packet_rescale_ts(out_pkt, enc_ctx->time_base, out_v->time_base);
        out_pkt->stream_index = out_v->index;
        av_interleaved_write_frame(out_fmt, out_pkt);
        wrote_video = 1;
      }
    }
  }

  /* Drain remaining compressed audio after video has ended. */
  if (aud_dec && !audio_done) {
    avcodec_send_packet(aud_dec, NULL);
    while (avcodec_receive_frame(aud_dec, aframe) >= 0) {
      int64_t a_ts = aframe->best_effort_timestamp;
      if (a_ts == AV_NOPTS_VALUE) a_ts = aframe->pts;
      if (a_ts != AV_NOPTS_VALUE && in_audio) {
        int64_t adj = a_ts;
        if (in_audio->start_time != AV_NOPTS_VALUE) adj -= in_audio->start_time;
        double a_sec = adj * av_q2d(in_audio->time_base);
        if (a_sec + 0.02 < start_sec) continue;
        if (a_sec >= end_sec) break;
      }
      int dst_nb = av_rescale_rnd(swr_get_delay(swr, aud_dec->sample_rate) + aframe->nb_samples,
                                  aud_enc->sample_rate, aud_dec->sample_rate, AV_ROUND_UP);
      if (dst_nb <= 0) continue;
      float *tmp[2];
      uint8_t *out_planes[2];
      tmp[0] = (float *)av_malloc(dst_nb * sizeof(float));
      tmp[1] = (float *)av_malloc(dst_nb * sizeof(float));
      out_planes[0] = (uint8_t *)tmp[0];
      out_planes[1] = (uint8_t *)tmp[1];
      int converted = swr_convert(swr, out_planes, dst_nb,
                                  (const uint8_t **)aframe->extended_data, aframe->nb_samples);
      if (converted > 0) EXTRACT_PUSH_AUDIO_SAMPLES(tmp[0], tmp[1], converted);
      av_free(tmp[0]);
      av_free(tmp[1]);
    }
  }

  avcodec_send_frame(enc_ctx, NULL);
  while (avcodec_receive_packet(enc_ctx, out_pkt) >= 0) {
    av_packet_rescale_ts(out_pkt, enc_ctx->time_base, out_v->time_base);
    out_pkt->stream_index = out_v->index;
    av_interleaved_write_frame(out_fmt, out_pkt);
    wrote_video = 1;
  }

  if (aud_enc) {
    /* Drain resampler delay, then pad/encode any leftover PCM so the slice
     * keeps its trailing audio instead of dropping a partial AAC frame. */
    if (swr) {
      for (;;) {
        float *tmp[2];
        uint8_t *out_planes[2];
        int room = aud_enc->frame_size * 4;
        tmp[0] = (float *)av_malloc(room * sizeof(float));
        tmp[1] = (float *)av_malloc(room * sizeof(float));
        out_planes[0] = (uint8_t *)tmp[0];
        out_planes[1] = (uint8_t *)tmp[1];
        int converted = swr_convert(swr, out_planes, room, NULL, 0);
        if (converted > 0) EXTRACT_PUSH_AUDIO_SAMPLES(tmp[0], tmp[1], converted);
        av_free(tmp[0]);
        av_free(tmp[1]);
        if (converted <= 0) break;
      }
    }
    if (audio_fifo_samples > 0) {
      int need = aud_enc->frame_size - audio_fifo_samples;
      if (need > 0) {
        if (audio_fifo_samples + need > audio_fifo_cap) {
          audio_fifo_cap = audio_fifo_samples + need;
          audio_fifo = (uint8_t *)av_realloc(audio_fifo, audio_fifo_cap * sizeof(float) * 2);
        }
        memset((float *)audio_fifo + audio_fifo_samples * 2, 0,
               (size_t)need * 2 * sizeof(float));
        audio_fifo_samples += need;
      }
      while (audio_fifo_samples >= aud_enc->frame_size) {
        EXTRACT_ENCODE_AUDIO_FRAME();
      }
    }

    /* Match audio duration to the extracted video span so the first staged
     * slice does not go silent early when A/V packet order ends video first. */
    if (last_video_pts != AV_NOPTS_VALUE && first_video_pts != AV_NOPTS_VALUE) {
      double video_sec = (last_video_pts - 0) * av_q2d(enc_ctx->time_base)
          + av_q2d(av_inv_q(enc_ctx->framerate));
      int64_t want_samples = (int64_t)(video_sec * aud_enc->sample_rate + 0.5);
      while (audio_pts + aud_enc->frame_size <= want_samples) {
        if (aud_enc->frame_size > audio_fifo_cap) {
          audio_fifo_cap = aud_enc->frame_size;
          audio_fifo = (uint8_t *)av_realloc(audio_fifo, audio_fifo_cap * sizeof(float) * 2);
        }
        memset(audio_fifo, 0, (size_t)aud_enc->frame_size * 2 * sizeof(float));
        audio_fifo_samples = aud_enc->frame_size;
        EXTRACT_ENCODE_AUDIO_FRAME();
      }
    }

    avcodec_send_frame(aud_enc, NULL);
    while (avcodec_receive_packet(aud_enc, out_pkt) >= 0) {
      av_packet_rescale_ts(out_pkt, aud_enc->time_base, out_a->time_base);
      out_pkt->stream_index = out_a->index;
      av_interleaved_write_frame(out_fmt, out_pkt);
    }
  }

  av_write_trailer(out_fmt);
  avio_closep(&out_fmt->pb);
  avformat_free_context(out_fmt);
  sws_freeContext(sws);
  if (swr) swr_free(&swr);
  av_free(audio_fifo);
  avcodec_free_context(&dec_ctx);
  avcodec_free_context(&enc_ctx);
  if (aud_dec) avcodec_free_context(&aud_dec);
  if (aud_enc) avcodec_free_context(&aud_enc);
  avformat_close_input(&in_fmt);
  av_frame_free(&frame);
  av_frame_free(&scaled);
  if (aframe) av_frame_free(&aframe);
  if (aframe_res) av_frame_free(&aframe_res);
  av_packet_free(&in_pkt);
  av_packet_free(&out_pkt);
#undef EXTRACT_ENCODE_AUDIO_FRAME
#undef EXTRACT_PUSH_AUDIO_SAMPLES
  if (!wrote_video) {
    fprintf(stderr, "[extract] no video frames in %.3f..%.3f\n", start_sec, end_sec);
    return -1006;
  }
  return 0;
}

/* Bitstream remux MPEG-TS → MP4 with +faststart (moov at front). */
EMSCRIPTEN_KEEPALIVE
int remux_to_mp4(const char *input_path, const char *output_path) {
  int ret;
  AVFormatContext *in_fmt = NULL;
  if ((ret = avformat_open_input(&in_fmt, input_path, NULL, NULL)) < 0)
    TRANSCODE_FAIL("remux: avformat_open_input", ret);
  if ((ret = avformat_find_stream_info(in_fmt, NULL)) < 0)
    TRANSCODE_FAIL("remux: find_stream_info", ret);

  AVFormatContext *out_fmt = NULL;
  avformat_alloc_output_context2(&out_fmt, NULL, "mp4", output_path);
  int stream_map[MAX_AUDIO_STREAMS + 4];
  for (unsigned i = 0; i < in_fmt->nb_streams; i++) stream_map[i] = -1;
  for (unsigned i = 0; i < in_fmt->nb_streams; i++) {
    AVCodecParameters *cp = in_fmt->streams[i]->codecpar;
    if (cp->codec_type != AVMEDIA_TYPE_VIDEO && cp->codec_type != AVMEDIA_TYPE_AUDIO)
      continue;
    AVStream *out_stream = avformat_new_stream(out_fmt, NULL);
    avcodec_parameters_copy(out_stream->codecpar, cp);
    out_stream->codecpar->codec_tag = 0;
    stream_map[i] = out_stream->index;
  }
  if ((ret = avio_open(&out_fmt->pb, output_path, AVIO_FLAG_WRITE)) < 0)
    TRANSCODE_FAIL("remux: avio_open", ret);
  AVDictionary *opts = NULL;
  av_dict_set(&opts, "movflags", "+faststart", 0);
  if ((ret = avformat_write_header(out_fmt, &opts)) < 0)
    TRANSCODE_FAIL("remux: write_header", ret);
  av_dict_free(&opts);

  AVPacket *pkt = av_packet_alloc();
  int64_t first_pts[32];
  int saw[32];
  int64_t last_out_dts[32];
  int64_t last_out_dur[32];
  for (int i = 0; i < 32; i++) {
    first_pts[i] = AV_NOPTS_VALUE;
    saw[i] = 0;
    last_out_dts[i] = AV_NOPTS_VALUE;
    last_out_dur[i] = 0;
  }
  while (av_read_frame(in_fmt, pkt) >= 0) {
    int in_idx = pkt->stream_index;
    if (in_idx < 0 || in_idx >= (int)in_fmt->nb_streams || stream_map[in_idx] < 0) {
      av_packet_unref(pkt);
      continue;
    }
    AVStream *in_st = in_fmt->streams[in_idx];
    AVStream *out_st = out_fmt->streams[stream_map[in_idx]];
    if (pkt->dts == AV_NOPTS_VALUE) pkt->dts = pkt->pts;
    if (pkt->pts == AV_NOPTS_VALUE) pkt->pts = pkt->dts;
    if (!saw[in_idx] && pkt->pts != AV_NOPTS_VALUE) {
      first_pts[in_idx] = pkt->pts;
      saw[in_idx] = 1;
    }
    if (saw[in_idx] && first_pts[in_idx] != AV_NOPTS_VALUE) {
      if (pkt->pts != AV_NOPTS_VALUE) pkt->pts -= first_pts[in_idx];
      if (pkt->dts != AV_NOPTS_VALUE) pkt->dts -= first_pts[in_idx];
    }
    av_packet_rescale_ts(pkt, in_st->time_base, out_st->time_base);
    pkt->stream_index = out_st->index;
    pkt->pos = -1;
    /* Concatenated per-chunk MPEG-TS restarts timestamps at 0. Keep DTS
     * strictly increasing so the MP4 muxer does not reject the join
     * ("non monotonically increasing dts to muxer"). */
    {
      int oi = pkt->stream_index;
      if (oi >= 0 && oi < 32 && pkt->dts != AV_NOPTS_VALUE
          && last_out_dts[oi] != AV_NOPTS_VALUE && pkt->dts <= last_out_dts[oi]) {
        int64_t step = last_out_dur[oi] > 0 ? last_out_dur[oi] : 1;
        int64_t adj = last_out_dts[oi] + step - pkt->dts;
        pkt->dts += adj;
        if (pkt->pts != AV_NOPTS_VALUE) pkt->pts += adj;
      }
      if (oi >= 0 && oi < 32) {
        if (pkt->dts != AV_NOPTS_VALUE) last_out_dts[oi] = pkt->dts;
        if (pkt->duration > 0) last_out_dur[oi] = pkt->duration;
      }
    }
    ret = av_interleaved_write_frame(out_fmt, pkt);
    av_packet_unref(pkt);
    if (ret < 0) TRANSCODE_FAIL("remux: write_frame", ret);
  }
  av_write_trailer(out_fmt);
  avio_closep(&out_fmt->pb);
  avformat_free_context(out_fmt);
  avformat_close_input(&in_fmt);
  av_packet_free(&pkt);
  return 0;
}

/* main() is never used as the entry point (see the docs for why) - kept
 * only because Emscripten's runtime init expects a main to be linkable.
 * -sINVOKE_RUN=0 at link time prevents it from auto-running. */
int main(void) { return 0; }
