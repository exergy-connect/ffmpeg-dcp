# Drop test .mp4 uploads here.

Pushing a file matching `xframe/uploads/*.mp4` or `xframe/uploads/**/*.mp4`
triggers the
[Self-hosted runner test](../../.github/workflows/self-hosted-runner-test.yml)
workflow. The job passes `VIDEO_PATH` and `VIDEO_URL` to the self-hosted runner.
