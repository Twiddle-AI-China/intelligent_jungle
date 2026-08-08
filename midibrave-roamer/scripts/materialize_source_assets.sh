#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
source_ref="${MIDIBRAVE_SOURCE_REF:-standalone-release}"
output="${1:-$repo_root/midibrave-roamer/runtime/assets}"
temp_root="$(mktemp -d)"
trap 'rm -rf "$temp_root"' EXIT

git -C "$repo_root" archive "$source_ref" \
  flock-voice-engine/vendor/midibrave-v2 \
  flock-voice-engine/vendor/trajectorybrave \
  flock-voice-engine/assets/timbre/voice_defaults \
  | tar -x -C "$temp_root"

mkdir -p "$output/vendor" "$output/calibration"
cp -R "$temp_root/flock-voice-engine/vendor/midibrave-v2" "$output/vendor/"
cp -R "$temp_root/flock-voice-engine/vendor/trajectorybrave" "$output/vendor/"
cp -R "$temp_root/flock-voice-engine/assets/timbre/voice_defaults/." "$output/calibration/"

printf 'vendor=%s\ncalibration=%s\n' "$output/vendor" "$output/calibration"
