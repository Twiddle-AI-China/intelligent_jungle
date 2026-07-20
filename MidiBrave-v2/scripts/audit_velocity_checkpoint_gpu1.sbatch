#!/usr/bin/env bash
#SBATCH --job-name=midibrave-velocity-checkpoint-audit
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=00:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/velocity-checkpoint-audit-%j.out
set -euo pipefail
config="${1:?config is required}"
checkpoint="${2:?checkpoint is required}"
output="${3:-/workspace/MidiBrave/artifacts/velocity-checkpoint-audit-${SLURM_JOB_ID}.json}"
image_tag="${IMAGE_TAG:-midibrave:v0.6.0-velocity-reference}"
srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -e PYTHONPATH=/workspace/MidiBrave/src \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  "$image_tag" python scripts/audit_velocity_checkpoint.py \
    --config "$config" --checkpoint "$checkpoint" --output "$output" \
    --pairs 64 --batch-size 8
