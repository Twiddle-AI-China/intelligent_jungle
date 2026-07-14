#!/usr/bin/env bash
set -euo pipefail

: "${RUN_DIR:?Set RUN_DIR to a completed RAVE/BRAVE version directory}"
REPORT_PATH="${REPORT_PATH:-../reports/checkpoint-export.txt}"
EXPORT_DIR="${EXPORT_DIR:-$RUN_DIR/exports}"

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

mkdir -p "$(dirname "$REPORT_PATH")" "$EXPORT_DIR"
: > "$REPORT_PATH"
run_name="$(basename "$(dirname "$RUN_DIR")")"
for entry in "best:$best" "latest:$latest"; do
  label="${entry%%:*}"
  checkpoint="${entry#*:}"
  if [[ "$label" == latest && "$checkpoint" == "$best" ]]; then continue; fi
  printf '%s\n' "$checkpoint" >> "$REPORT_PATH"
  sha256sum "$checkpoint" >> "$REPORT_PATH"
  for mode in offline streaming; do
    name="${run_name}_${label}_${mode}"
    args=(rave export --run "$checkpoint" --output "$EXPORT_DIR" --name "$name")
    if [[ "$mode" == streaming ]]; then args+=(--streaming); fi
    uv run "${args[@]}"
    artifact="$EXPORT_DIR/$name.ts"
    if [[ ! -f "$artifact" ]]; then
      echo "Expected export artifact missing: $artifact" >&2
      exit 4
    fi
    sha256sum "$artifact" >> "$REPORT_PATH"
  done
done

command find "$EXPORT_DIR" -maxdepth 1 -type f -name '*.ts' -print -exec sha256sum {} \; >> "$REPORT_PATH"
printf 'export_report=%s\n' "$REPORT_PATH"
