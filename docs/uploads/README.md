# Browser uploads for GitHub transcode

The **Transcode via GitHub** button in the DCP Social Media Transcoder uploads
recordings here via the GitHub Contents API, then triggers
[Self-hosted runner test](../.github/workflows/self-hosted-runner-test.yml).

Files are written to `docs/uploads/` on the default branch (`main`). The
workflow resolves a raw GitHub URL and passes it to the self-hosted
`process-video` job as `VIDEO_URL`.
