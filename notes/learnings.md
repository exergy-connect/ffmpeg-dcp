# xFrame social transcoder — learnings

**Recorded:** 26 August 2026  
**Scope:** Issues hit while ingesting a VP9-in-MP4 clip, remuxing DCP segments, rebuilding WASM, and publishing the DCP package. This is operational memory for this repo, not a platform encoding guide (see [`social-media-transcoding-guide.md`](social-media-transcoding-guide.md)).

## 8. Publishing the DCP WASM package

### 8.1 Bundle vs source of truth

`xframe/package/ffmpeg-wasm.js` is **gitignored**, produced by `node package/build-bravojs-bundle.js`. It embeds `dcp-transcode.wasm` as base64. Confirm it is current by comparing that blob to `xframe/ffmpeg-wasm/dcp-transcode.wasm` (byte-identical after a matching build).

### 8.2 `deployPackage` is create-once per name — no client update API

`dcp/publish` exports only **`publish`**, which calls package-manager RPC **`deployPackage`**. No `updatePackage` / `replacePackage` / `undeployPackage` on any `dcp/*` module.

Republishing `ffmpeg-wasm-social` (even as `0.1.1`) failed with:

`Unable to publish DCP package 'ffmpeg-wasm-social'`  
`code: NAMECONFLICT`  
`process: package-manager`

Version is in the payload; the **name** still conflicts. The same identity successfully published a **new name**: **`ffmpeg-dcp-social@0.1.1`**.

Jobs must `require(['ffmpeg-dcp-social/ffmpeg-wasm.js'])`. Staged `output/` HTML still has the old name until recompiled.
