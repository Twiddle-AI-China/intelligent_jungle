#!/usr/bin/env bash
#SBATCH --job-name=midibrave-loss-gate
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=04:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/loss-gate-%j.out
set -euo pipefail

if [[ $# -lt 5 || $# -gt 9 ]]; then
  echo "usage: sbatch evaluate_gate_short_gpu1.sbatch CONFIG CHECKPOINT OUTPUT CANDIDATE STAGE [BASELINE_METRICS] [PRIOR_METRICS] [PAIRS] [VELOCITY_PAIRS]" >&2
  exit 2
fi
config="$1"
checkpoint="$2"
output="$3"
candidate="$4"
stage="$5"
baseline="${6:-}"
prior="${7:-}"
pairs="${8:-128}"
velocity_pairs="${9:-64}"
image_tag="${IMAGE_TAG:-midibrave:v0.4.0-loss-tuning}"
training_log="/data/midibrave/loss_tuning/loss_tune_r1_${candidate}/phase1/metrics.jsonl"

srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e CONFIG="$config" -e CHECKPOINT="$checkpoint" -e OUTPUT="$output" \
  -e CANDIDATE="$candidate" -e STAGE="$stage" \
  -e BASELINE="$baseline" -e PRIOR="$prior" \
  -e TRAINING_LOG="$training_log" \
  -e PAIRS="$pairs" -e VELOCITY_PAIRS="$velocity_pairs" \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  "$image_tag" bash -lc '
    set -euo pipefail
    python -m midibrave.evaluate --config "$CONFIG" --checkpoint "$CHECKPOINT" \
      --output "$OUTPUT" --pairs "$PAIRS" --batch-size 2 --examples 12 \
      --grid-presets 2 --velocity-pairs "$VELOCITY_PAIRS"
    gate_args=(
      --stage "$STAGE"
      --metrics "$OUTPUT/metrics.json"
      --output "$OUTPUT/gate-$STAGE.json"
      --candidate "$CANDIDATE"
      --training-log "$TRAINING_LOG"
      --soft-fail
    )
    if [[ -n "$BASELINE" ]]; then
      gate_args+=(--baseline "$BASELINE")
    fi
    if [[ -n "$PRIOR" ]]; then
      gate_args+=(--prior "$PRIOR")
    fi
    python scripts/check_short_quality_gate.py "${gate_args[@]}"
  '
