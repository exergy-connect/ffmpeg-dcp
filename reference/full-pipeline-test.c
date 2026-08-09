/*
 * Full pipeline proof in one process (MEMFS is per-process, so a
 * two-process encode-then-decode split wouldn't see the same
 * filesystem). Phase 1: generate synthetic frames, encode via
 * libopenh264, mux to out.mp4. Phase 2: demux out.mp4 back in, decode
 * via h264 decoder, re-encode via libopenh264, mux to out2.mp4.
 * Single-threaded throughout, no fftools, no scheduler, no pthread.
 */
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <stdio.h>

#define WIDTH 320
#define HEIGHT 240
#define FPS 10
#define NUM_FRAMES 10

static void fill_frame(AVFrame *frame, int frame_idx) {
  for (int y = 0; y < HEIGHT; y++)
    for (int x = 0; x < WIDTH; x++)
      frame->data[0][y * frame->linesize[0] + x] = (x + y + frame_idx * 3) & 0xFF;
  for (int y = 0; y < HEIGHT / 2; y++) {
    for (int x = 0; x < WIDTH / 2; x++) {
      frame->data[1][y * frame->linesize[1] + x] = 128 + frame_idx;
      frame->data[2][y * frame->linesize[2] + x] = 64 + frame_idx;
    }
  }
}

static int phase1_encode(void) {
  int ret;
  const AVCodec *codec = avcodec_find_encoder_by_name("libopenh264");
  AVCodecContext *enc_ctx = avcodec_alloc_context3(codec);
  enc_ctx->width = WIDTH;
  enc_ctx->height = HEIGHT;
  enc_ctx->time_base = (AVRational){1, FPS};
  enc_ctx->framerate = (AVRational){FPS, 1};
  enc_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
  enc_ctx->thread_count = 1;
  if ((ret = avcodec_open2(enc_ctx, codec, NULL)) < 0) {
    fprintf(stderr, "[phase1] avcodec_open2 failed: %s\n", av_err2str(ret));
    return 1;
  }

  AVFormatContext *fmt_ctx = NULL;
  avformat_alloc_output_context2(&fmt_ctx, NULL, "mp4", "out.mp4");
  AVStream *stream = avformat_new_stream(fmt_ctx, NULL);
  avcodec_parameters_from_context(stream->codecpar, enc_ctx);
  stream->time_base = enc_ctx->time_base;
  if ((ret = avio_open(&fmt_ctx->pb, "out.mp4", AVIO_FLAG_WRITE)) < 0) {
    fprintf(stderr, "[phase1] avio_open failed: %s\n", av_err2str(ret));
    return 1;
  }
  if ((ret = avformat_write_header(fmt_ctx, NULL)) < 0) {
    fprintf(stderr, "[phase1] avformat_write_header failed: %s\n", av_err2str(ret));
    return 1;
  }

  AVFrame *frame = av_frame_alloc();
  frame->format = enc_ctx->pix_fmt;
  frame->width = WIDTH;
  frame->height = HEIGHT;
  av_frame_get_buffer(frame, 32);
  AVPacket *pkt = av_packet_alloc();
  int frames_encoded = 0, packets_written = 0;

  for (int i = 0; i < NUM_FRAMES; i++) {
    av_frame_make_writable(frame);
    fill_frame(frame, i);
    frame->pts = i;
    avcodec_send_frame(enc_ctx, frame);
    frames_encoded++;
    while (avcodec_receive_packet(enc_ctx, pkt) >= 0) {
      av_packet_rescale_ts(pkt, enc_ctx->time_base, stream->time_base);
      pkt->stream_index = stream->index;
      av_interleaved_write_frame(fmt_ctx, pkt);
      packets_written++;
    }
  }
  avcodec_send_frame(enc_ctx, NULL);
  while (avcodec_receive_packet(enc_ctx, pkt) >= 0) {
    av_packet_rescale_ts(pkt, enc_ctx->time_base, stream->time_base);
    pkt->stream_index = stream->index;
    av_interleaved_write_frame(fmt_ctx, pkt);
    packets_written++;
  }
  av_write_trailer(fmt_ctx);
  avio_closep(&fmt_ctx->pb);

  fprintf(stderr, "[phase1] frames_encoded=%d packets_written=%d\n", frames_encoded, packets_written);
  avcodec_free_context(&enc_ctx);
  avformat_free_context(fmt_ctx);
  av_frame_free(&frame);
  av_packet_free(&pkt);
  return 0;
}

