#!/usr/bin/env bash
# Compile dcp-transcoding.xp → output/dcp-transcoding.json + .html
set -euo pipefail
cd "$(dirname "$0")/.."
XFORM="${XFORM:-../.cursor/skills/xform-run/scripts/xform.min.js}"
node "$XFORM" dcp-transcoding.xp
node scripts/build-html.js
echo "Open via: cd output && python3 -m http.server 8765"
