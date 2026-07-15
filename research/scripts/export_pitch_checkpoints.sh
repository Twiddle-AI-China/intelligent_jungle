#!/usr/bin/env bash
set -euo pipefail

: "${RUN_DIR:?Set RUN_DIR to a pitch-conditioned BRAVE version directory}"
REPORT_PATH="${REPORT_PATH:-../reports/pitch-checkpoint-export.txt}"
EXPORT_DIR="${EXPORT_DIR:-$RUN_DIR/exports}"
LATENT_SIZE="${LATENT_SIZE:-}"

if [[ -z "${CUDA_VISIBLE_DEVICES:-}" ]]; then
  echo "Run model export inside qgpu so the environment matches training." >&2
  exit 2
fi

checkpoint_dir="$RUN_DIR/checkpoints"
best="$checkpoint_dir/best.ckpt"
if [[ ! -f "$best" ]]; then
  echo "Expected best.ckpt in $checkpoint_dir" >&2
  exit 3
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$(dirname "$REPORT_PATH")" "$EXPORT_DIR"
: > "$REPORT_PATH"
run_name="$(basename "$(dirname "$RUN_DIR")")"

printf '%s\n' "$best" >> "$REPORT_PATH"
sha256sum "$best" >> "$REPORT_PATH"
for mode in offline streaming; do
  name="${run_name}_best_pitch"
  args=(--run "$best" --output "$EXPORT_DIR" --name "$name")
  if [[ -n "$LATENT_SIZE" ]]; then args+=(--latent-size "$LATENT_SIZE"); fi
  if [[ "$mode" == streaming ]]; then
    args+=(--streaming)
    artifact="$EXPORT_DIR/${name}_streaming.ts"
  else
    artifact="$EXPORT_DIR/$name.ts"
  fi
  uv run python "$SCRIPT_DIR/export_pitch_conditioned.py" "${args[@]}"
  if [[ ! -f "$artifact" ]]; then
    echo "Expected export artifact missing: $artifact" >&2
    exit 4
  fi
  sha256sum "$artifact" >> "$REPORT_PATH"
done

printf 'export_report=%s\n' "$REPORT_PATH"
