#!/usr/bin/env bash
set -euo pipefail

: "${DB_PATH:?Set DB_PATH to a qgpu-visible preprocessed RAVE database}"
: "${OUT_PATH:?Set OUT_PATH to a qgpu-visible checkpoint directory}"
RUN_NAME="${RUN_NAME:-latent_cosmos_rave_v1}"
if [[ "${SMOKE_TEST:-0}" == "1" ]]; then MAX_STEPS="${MAX_STEPS:-2}"; else MAX_STEPS="${MAX_STEPS:-6000000}"; fi

if [[ -z "${CUDA_VISIBLE_DEVICES:-}" ]]; then
  echo "Refusing to train outside the qgpu allocation (CUDA_VISIBLE_DEVICES is unset)." >&2
  exit 2
fi

args=(train
  --config v2
  --config causal
  --name "$RUN_NAME"
  --db_path "$DB_PATH"
  --out_path "$OUT_PATH"
  --gpu 0
  --channels 1
  --batch 8
  --max_steps "$MAX_STEPS")
if [[ "${SMOKE_TEST:-0}" == "1" ]]; then args+=(--smoke_test); fi
uv run rave "${args[@]}"
