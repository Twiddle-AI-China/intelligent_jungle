#!/usr/bin/env bash
set -euo pipefail

: "${DB_PATH:?Set DB_PATH to a qgpu-visible preprocessed RAVE database}"
: "${OUT_PATH:?Set OUT_PATH to a qgpu-visible checkpoint directory}"
: "${BRAVE_REPO:?Set BRAVE_REPO to a checkout of https://github.com/fcaspe/BRAVE}"
RUN_NAME="${RUN_NAME:-latent_cosmos_brave_pitch_v1}"
PILOT_REPEATS="${PILOT_REPEATS:-16}"
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
export UV_DEFAULT_INDEX="${UV_DEFAULT_INDEX:-https://mirrors.aliyun.com/pypi/simple}"

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
if [[ -n "${PILOT_MANIFEST:-}" ]]; then
  args+=(--pilot_manifest "$PILOT_MANIFEST" --pilot_repeats "$PILOT_REPEATS")
fi
if [[ -n "${BOOTSTRAP_BRAVE_CHECKPOINT:-}" ]]; then
  args+=(--bootstrap_brave_checkpoint "$BOOTSTRAP_BRAVE_CHECKPOINT")
fi
if [[ -n "${INITIAL_CONDITIONED_CHECKPOINT:-}" ]]; then
  args+=(--initial_conditioned_checkpoint "$INITIAL_CONDITIONED_CHECKPOINT")
fi
if [[ "${PITCH_SWAP:-0}" == "1" ]]; then args+=(--pitch_swap); fi
if [[ "${FREEZE_ENCODER:-0}" == "1" ]]; then args+=(--freeze_encoder); fi
if [[ -n "${PILOT_PRESET_INDICES:-}" ]]; then
  args+=(--pilot_preset_indices "$PILOT_PRESET_INDICES")
fi
if [[ -n "${PILOT_PRESET_WEIGHTS:-}" ]]; then
  args+=(--pilot_preset_weights "$PILOT_PRESET_WEIGHTS")
fi
if [[ "${PITCH_ADVERSARY:-0}" == "1" ]]; then args+=(--pitch_adversary); fi
if [[ -n "${PITCH_ADVERSARY_WEIGHT:-}" ]]; then
  args+=(--pitch_adversary_weight "$PITCH_ADVERSARY_WEIGHT")
fi
if [[ -n "${PITCH_ADVERSARY_GRL_SCALE:-}" ]]; then
  args+=(--pitch_adversary_grl_scale "$PITCH_ADVERSARY_GRL_SCALE")
fi
if [[ -n "${PITCH_ADVERSARY_WARMUP_BATCHES:-}" ]]; then
  args+=(--pitch_adversary_warmup_batches "$PITCH_ADVERSARY_WARMUP_BATCHES")
fi
if [[ -n "${PITCH_ADVERSARY_UPDATES_PER_BATCH:-}" ]]; then
  args+=(--pitch_adversary_updates_per_batch "$PITCH_ADVERSARY_UPDATES_PER_BATCH")
fi
if [[ -n "${ENCODER_TAIL_MODULES:-}" ]]; then
  args+=(--encoder_tail_modules "$ENCODER_TAIL_MODULES")
fi
if [[ -n "${LATENT_PITCH_CONSISTENCY_WEIGHT:-}" ]]; then
  args+=(--latent_pitch_consistency_weight "$LATENT_PITCH_CONSISTENCY_WEIGHT")
fi
if [[ "${SMOKE_TEST:-0}" == "1" ]]; then args+=(--smoke_test); fi
# --extra analysis: the pilot dataset measures pYIN periodicity labels
# (pitch-conditioning-v2) on cache misses.
uv run --extra rave --extra analysis python "$SCRIPT_DIR/train_pitch.py" "${args[@]}"
