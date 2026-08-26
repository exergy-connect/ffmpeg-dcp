#!/usr/bin/env bash
# Copy the published present and html2mp4 CLIs and YANG models into this skill.
#
# Usage: install.sh <action-dir> [skill-dest]
#   action-dir  Directory with present.min.js, html2mp4.min.js, and model/*.yang
#               (xFrame.ai: actions/present; this repo: action-dist)
#   skill-dest  Installed skill root (defaults to this script's directory)

set -euo pipefail

action_dir=${1:?usage: install.sh <action-dir> [skill-dest]}
skill_dest=${2:-$(cd "$(dirname "$0")" && pwd)}

cli="$action_dir/present.min.js"
video_cli="$action_dir/html2mp4.min.js"
model_src="$action_dir/model"

if [ ! -f "$cli" ]; then
  echo "present action bundle missing at $cli" >&2
  exit 1
fi
if [ ! -f "$video_cli" ]; then
  echo "html2mp4 bundle missing at $video_cli" >&2
  exit 1
fi
if [ ! -d "$model_src" ]; then
  echo "present YANG models missing at $model_src" >&2
  exit 1
fi

scripts="$skill_dest/scripts"
model_dest="$skill_dest/model"
mkdir -p "$scripts" "$model_dest"

cp "$cli" "$scripts/present.min.js"
cp "$video_cli" "$scripts/html2mp4.min.js"
if [ -f "$action_dir/package.json" ]; then
  cp "$action_dir/package.json" "$scripts/package.json"
fi

rm -f "$model_dest"/*.yang
cp "$model_src"/*.yang "$model_dest/"

echo "Installed: xframe-present and html2mp4 CLIs and YANG models"
