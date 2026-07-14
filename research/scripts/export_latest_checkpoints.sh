#!/usr/bin/env bash
set -euo pipefail

: "${RUN_DIR:?Set RUN_DIR to a completed RAVE/BRAVE version directory}"
REPORT_PATH="${REPORT_PATH:-../reports/checkpoint-export.txt}"

if [[ -z "${CUDA_VISIBLE_DEVICES:-}" ]]; then
  echo "Run model export inside qgpu so the environment matches training." >&2
  exit 2
fi

checkpoint_dir="$RUN_DIR/checkpoints"
best="$checkpoint_dir/best.ckpt"
latest="$(command ls -1t "$checkpoint_dir"/*.ckpt 2>/dev/null | head -n 1 || true)"
if [[ ! -f "$best" || -z "$latest" ]]; then
  echo "Expected best.ckpt and at least one checkpoint in $checkpoint_dir" >&2
  exit 3
fi

mkdir -p "$(dirname "$REPORT_PATH")"
: > "$REPORT_PATH"
for checkpoint in "$best" "$latest"; do
  if command grep -Fxq "$checkpoint" "$REPORT_PATH" 2>/dev/null; then continue; fi
  printf '%s\n' "$checkpoint" >> "$REPORT_PATH"
  sha256sum "$checkpoint" >> "$REPORT_PATH"
  uv run rave export --run "$checkpoint"
done

command find "$checkpoint_dir" -maxdepth 1 -type f -name '*.ts' -print -exec sha256sum {} \; >> "$REPORT_PATH"
printf 'export_report=%s\n' "$REPORT_PATH"
