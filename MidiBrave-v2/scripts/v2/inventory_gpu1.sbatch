#!/usr/bin/env bash
#SBATCH --job-name=mbv2-inventory
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=12G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/inventory-%j.out
set -euo pipefail
mkdir -p /home/jyhu/MidiBrave-v2/artifacts /data/midibrave-v2/{manifests,cache,runs,reports}
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=8g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  midibrave:v0.9.0-five-model-fp16 \
  midibrave select-timbres --config configs/v2/selection_octopus.yaml \
  --stage inventory --device cuda
