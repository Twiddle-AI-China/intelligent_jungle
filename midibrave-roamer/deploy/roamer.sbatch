#!/usr/bin/env bash
#SBATCH --job-name=midibrave-roamer
# Spark 当前未启用 AccountingStorage；显式 --account 会导致 InvalidAccount。
#SBATCH --partition=gpu
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --output=midibrave-roamer-%j.log

set -euo pipefail

: "${CUDA_VISIBLE_DEVICES:?This service must run inside a SLURM GPU allocation}"
: "${MIDIBRAVE_ROAMER_ROOT:?Set MIDIBRAVE_ROAMER_ROOT to the real checkout path on Spark}"
: "${MIDIBRAVE_VENDOR_ROOT:?Set MIDIBRAVE_VENDOR_ROOT to a verified vendor snapshot directory}"
: "${MIDIBRAVE_MODEL_ROOT:?Set MIDIBRAVE_MODEL_ROOT to the verified checkpoint directory}"
: "${MIDIBRAVE_CALIBRATION_ROOT:?Set MIDIBRAVE_CALIBRATION_ROOT to the voice_defaults directory}"

image="${MIDIBRAVE_ROAMER_IMAGE:-midibrave-roamer:local}"
port="${MIDIBRAVE_ROAMER_PORT:-8092}"
container="midibrave-roamer-${SLURM_JOB_ID}"

exec docker run --rm \
  --name "$container" \
  --gpus all \
  --network host \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  -v "$MIDIBRAVE_VENDOR_ROOT:/app/flock-voice-engine/vendor:ro" \
  -v "$MIDIBRAVE_MODEL_ROOT:/data/model_weights/midiBrave:ro" \
  -v "$MIDIBRAVE_CALIBRATION_ROOT:/app/flock-voice-engine/assets/timbre/voice_defaults:ro" \
  "$image" \
  --backend neural --host 0.0.0.0 --port "$port" --skip-assemble
