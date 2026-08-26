# Drop test .mp4 uploads here.

Pushing a file matching `xframe/uploads/*.mp4` or `xframe/uploads/**/*.mp4`
triggers the
[Self-hosted runner test](../../.github/workflows/self-hosted-runner-test.yml)
workflow. A GitHub-hosted job resolves the raw GitHub URL; the self-hosted
runner job receives only `VIDEO_URL`.