static int phase2_roundtrip(void) {
  int ret;

  AVFormatContext *in_fmt = NULL;
  if ((ret = avformat_open_input(&in_fmt, "out.mp4", NULL, NULL)) < 0) {
    fprintf(stderr, "[phase2] avformat_open_input failed: %s\n", av_err2str(ret));
    return 1;
  }
  if ((ret = avformat_find_stream_info(in_fmt, NULL)) < 0) {
    fprintf(stderr, "[phase2] avformat_find_stream_info failed: %s\n", av_err2str(ret));
    return 1;
  }

  int video_idx = -1;
  for (unsigned i = 0; i < in_fmt->nb_streams; i++)
    if (in_fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) { video_idx = i; break; }
  if (video_idx < 0) { fprintf(stderr, "[phase2] no video stream found\n"); return 1; }

  const AVCodec *dec_codec = avcodec_find_decoder(in_fmt->streams[video_idx]->codecpar->codec_id);
  AVCodecContext *dec_ctx = avcodec_alloc_context3(dec_codec);
  avcodec_parameters_to_context(dec_ctx, in_fmt->streams[video_idx]->codecpar);
  dec_ctx->thread_count = 1;
  if ((ret = avcodec_open2(dec_ctx, dec_codec, NULL)) < 0) {
    fprintf(stderr, "[phase2] decoder avcodec_open2 failed: %s\n", av_err2str(ret));
    return 1;
  }
  fprintf(stderr, "[phase2] decoder opened OK: %s\n", dec_codec->name);

  const AVCodec *enc_codec = avcodec_find_encoder_by_name("libopenh264");
  AVCodecContext *enc_ctx = avcodec_alloc_context3(enc_codec);
  enc_ctx->width = dec_ctx->width;
  enc_ctx->height = dec_ctx->height;
  enc_ctx->time_base = in_fmt->streams[video_idx]->time_base;
  enc_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
  enc_ctx->thread_count = 1;
  if ((ret = avcodec_open2(enc_ctx, enc_codec, NULL)) < 0) {
    fprintf(stderr, "[phase2] encoder avcodec_open2 failed: %s\n", av_err2str(ret));
    return 1;
  }

  AVFormatContext *out_fmt = NULL;
  avformat_alloc_output_context2(&out_fmt, NULL, "mp4", "out2.mp4");
  AVStream *out_stream = avformat_new_stream(out_fmt, NULL);
  avcodec_parameters_from_context(out_stream->codecpar, enc_ctx);
  out_stream->time_base = enc_ctx->time_base;
  if ((ret = avio_open(&out_fmt->pb, "out2.mp4", AVIO_FLAG_WRITE)) < 0) {
    fprintf(stderr, "[phase2] avio_open failed: %s\n", av_err2str(ret));
    return 1;
  }
  if ((ret = avformat_write_header(out_fmt, NULL)) < 0) {
    fprintf(stderr, "[phase2] avformat_write_header failed: %s\n", av_err2str(ret));
    return 1;
  }

  AVPacket *in_pkt = av_packet_alloc();
  AVFrame *frame = av_frame_alloc();
  AVPacket *out_pkt = av_packet_alloc();
  int frames_decoded = 0, frames_encoded = 0, packets_written = 0;

  while (av_read_frame(in_fmt, in_pkt) >= 0) {
    if (in_pkt->stream_index != video_idx) { av_packet_unref(in_pkt); continue; }
    ret = avcodec_send_packet(dec_ctx, in_pkt);
    av_packet_unref(in_pkt);
    if (ret < 0) { fprintf(stderr, "[phase2] send_packet failed: %s\n", av_err2str(ret)); return 1; }

    while ((ret = avcodec_receive_frame(dec_ctx, frame)) >= 0) {
      frames_decoded++;
      frame->pict_type = AV_PICTURE_TYPE_NONE;
      avcodec_send_frame(enc_ctx, frame);
      frames_encoded++;
      while (avcodec_receive_packet(enc_ctx, out_pkt) >= 0) {
        av_packet_rescale_ts(out_pkt, enc_ctx->time_base, out_stream->time_base);
        out_pkt->stream_index = out_stream->index;
        av_interleaved_write_frame(out_fmt, out_pkt);
        packets_written++;
      }
    }
  }
  avcodec_send_frame(enc_ctx, NULL);
  while (avcodec_receive_packet(enc_ctx, out_pkt) >= 0) {
    av_packet_rescale_ts(out_pkt, enc_ctx->time_base, out_stream->time_base);
    out_pkt->stream_index = out_stream->index;
    av_interleaved_write_frame(out_fmt, out_pkt);
    packets_written++;
  }
  av_write_trailer(out_fmt);
  avio_closep(&out_fmt->pb);

  fprintf(stderr, "[phase2] frames_decoded=%d frames_encoded=%d packets_written=%d\n",
          frames_decoded, frames_encoded, packets_written);

  FILE *check = fopen("out2.mp4", "rb");
  if (check) {
    fseek(check, 0, SEEK_END);
    fprintf(stderr, "[phase2] out2.mp4 size = %ld bytes\n", ftell(check));
    fclose(check);
  } else {
    fprintf(stderr, "[phase2] out2.mp4 NOT FOUND\n");
    return 1;
  }
  return 0;
}

int main(void) {
  if (phase1_encode() != 0) return 1;
  if (phase2_roundtrip() != 0) return 1;
  fprintf(stderr, "FULL PIPELINE OK\n");
  return 0;
}
