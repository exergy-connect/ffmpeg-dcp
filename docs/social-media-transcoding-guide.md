# Social Media Transcoding Guide

**Researched:** August 24, 2026  
**Scope:** Transcoding a `MediaRecorder`-style in-browser recording — normally VP8 or VP9 video plus Opus audio in WebM — into optimal upload masters and ABR ladder profiles for YouTube, X (Twitter), Instagram, Facebook, and LinkedIn. Intended for a DCP / FFmpeg WASM transcoding demo.

Platform limits change. Treat every numeric limit below as a snapshot of official help-center guidance as of the research date, and re-check the cited sources before shipping a production pipeline.

---

## 1. How to read this document

### 1.1 What “optimal” means here

For each platform we recommend a **high-quality, broadly compatible upload master** — not the largest file the platform will accept. Goals, in order:

1. **Upload acceptance** — codecs, dimensions, aspect ratios, and file/duration caps that match official guidance.
2. **Visual quality after re-encode** — platforms re-encode everything; a clean H.264/AAC MP4 with enough bitrate survives that second pass better than a barely-legal max file.
3. **Practical encode cost** — avoid 4K/8K masters unless the destination actually benefits (YouTube is the main case). Prefer 1080-class masters for feed and short-form elsewhere.
4. **DCP demo readiness** — settings that map cleanly onto this repo’s H.264 / AAC / MP4 / YUV420P path.

### 1.2 Upload master vs ABR ladder

| Artifact | Purpose | Upload to social platform? |
| --- | --- | --- |
| **Upload master** | Single mezzanine-quality file per placement | **Yes** — one file per post/placement |
| **ABR ladder** | Multi-rung adaptive bitrate set for local / HLS demo playback | **No** — platforms generate their own playback ladders |

Social networks ingest one (or a few) masters and build their own adaptive streams. The ABR tables in this guide are **DCP demo / reference outputs**: they show how a distributed encoder would produce a YouTube-like or Meta-like ladder for in-browser HLS playback and cost comparison — they are not “upload all ten rungs to Instagram.”

### 1.3 Placement families

For every platform we define two placement families:

| Family | Typical aspect | Use |
| --- | --- | --- |
| **Feed / standard** | 16:9 (YouTube, X) or 4:5 (Instagram, Facebook, LinkedIn) | Timeline / desktop / long-form |
| **Short-form / full-screen** | 9:16 | Shorts, Reels, Stories-style vertical |

### 1.4 Assumed input

This guide assumes one completed browser recording, typically produced by:

```js
new MediaRecorder(stream, {
  mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm;codecs=vp8,opus',
});
```

The resulting input is expected to be:

| Property | Assumption |
| --- | --- |
| Container | WebM / Matroska (`video/webm`) |
| Video | VP8 or VP9, progressive; source dimensions may be any browser/canvas/capture size |
| Audio | Usually Opus at 48 kHz; audio may be absent if the captured stream had no audio track |
| Timing | Potentially variable-frame-rate (VFR), with irregular timestamps after pauses, tab throttling, or dropped capture frames |
| Color | SDR in normal use; color metadata may be missing or unreliable |

Do not upload the WebM unchanged as the cross-platform master. Some destinations accept VP8/VP9 on selected paths, but **H.264/AAC in MP4 remains the common ingest format**. The first pipeline responsibility is therefore to decode WebM, normalize timing/audio, reframe, and encode the placement-specific MP4.

---

## 2. Shared encoding baseline

Use this output baseline for every upload master and ABR rung unless a platform section overrides it. VP8/VP9 and Opus describe the **input**, not the social output.

