#!/usr/bin/env bash
#SBATCH --job-name=midibrave-build-nan-fix
#SBATCH --partition=gpu1
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=12
#SBATCH --mem=15G
#SBATCH --time=1:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/build-nan-fix-%j.out

set -euo pipefail

cd /home/jyhu/MidiBrave
mkdir -p artifacts

srun --kill-on-bad-exit=1 docker build --pull=false \
  -f Dockerfile.phase1-autotune \
  -t midibrave:v0.8.6-nan-fix .

srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" \
  --shm-size=16g \
  -v /data:/data \
  -w /workspace/MidiBrave \
  midibrave:v0.8.6-nan-fix \
  python -m pytest -q

srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" \
  --shm-size=16g \
  -v /data:/data \
  -w /workspace/MidiBrave \
  midibrave:v0.8.6-nan-fix \
  python -m pytest -q tests/test_crepe_gpu.py
