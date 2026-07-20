#!/usr/bin/env bash
#SBATCH --job-name=mbv2-tests
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=12G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/tests-%j.out
set -euo pipefail
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=8g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  midibrave:v0.9.0-five-model-fp16 python -m pytest -q tests
