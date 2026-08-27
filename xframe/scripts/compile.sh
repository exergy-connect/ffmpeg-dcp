#!/usr/bin/env bash
# Compile dcp-transcoding.xp + worker.xp → output/*.json + .html
set -euo pipefail
cd "$(dirname "$0")/.."
XFORM="${XFORM:-../.cursor/skills/xform-run/scripts/xform.min.js}"
node "$XFORM" dcp-transcoding.xp --tree --final html
node scripts/build-html.js dcp-transcoding
node "$XFORM" worker.xp --tree --final html
node scripts/build-html.js worker
echo "Open via: cd output && python3 -m http.server 8765"
echo "  transcoder: http://127.0.0.1:8765/dcp-transcoding.html"
echo "  worker:     http://127.0.0.1:8765/worker.html"
