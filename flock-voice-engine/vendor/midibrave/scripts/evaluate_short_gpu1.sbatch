#!/usr/bin/env bash
#SBATCH --job-name=midibrave-loss-eval
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=04:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/loss-eval-%j.out
set -euo pipefail
if [[ $# -lt 3 || $# -gt 7 ]]; then
  echo "usage: sbatch evaluate_short_gpu1.sbatch CONFIG CHECKPOINT OUTPUT [PAIRS] [EXAMPLES] [GRID_PRESETS] [VELOCITY_PAIRS]" >&2
  exit 2
fi
config="$1"
checkpoint="$2"
output="$3"
pairs="${4:-128}"
examples="${5:-12}"
grid_presets="${6:-2}"
velocity_pairs="${7:-64}"
srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e CONFIG="$config" -e CHECKPOINT="$checkpoint" -e OUTPUT="$output" \
  -e PAIRS="$pairs" -e EXAMPLES="$examples" -e GRID_PRESETS="$grid_presets" \
  -e VELOCITY_PAIRS="$velocity_pairs" \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  midibrave:v0.4.0-loss-tuning bash -lc '
    python -m midibrave.evaluate --config "$CONFIG" --checkpoint "$CHECKPOINT" \
      --output "$OUTPUT" --pairs "$PAIRS" --batch-size 2 --examples "$EXAMPLES" \
      --grid-presets "$GRID_PRESETS" --velocity-pairs "$VELOCITY_PAIRS"
  '

