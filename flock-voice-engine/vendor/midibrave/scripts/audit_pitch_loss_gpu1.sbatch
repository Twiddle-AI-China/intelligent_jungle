#!/usr/bin/env bash
#SBATCH --job-name=midibrave-pitch-audit
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/pitch-audit-%j.out
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo "usage: sbatch audit_pitch_loss_gpu1.sbatch CONFIG OUTPUT" >&2
  exit 2
fi
config="$1"
output="$2"
srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e CONFIG="$config" -e OUTPUT="$output" \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  midibrave:v0.4.0-loss-tuning bash -lc \
  'python scripts/audit_pitch_objective.py --config "$CONFIG" --output "$OUTPUT"'

