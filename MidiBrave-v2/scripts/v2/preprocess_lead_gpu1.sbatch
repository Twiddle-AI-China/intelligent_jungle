#!/usr/bin/env bash
#SBATCH --job-name=mbv2-cache-lead
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=12:00:00
#SBATCH --array=0-1
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/cache-lead-%A_%a.out
set -euo pipefail
config=configs/v2/generated/lead_safe_fallback.yaml
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  -e HF_HOME=/data/model_weights/huggingface \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
  midibrave:v0.9.0-five-model-fp16 bash -lc \
  "midibrave preprocess --config $config --stage all --device cuda --shard-index ${SLURM_ARRAY_TASK_ID} --shard-count 2"
