#!/usr/bin/env bash
set -euo pipefail

: "${DB_PATH:?Set DB_PATH to a qgpu-visible preprocessed RAVE database}"
: "${OUT_PATH:?Set OUT_PATH to a qgpu-visible checkpoint directory}"
: "${BRAVE_REPO:?Set BRAVE_REPO to a checkout of https://github.com/fcaspe/BRAVE}"
RUN_NAME="${RUN_NAME:-latent_cosmos_brave_pitch_v1}"
if [[ "${SMOKE_TEST:-0}" == "1" ]]; then
  MAX_STEPS="${MAX_STEPS:-2}"
  # Validate every step so the smoke run exercises best.ckpt saving; the
  # default 10000 postpones validation past the smoke budget entirely.
  VAL_EVERY="${VAL_EVERY:-2}"
else
  MAX_STEPS="${MAX_STEPS:-6000000}"
  VAL_EVERY="${VAL_EVERY:-10000}"
fi

if [[ -z "${CUDA_VISIBLE_DEVICES:-}" ]]; then
  echo "Refusing to train outside the qgpu allocation (CUDA_VISIBLE_DEVICES is unset)." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

args=(
  --config "$BRAVE_REPO/configs/brave.gin"
  --config "$SCRIPT_DIR/../configs/brave_pitch.gin"
  --name "$RUN_NAME"
  --db_path "$DB_PATH"
  --out_path "$OUT_PATH"
  --gpu 0
  --channels 1
  --batch 8
  --val_every "$VAL_EVERY"
  --max_steps "$MAX_STEPS")
if [[ "${SMOKE_TEST:-0}" == "1" ]]; then args+=(--smoke_test); fi
uv run python "$SCRIPT_DIR/train_pitch.py" "${args[@]}"
