#!/usr/bin/env bash
#SBATCH --job-name=mbv2-select
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=12:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/select-%j.out
set -euo pipefail
mkdir -p /home/jyhu/MidiBrave-v2/artifacts /data/midibrave-v2/{manifests,cache,runs,reports}
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  -e HF_HOME=/data/model_weights/huggingface \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
  midibrave:v0.9.0-five-model-fp16 \
  midibrave select-timbres --config configs/v2/selection_octopus.yaml --stage all --device cuda