| Parameter | Recommendation | Rationale |
| --- | --- | --- |
| Container | MP4 (`isom`/`mp42`), `+faststart` (moov at front) | Universal upload acceptance; progressive download |
| Video codec | H.264 / AVC, **High** profile where allowed; **Main** if OpenH264-only | YouTube explicitly prefers High; Meta/LinkedIn/X all accept H.264 |
| Pixel format | `yuv420p` (4:2:0), progressive | Required or strongly preferred everywhere |
| Color (SDR) | BT.709 primaries / transfer / matrix, limited range | YouTube SDR guidance; safe default for Meta/LinkedIn/X |
| Frame rate | Normalize browser VFR to **30 fps CFR** by default; preserve 60 only for a verified stable 60 fps capture and a destination that benefits | One shared 30 fps path satisfies Meta/LinkedIn limits; YouTube/X/Reels can accept 60 |
| GOP / keyframes | Closed GOP, **~2 s** (e.g. 60 frames @ 30 fps) | Aligns with YouTube “half frame rate” and Meta Reels 2–5 s closed GOP |
| Audio | AAC-LC, stereo, **48 kHz** (or 44.1 kHz for Meta-preferred exports), **128–192 kbps** | Stereo AAC is the common denominator; YouTube allows higher for stereo |
| Edit lists | Avoid / strip | YouTube and Facebook warn about edit lists / special boxes |
| Dimensions | Even width and height (divisible by 2; prefer multiples of 16) | H.264 macroblock alignment |

### 2.1 Browser-recording ingest normalization

Apply these steps once before, or consistently within, every rendition encode:

1. **Probe the actual streams.** Trust the WebM stream metadata, not the requested `getUserMedia()` constraints. Confirm VP8 vs VP9, coded dimensions, duration, average frame rate, audio presence, and start timestamps.
2. **Preserve timestamps, then make a stable output timeline.** Browser recordings can be VFR. Generate missing presentation timestamps when needed, start output at zero, and produce a constant 30 fps social master. Duplicate/drop frames rather than interpreting the WebM time base as the frame rate.
3. **Resample audio for synchronization.** Decode Opus and use asynchronous resampling to correct small drift or gaps before encoding AAC-LC at 48 kHz stereo. Keep audio optional.
4. **Normalize geometry.** Browser/window captures are often not 16:9, 4:5, or 9:16. Crop/reframe or pad deliberately; never scale directly to a mismatched target aspect.
5. **Normalize color conservatively.** Treat an ordinary browser recording as SDR and emit `yuv420p` with BT.709 output tags. A tag alone is not an HDR-to-SDR conversion.

A 30 fps CFR output is the shared default even if capture was requested at 60 fps: browser delivery can still be irregular, and 30 fps satisfies every platform profile in this guide. Preserve 60 fps only for a verified, stable source and a destination profile that benefits from it.

### 2.2 Aspect-ratio handling (critical for this codebase)

**Never stretch.** Prefer intentional **center crop / reframe** for feed and short-form masters. Padding (letterbox/pillarbox) is acceptable only when the creative must preserve the full frame and the destination player will not crop again.

> **Code note:** [`src/dcp-transcode.c`](../src/dcp-transcode.c) scales with `sws_getContext` directly to the requested `width`×`height`. A mismatched source aspect ratio **will distort** unless framing (crop/pad) is added later. The current demo ladder in [`app.js`](../app.js) assumes 16:9 throughout for that reason.

### 2.3 HDR policy

Default all social masters to **SDR BT.709**. A normal VP8/VP9 browser recording should be treated as SDR unless capture metadata and pixel values prove otherwise. YouTube and Meta Reels can accept HDR, but HDR adds encode complexity, device variance, and is out of scope for a first DCP social demo (this project already documents HDR10 passthrough as optional and Dolby Vision as unsupported).

---

## 3. Platform upload masters

### 3.1 YouTube

