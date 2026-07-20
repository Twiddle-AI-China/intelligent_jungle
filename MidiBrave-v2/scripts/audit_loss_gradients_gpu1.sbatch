#!/usr/bin/env bash
#SBATCH --job-name=midibrave-loss-audit
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=00:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/loss-gradient-audit-%j.out
set -euo pipefail
config="${1:-configs/pipeline.yaml}"
output="${2:-/workspace/MidiBrave/artifacts/loss-gradient-audit-${SLURM_JOB_ID}.json}"
image_tag="${IMAGE_TAG:-midibrave:v0.4.0-loss-tuning}"
srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e HF_HOME=/data/model_weights/huggingface \
  -e TRANSFORMERS_OFFLINE=1 -e HF_HUB_OFFLINE=1 \
  "$image_tag" python scripts/audit_loss_gradients.py \
    --config "$config" --output "$output"
