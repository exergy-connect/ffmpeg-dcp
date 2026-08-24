#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${1:-${SCRIPT_DIR}/dist}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker is required to build FFmpeg WASM." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Error: the Docker daemon is not running." >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"

docker build \
  --file "${SCRIPT_DIR}/Dockerfile" \
  --target export \
  --output "type=local,dest=${OUTPUT_DIR}" \
  "${REPO_ROOT}"

test -s "${OUTPUT_DIR}/dcp-transcode-glue.js"
test -s "${OUTPUT_DIR}/dcp-transcode.wasm"

echo "Built ${OUTPUT_DIR}/dcp-transcode-glue.js"
echo "Built ${OUTPUT_DIR}/dcp-transcode.wasm"
ls -la "${OUTPUT_DIR}"

cp -f "${OUTPUT_DIR}/dcp-transcode-glue.js" "${SCRIPT_DIR}/dcp-transcode-glue.js"
cp -f "${OUTPUT_DIR}/dcp-transcode.wasm" "${SCRIPT_DIR}/dcp-transcode.wasm"
echo "Synced ${SCRIPT_DIR}/"
