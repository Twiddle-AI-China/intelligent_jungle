#!/usr/bin/env bash
set -euo pipefail

: "${CORPUS_PATH:?Set CORPUS_PATH to the directory containing mono WAV files}"
: "${DB_PATH:?Set DB_PATH to the output database path}"
SAMPLE_RATE="${SAMPLE_RATE:-44100}"

if [[ -z "${CUDA_VISIBLE_DEVICES:-}" ]]; then
  echo "Run preprocessing inside qgpu for a reproducible environment." >&2
  exit 2
fi

paths="$(uv run static_ffmpeg_paths)"
ffmpeg_path="$(printf '%s\n' "$paths" | sed -n 's/^FFMPEG=//p')"
ffprobe_path="$(printf '%s\n' "$paths" | sed -n 's/^FFPROBE=//p')"
if [[ ! -x "$ffmpeg_path" || ! -x "$ffprobe_path" ]]; then
  echo "RAVE preprocessing requires executable ffmpeg and ffprobe." >&2
  exit 3
fi
export PATH="$(dirname "$ffmpeg_path"):$PATH"
ffmpeg -version >/dev/null
ffprobe -version >/dev/null

uv run rave preprocess \
  --input_path "$CORPUS_PATH" \
  --output_path "$DB_PATH" \
  --channels 1 \
  --sampling_rate "$SAMPLE_RATE"
