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

## 8.3 Module path has no `@version` — use a new package name

`job.requires(['ffmpeg-dcp-social@0.1.3/ffmpeg-wasm.js'])` makes the package
manager look for `/packages/ffmpeg-dcp-social@0.1.3/package.dcp` and fails with
`fetchModuleURL` / ENOENT. Version lives only in `package.dcp`; the require
path is always `name/file.js`.

When fleet workers must load a new WASM (e.g. `extract_time_range`), publish
under a **new name** (e.g. `ffmpeg-dcp-social-v2`) and update `app.dcp_package`.

## 9. dcpGhRunner browser GitHub runner (CORS)

**Recorded:** 27 August 2026

| Endpoint | Browser from GitHub Pages | DCP worker sandbox | Notes |
| --- | --- | --- | --- |
| `api.github.com` | Works with `Authorization` | Works | Already used for Contents API + workflow dispatch |
| Actions broker (`*.actions.githubusercontent.com` or regional host from JIT config) | Often **blocked by CORS** | Unknown — may behave like browser or like server | JIT listener uses long-poll `GET /message` |
| Run-service acquire/complete URLs | Same as broker | Same | Returned in job reference body |
| `api.linkedin.com/rest` | Often **blocked** for POST | Unknown | Direct LinkedIn path may fail from Pages |
| LinkedIn multipart `uploadUrl` (Azure/blob) | Usually **works** (PUT, no api.linkedin.com) | Works | Part bytes uploaded to pre-signed URL |

**Mitigation:** `dcp-gh-runner` implements both LinkedIn paths — direct API when token+URN provided, else GitHub commit of MP4 + `xframe/posts/linkedin/*.json` + `post-to-linkedin.yml` dispatch (no LinkedIn token in worker).

Require path: `dcp-gh-runner/dcpGhRunner.js` (same rule as §8.3 — no `@version` in the path). **No `deployPackage` step needed** for this bundle: `job.requires(['dcp-gh-runner/dcpGhRunner.js'])` attaches the package to the slice. Use `scripts/publish.js` only for optional global registration. The ~8 MB ffmpeg WASM package may still be published once under `ffmpeg-dcp-social-v2` if workers should reuse it across jobs without re-attaching.