**Sources:** [Recommended upload encoding settings](https://support.google.com/youtube/answer/1722171), [Video resolution & aspect ratios](https://support.google.com/youtube/answer/6375112), [Shorts upload](https://support.google.com/youtube/answer/12779649), [Shorts overview](https://support.google.com/youtube/answer/10059070).

| | Feed / long-form | Shorts |
| --- | --- | --- |
| Aspect | 16:9 (native; no baked-in bars) | Square or vertical (9:16 recommended) |
| Resolution | **1920×1080** (demo default); 3840×2160 if source is 4K | **1080×1920** (Shorts max often cited as 1080p) |
| Video bitrate (SDR, ≤30 fps) | **8 Mbps** @ 1080p | **8 Mbps** (treat as 1080p-class) |
| Video bitrate (SDR, 48–60 fps) | **12 Mbps** @ 1080p | **12 Mbps** if source is HFR |
| Codec / profile | H.264 High, closed GOP ≈½ frame rate, CABAC, 2 B-frames | Same |
| Audio | AAC-LC, 48 kHz, stereo **384 kbps** (YouTube table) or **192 kbps** practical | Same |
| Duration | Long-form: channel limits apply | Shorts: square/vertical, up to **3 minutes** (classification rules) |
| File notes | Fast Start; no edit lists | Same |

**Why these choices:** YouTube’s official 1080p SDR table is 8 Mbps (standard frame rate) / 12 Mbps (high frame rate). Uploading below that invites soft detail after YouTube’s own ABR encode. Vertical Shorts still benefit from the same codec/bitrate class at 1080×1920. Avoid baking letterbox bars — YouTube pads dynamically.

**Organic vs ads:** Same encoding recommendations; ads add creative/policy constraints, not a different mezzanine codec stack.

---

### 3.2 X (Twitter)

**Sources:** X Help / Media API best-practice tables (H.264 High, AAC-LC; landscape 1280×720, portrait 720×1280, square 720×720); third-party summaries of help.x.com upload caps (non-Premium ~140 s / ~512 MB; Premium longer / larger). Prefer re-checking [help.x.com](https://help.x.com) and [docs.x.com media best practices](https://docs.x.com) at encode time — some endpoints return 403 to automated fetchers.

| | Feed / standard | Short-form / vertical |
| --- | --- | --- |
| Aspect | 16:9 | 9:16 |
| Resolution | **1280×720** (standard); **1920×1080** only if targeting Premium 1080p playback | **720×1280** (standard); **1080×1920** for Premium-class |
| Video bitrate | **5–8 Mbps** (≥5 Mbps commonly cited as API minimum recommendation) | Same class |
| Codec | H.264 High, fixed frame rate, progressive, closed GOP 2–5 s, 4:2:0 | Same |
| Audio | AAC-LC, ≤48 kHz, mono or stereo, **128 kbps** | Same |
| Duration / size (typical non-Premium) | ~**140 s**, ~**512 MB** | Same |
| Aspect range | Roughly **1:3 – 3:1** | Same |

**Why these choices:** X historically delivers 720p to non-subscribers even when 1080p is uploaded. A 720p master at ≥5 Mbps is the cost/quality sweet spot for a demo that targets the broadest audience; offer an optional 1080p “Premium” master as a second toggle rather than the default.

---

### 3.3 Instagram

**Sources:** [Instagram Feed ads design](https://www.facebook.com/business/help/430958953753149), [Stories ads design](https://www.facebook.com/business/help/2222978001316177), [Aspect ratio best practices](https://www.facebook.com/business/help/103816146375741), [Edits export tip](https://help.instagram.com/553588510887194) (2K / 60 fps / HDR for best playback — aspirational; 1080p SDR remains the practical master).

| | Feed | Reels / Stories (full-screen) |
| --- | --- | --- |
| Aspect | **4:5** (recommended; taller than 4:5 may crop in Feed) | **9:16** |
| Resolution | **1080×1350** | **1080×1920** |
| Video bitrate | **6–8 Mbps** (engineering; Meta rarely publishes a fixed VOD bitrate) | **8–10 Mbps** |
| Codec | H.264 (H.265 accepted on some Reels paths; stick to H.264 for demo) | Same |
| Audio | AAC-LC, stereo, 44.1 or 48 kHz, ≥128 kbps | Same |
| File size | Up to **~4 GB** (ads guidance) | Same |
| Duration | Feed video can be long; Reels/Stories creative usually short | Reels: product rules vary; boosts often cite ≤60 s |

**Why these choices:** Meta’s Feed guidance favors **4:5** for vertical presence without the aggressive UI chrome of 9:16. Stories/Reels want full-bleed **9:16 @ 1080×1920**. Instagram’s Edits app suggests 2K/60/HDR for “best quality,” but a 1080p H.264 SDR master remains the interoperable choice for a WASM/OpenH264 demo and still meets Meta’s “at least 1080-wide” class recommendations.

**Safe zones:** Keep logos/text off extreme top/bottom/side edges; Reels/Stories UI overlays are aggressive.

---

### 3.4 Facebook

**Sources:** [Recommended export settings](https://www.facebook.com/help/1041366099316573), [Facebook Reels requirements](https://www.facebook.com/business/help/1197310377458196), [Aspect ratios by placement](https://www.facebook.com/business/help/682655495435254), [Feed aspect best practices](https://www.facebook.com/business/help/103816146375741).

| | Feed | Reels / full-screen |
| --- | --- | --- |
| Aspect | **4:5** (recommended for Feed videos) | **9:16** |
| Resolution | **1080×1350** | **1080×1920** |
| Video bitrate | **6–8 Mbps** | **8–10 Mbps** |
| Codec | H.264 + AAC in MP4/MOV; width ≤4000, divisible by 16 | H.264 (H.265 also listed for Reels); demo: H.264 |
| Frame rate | **≤30 fps** for general edited uploads | Reels allow **24–60**; prefer 30 for cost |
| Audio | AAC-LC stereo, **44.1 kHz** (Facebook export article) or 48 kHz | ≥128 kbps |
| Notes | No edit lists / special boxes | Closed GOP 2–5 s, 4:2:0, progressive |

**Why these choices:** Facebook’s own “edited video” article is sparse on bitrate but clear on H.264/AAC, ≤30 fps, and width constraints. Placement docs recommend **4:5 for Feed** and **9:16 for Reels/Stories**. Aligning Facebook masters with Instagram’s dimensions simplifies a shared “Meta” encode path in the demo (two aspect families, not four).

**Product note (2025+):** Meta has moved Facebook’s Videos tab toward Reels; orientation is more flexible, but 4:5 and 9:16 remain the intentional creative choices.

---

### 3.5 LinkedIn

**Sources:** [Video sharing troubleshooting / organic limits](https://www.linkedin.com/help/linkedin/answer/a548372), [Page video specs](https://www.linkedin.com/help/linkedin/answer/a1311816), [Video ads advertising specifications](https://www.linkedin.com/help/lms/answer/a424737).

| | Feed / organic (and ads landscape) | Vertical feed / mobile |
| --- | --- | --- |
| Aspect | **16:9** *or* **4:5** (4:5 recommended for mobile feed presence; ads mark 4:5 as preferred vertical) | **9:16** (supported; ads max 1080×1920) |
| Resolution (recommended) | Landscape: **1920×1080**; Vertical feed: **1080×1350** (4:5) | **1080×1920** (ads max); ads also list 720×1280 as a recommended example |
| Video bitrate | Cap practical ABR/master ≤ **~8–12 Mbps**; platform allows up to **30 Mbps** | Same |
| Codec | MP4, H.264 (ads: H.264 or VP8) | Same |
| Frame rate | Organic: 10–60; **ads: &lt;30 fps** | Prefer **≤30** for one shared LinkedIn master |
| Audio | AAC; ads: AAC or MPEG4, sample rate &lt;64 kHz | Stereo AAC-LC 128–192 kbps |
| Duration | Organic desktop max **15 minutes**; ads **3 s – 30 min** (15–30 s recommended) | Same |
| File size | Organic **5 GB**; ads **75 KB – 500 MB** | Prefer stay under **500 MB** if the same file may be boosted |

**Why these choices:** Organic LinkedIn accepts a wide resolution band (256×144–4096×2304) and aspect band (1:2.4–2.4:1). Ads are stricter: landscape max **1920×1080**, 4:5 max **1080×1350**, 9:16 max **1080×1920**, frame rate **&lt;30**, file ≤500 MB. Designing the LinkedIn **upload master to ad-safe settings** means one file works for organic post and later boost/sponsor without a second encode.

**Demo default:** Prefer **4:5 @ 1080×1350** as the LinkedIn “feed” master (mobile-first) and **9:16 @ 1080×1920** as the vertical master, with an optional 16:9 1080p for desktop-centric thought-leadership posts.

---

## 4. Recommended upload-master matrix (demo defaults)

| ID | Platform | Placement | Size | Aspect | Video kbps | Audio kbps | Max fps | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `yt-feed` | YouTube | Long-form | 1920×1080 | 16:9 | 8000 | 192 | 30 (60 if HFR source) | Official 8 Mbps SDR tier |
| `yt-shorts` | YouTube | Shorts | 1080×1920 | 9:16 | 8000 | 192 | 30 | ≤3 min vertical/square |
| `x-feed` | X | Timeline | 1280×720 | 16:9 | 6000 | 128 | 30 | Broadest playback tier |
| `x-vertical` | X | Vertical | 720×1280 | 9:16 | 6000 | 128 | 30 | Mirror of 720p landscape |
| `ig-feed` | Instagram | Feed | 1080×1350 | 4:5 | 7000 | 160 | 30 | Avoid &gt;4:5 crop surprise |
| `ig-reels` | Instagram | Reels | 1080×1920 | 9:16 | 9000 | 160 | 30 | Full-screen |
| `fb-feed` | Facebook | Feed | 1080×1350 | 4:5 | 7000 | 160 | 30 | Meta shared with IG feed |
| `fb-reels` | Facebook | Reels | 1080×1920 | 9:16 | 9000 | 160 | 30 | Meta shared with IG reels |
| `li-feed` | LinkedIn | Feed | 1080×1350 | 4:5 | 6000 | 160 | 30 | Ad-safe vertical feed |
| `li-vertical` | LinkedIn | Vertical | 1080×1920 | 9:16 | 6000 | 160 | 30 | Ad max; ≤500 MB if boosted |

Optional toggles (not defaults): `yt-feed-4k` 3840×2160 @ 40 Mbps; `x-feed-1080` 1920×1080 @ 8 Mbps (Premium); `li-landscape` 1920×1080 @ 6 Mbps.

---

## 5. ABR ladder profiles

### 5.1 Design principles

1. **Separate from upload masters** — ladders are for DCP HLS / local adaptive demo playback.
2. **Shared baseline, platform caps** — one 16:9 ladder, one 4:5 ladder, one 9:16 ladder; platforms omit rungs above their practical ceiling.
3. **Monotonic bitrates** — each higher rung uses strictly more video bitrate than the rung below.
4. **~2× resolution steps** in pixel count where possible (1080 → 720 → 480 → 360 → 240) to avoid near-duplicate encodes.
5. **Constant audio** on mid/high rungs (128 kbps); drop to 64–96 kbps only on the bottom two rungs to save mobile bandwidth.
6. **GOP aligned** — 2 s keyframe interval on every rung for clean HLS segment boundaries (matches this demo’s ~3 s / 90-frame chunking at 30 fps).

Bitrates below are **ladder playback** targets (similar to CDN ABR), not YouTube’s higher upload-master table. They sit in the same ballpark as the existing demo ladder in `app.js` (1080p/5 Mbps, 720p/2.5 Mbps, 480p/1.2 Mbps, 240p/0.4 Mbps), extended and aspect-corrected.

### 5.2 Shared 16:9 ladder (`abr-16x9`)

Used by: YouTube feed demo, X feed demo, optional LinkedIn landscape demo.

| Rung | Resolution | Video kbps | Audio kbps | Est. total Mbps | Include for |
| --- | --- | --- | --- | --- | --- |
| L4 | 1920×1080 | 5000 | 128 | ~5.1 | YouTube; LinkedIn landscape; **omit for default X** |
| L3 | 1280×720 | 2500 | 128 | ~2.6 | YouTube, X, LinkedIn |
| L2 | 854×480 | 1200 | 128 | ~1.3 | All |
| L1 | 640×360 | 800 | 96 | ~0.9 | All |
| L0 | 426×240 | 400 | 64 | ~0.5 | All |

**X default:** use L3–L0 only (720p ceiling).  
**YouTube demo:** full L4–L0.  
**Optional YouTube 1440/4K rungs** (not required for this PoC): 2560×1440 @ 9 Mbps; 3840×2160 @ 16 Mbps — stay under OpenH264’s **4096×2304** hard cap documented in `index.html`.

### 5.3 Shared 4:5 ladder (`abr-4x5`)

Used by: Instagram Feed, Facebook Feed, LinkedIn Feed.

| Rung | Resolution | Video kbps | Audio kbps | Est. total Mbps | Notes |
| --- | --- | --- | --- | --- | --- |
| V3 | 1080×1350 | 4500 | 128 | ~4.6 | Top feed rung |
| V2 | 810×1012 | 2200 | 128 | ~2.3 | ≈¾ of 1080 edge |
| V1 | 540×676 | 1100 | 96 | ~1.2 | Mid mobile |
| V0 | 360×450 | 500 | 64 | ~0.6 | LinkedIn ads minimum class |

Widths/heights kept even. 810×1012 and 540×676 are exact 4:5 with even sides.

### 5.4 Shared 9:16 ladder (`abr-9x16`)

Used by: YouTube Shorts, X vertical, Instagram Reels, Facebook Reels, LinkedIn vertical.

| Rung | Resolution | Video kbps | Audio kbps | Est. total Mbps | Include for |
| --- | --- | --- | --- | --- | --- |
| S3 | 1080×1920 | 5000 | 128 | ~5.1 | YT Shorts, IG/FB Reels, LinkedIn; **omit for default X** |
| S2 | 720×1280 | 2500 | 128 | ~2.6 | All (X top rung) |
| S1 | 540×960 | 1200 | 96 | ~1.3 | All |
| S0 | 360×640 | 500 | 64 | ~0.6 | All |

### 5.5 Platform → ladder mapping

| Platform | Upload master(s) | ABR ladder for demo | Cap / omitted rungs |
| --- | --- | --- | --- |
| YouTube | `yt-feed`, `yt-shorts` | `abr-16x9` + `abr-9x16` | Full ladders |
| X | `x-feed`, `x-vertical` | `abr-16x9` (L3–L0) + `abr-9x16` (S2–S0) | No 1080p by default |
| Instagram | `ig-feed`, `ig-reels` | `abr-4x5` + `abr-9x16` | Full |
| Facebook | `fb-feed`, `fb-reels` | `abr-4x5` + `abr-9x16` | Same as Instagram (shared Meta path) |
| LinkedIn | `li-feed`, `li-vertical` (+ optional landscape) | `abr-4x5` + `abr-9x16` (+ optional `abr-16x9`) | Prefer ≤30 fps all rungs |

### 5.6 Example DCP-oriented rendition objects

Illustrative shapes compatible with the existing `RENDITIONS` pattern in `app.js`:

```js
// YouTube feed ABR (16:9) — demo ladder, not multi-file upload
const YT_FEED_ABR = [
  { label: 'yt-1080p', width: 1920, height: 1080, bitrateKbps: 5000, encoder: 'libopenh264', playable: true },
  { label: 'yt-720p',  width: 1280, height: 720,  bitrateKbps: 2500, encoder: 'libopenh264', playable: true },
  { label: 'yt-480p',  width: 854,  height: 480,  bitrateKbps: 1200, encoder: 'libopenh264', playable: true },
  { label: 'yt-360p',  width: 640,  height: 360,  bitrateKbps: 800,  encoder: 'libopenh264', playable: true },
  { label: 'yt-240p',  width: 426,  height: 240,  bitrateKbps: 400,  encoder: 'libopenh264', playable: true },
];

// Meta / LinkedIn feed ABR (4:5)
const META_FEED_ABR = [
  { label: 'feed-1080x1350', width: 1080, height: 1350, bitrateKbps: 4500, encoder: 'libopenh264', playable: true },
  { label: 'feed-810x1012',  width: 810,  height: 1012, bitrateKbps: 2200, encoder: 'libopenh264', playable: true },
  { label: 'feed-540x676',   width: 540,  height: 676,  bitrateKbps: 1100, encoder: 'libopenh264', playable: true },
  { label: 'feed-360x450',   width: 360,  height: 450,  bitrateKbps: 500,  encoder: 'libopenh264', playable: true },
];

// Short-form ABR (9:16); X uses only ≤720-wide rungs by default
const SHORTS_ABR = [
  { label: 'v-1080x1920', width: 1080, height: 1920, bitrateKbps: 5000, encoder: 'libopenh264', playable: true },
  { label: 'v-720x1280',  width: 720,  height: 1280, bitrateKbps: 2500, encoder: 'libopenh264', playable: true },
  { label: 'v-540x960',   width: 540,  height: 960,  bitrateKbps: 1200, encoder: 'libopenh264', playable: true },
  { label: 'v-360x640',   width: 360,  height: 640,  bitrateKbps: 500,  encoder: 'libopenh264', playable: true },
];
```

Upload masters are separate single-rendition jobs, e.g. `{ label: 'ig-reels-master', width: 1080, height: 1920, bitrateKbps: 9000, ... }`.

---

## 6. FFmpeg-oriented parameter examples

These examples ingest a browser-produced VP8/VP9 + Opus WebM. `-fflags +genpts`, CFR video, zero-based timestamps, and asynchronous audio resampling make the resulting H.264/AAC MP4 less sensitive to MediaRecorder pauses and timing irregularities. Exact flags in this repo’s C work-function differ (bitrate via `enc_ctx->bit_rate`, OpenH264 Main profile, etc.).

### 6.1 Upload master (YouTube 1080p SDR)

```bash
ffmpeg -fflags +genpts -i browser-recording.webm \
  -map 0:v:0 -map 0:a:0? \
  -vf "fps=30" -fps_mode cfr \
  -c:v libx264 -profile:v high -pix_fmt yuv420p \
  -b:v 8M -maxrate 8.5M -bufsize 16M \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -bf 2 -movflags +faststart \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -af "aresample=48000:async=1:first_pts=0" \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -avoid_negative_ts make_zero \
  yt-feed-master.mp4
```

The optional audio map allows a video-only browser recording. If the input contains multiple browser-generated audio tracks, mix them intentionally before AAC encoding rather than assuming the first track is complete.

### 6.2 Vertical master with center crop from a browser capture

```bash
ffmpeg -fflags +genpts -i browser-recording.webm \
  -map 0:v:0 -map 0:a:0? \
  -vf "fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
  -fps_mode cfr \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -b:v 9M \
  -g 60 -keyint_min 60 -movflags +faststart \
  -af "aresample=48000:async=1:first_pts=0" \
  -c:a aac -b:a 160k -ar 48000 -ac 2 \
  -avoid_negative_ts make_zero \
  ig-reels-master.mp4
```

Center crop is only a fallback. For screen recordings, it can remove important UI; a user-selected crop region or a designed background/pad layout is usually safer.

### 6.3 One ABR rung (HLS-friendly, 2 s GOP @ 30 fps)

```bash
ffmpeg -fflags +genpts -i browser-recording.webm \
  -map 0:v:0 -map 0:a:0? \
  -vf "fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" \
  -fps_mode cfr \
  -c:v libx264 -profile:v main -pix_fmt yuv420p -b:v 2500k \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -af "aresample=48000:async=1:first_pts=0" \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -avoid_negative_ts make_zero \
  -f mpegts abr-720p.ts
```

(Padding here is for a **playback ladder** that must fill a fixed canvas; upload masters should crop/reframe instead of padding whenever the platform would otherwise show black bars twice.)

---

## 7. Implementation readiness (this repository)

### 7.1 Output path already compatible

| Capability | Status |
| --- | --- |
| MP4 output | Yes (`do_transcode` / `mp4` muxer) |
| H.264 via OpenH264 | Yes (`libopenh264`, Main profile) |
| Optional x264 / SVT-AV1 / x265 | Yes (bake-off path) |
| YUV 4:2:0 | Yes (`AV_PIX_FMT_YUV420P`) |
| Bitrate-targeted ABR rungs | Yes (`bitrateKbps` in `RENDITIONS`) |
| Current demo ladder | 16:9 1080 / 720 / 480 / 240 @ 5 / 2.5 / 1.2 / 0.4 Mbps |
| OpenH264 resolution ceiling | 4096×2304 — all proposed masters/rungs fit |

The checked-in WASM build is **not yet compatible with the assumed browser input**. Although it enables the Matroska demuxer, [`build.sh`](../build.sh) does not enable VP8, VP9, or Opus decoders. In addition, [`ffmpeg-worker.js`](../ffmpeg-worker.js) writes slicer input to `/slicer-in.mp4`, and the current pipeline expects MP4/H.264-class input. A VP8/VP9 WebM recording therefore requires an ingest implementation; renaming the blob to `.mp4` does not convert it.

### 7.2 Gaps to close before a five-platform social demo

| Gap | Why it matters | Suggested direction |
| --- | --- | --- |
| VP8/VP9 decoders absent from WASM build | Browser-recorded video cannot currently be decoded | Enable FFmpeg’s native `vp8` and `vp9` decoders and parsers as required |
| Opus decoder absent from WASM build | Browser-recorded audio cannot currently become AAC | Enable the native `opus` decoder (and required parser); continue using the existing AAC encoder |
| Ingest/slicer assumes MP4 | MediaRecorder normally returns WebM | Detect the blob MIME/streams, use a `.webm` MEMFS path, and normalize before MPEG-TS chunk distribution |
| Browser VFR/timestamp handling not defined | Pauses and throttling can cause A/V drift or invalid segment timing | Generate/offset timestamps, force 30 fps output, and use async 48 kHz audio resampling |
| No crop/pad framing | Non-16:9 targets distort | Add intentional crop (masters) / optional pad (ladder canvases) before `sws_scale` |
| No explicit output FPS clamp | Meta/LinkedIn ads want ≤30 | FPS filter or drop frames when source &gt;30 |
| GOP not standardized per social profile | HLS + platform guidance want ~2 s | Pass `gop_size` from JS per profile (API already exists) |
| AAC often stream-copied | Masters may inherit odd rates/bitrates | Always re-encode AAC-LC to 48 kHz / 128–192 kbps for masters |
| Fast Start not guaranteed | YouTube/Meta prefer moov at front | Ensure `+faststart` / `movflags` on final MP4 assembly |
| HDR passthrough vs SDR masters | Social default should be SDR | Convert/tag BT.709 for social profiles; keep HDR path separate |
| Single 16:9 ladder UI | Need 4:5 and 9:16 ladders | Extend `RENDITIONS` with placement presets from §5 |

---

## 8. Reasoning summary

1. **Browser WebM is the source, not the cross-platform master.** Decode VP8/VP9 + Opus, normalize VFR timestamps and audio sync, then encode H.264/AAC MP4.
2. **One master per placement, not one master for all networks.** Aspect ratio is the dominant engagement factor (16:9 desktop, 4:5 feed, 9:16 full-screen). Codec consensus (H.264 + AAC MP4) lets us share an encode stack while varying geometry and bitrate.
3. **YouTube is bitrate-hungry; X is resolution-capped for most users; Meta is aspect-driven; LinkedIn is ad-constraint-driven.** Those four sentences explain most of the matrix in §4.
4. **Instagram and Facebook share masters** (4:5 + 9:16) to cut demo encode count without sacrificing placement fit.
5. **ABR ladders are a DCP showcase**, aligned with — but not identical to — upload masters. Platforms will ignore your ladder files and build their own; the demo still benefits from showing adaptive cost/quality locally.
6. **Stay inside OpenH264 and even dimensions** so the WASM worker can produce every recommended output without licensing or resolution failures.
7. **Prefer ad-safe LinkedIn settings** so organic and sponsored reuse the same file.
8. **Document sources and date-stamp** because social upload rules move faster than codecs do.

---

## 9. Source index

| Platform | Document | URL |
| --- | --- | --- |
| YouTube | Recommended upload encoding | https://support.google.com/youtube/answer/1722171 |
| YouTube | Resolution & aspect ratios | https://support.google.com/youtube/answer/6375112 |
| YouTube | Upload Shorts | https://support.google.com/youtube/answer/12779649 |
| YouTube | Shorts getting started | https://support.google.com/youtube/answer/10059070 |
| X | Media / API best practices | https://docs.x.com (media quickstart / best practices) |
| X | Product help (upload limits) | https://help.x.com |
| Meta | Instagram Feed ads design | https://www.facebook.com/business/help/430958953753149 |
| Meta | Instagram Stories ads design | https://www.facebook.com/business/help/2222978001316177 |
| Meta | Aspect ratio best practices | https://www.facebook.com/business/help/103816146375741 |
| Meta | Aspect ratios by placement | https://www.facebook.com/business/help/682655495435254 |
| Meta | Facebook Reels requirements | https://www.facebook.com/business/help/1197310377458196 |
| Meta | Facebook edited-video export settings | https://www.facebook.com/help/1041366099316573 |
| Instagram | Edits export quality note | https://help.instagram.com/553588510887194 |
| LinkedIn | Organic video requirements | https://www.linkedin.com/help/linkedin/answer/a548372 |
| LinkedIn | Page / Career video specs | https://www.linkedin.com/help/linkedin/answer/a1311816 |
| LinkedIn | Video ads specifications | https://www.linkedin.com/help/lms/answer/a424737 |

---

## 10. Changelog

| Date | Change |
| --- | --- |
| 2026-08-24 | Defined VP8/VP9 + Opus WebM browser input, ingest normalization, FFmpeg examples, and current WASM decoder gaps |
| 2026-08-24 | Initial guide: 10 upload masters, 3 shared ABR ladders with platform caps, DCP/FFmpeg notes |
