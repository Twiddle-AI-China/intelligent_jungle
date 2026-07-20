#!/usr/bin/env bash
#SBATCH --job-name=midibrave-velocity-audit
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/velocity-identifiability-%j.out
set -euo pipefail
config="${1:-artifacts/r3_configs/loss_tune_r1_c11.yaml}"
output="${2:-/workspace/MidiBrave/artifacts/velocity-identifiability-${SLURM_JOB_ID}.json}"
image_tag="${IMAGE_TAG:-midibrave:v0.5.0-velocity-delta}"
srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  "$image_tag" python scripts/audit_velocity_identifiability.py \
    --config "$config" --output "$output" --pairs 64 --draws-per-pair 4096
