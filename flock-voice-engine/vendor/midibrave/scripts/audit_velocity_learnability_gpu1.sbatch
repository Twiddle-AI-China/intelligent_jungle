#!/usr/bin/env bash
#SBATCH --job-name=midibrave-velocity-learnability
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=30G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/velocity-learnability-%j.out
set -euo pipefail
config="${1:?config is required}"
checkpoint="${2:?checkpoint is required}"
output="${3:?output is required}"
image_tag="${IMAGE_TAG:-midibrave:v0.7.0-condition-gain}"
srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -e PYTHONPATH=/workspace/MidiBrave/src \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  "$image_tag" python scripts/audit_velocity_learnability.py \
    --config "$config" --checkpoint "$checkpoint" --output "$output" \
    --train-pairs 16384 --validation-active-pairs 64 \
    --steps 5000 --batch-size 256 --seeds 3 --raw-hidden 256
