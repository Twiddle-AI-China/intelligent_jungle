#!/usr/bin/env bash
#SBATCH --job-name=midibrave-loss-build
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=01:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/loss-build-%j.out
set -euo pipefail
mkdir -p /home/jyhu/MidiBrave/artifacts
image_tag="${IMAGE_TAG:-midibrave:v0.4.0-loss-tuning}"

srun bash -lc "
  set -euo pipefail
  cd /home/jyhu/MidiBrave
  docker build --pull=false -t '$image_tag' .
"

srun docker run --rm --shm-size=4g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  "$image_tag" python -m pytest -q

srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  "$image_tag" python -m pytest -q tests/test_crepe_gpu.py
