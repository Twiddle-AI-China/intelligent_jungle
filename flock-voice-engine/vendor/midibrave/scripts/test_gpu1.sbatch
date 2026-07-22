#!/usr/bin/env bash
#SBATCH --job-name=midibrave-test1
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --gres=gpu:1
#SBATCH --mem=8G
#SBATCH --time=00:10:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/test-gpu-%j.out
set -euo pipefail
srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave midibrave:v0.2.1-serum \
  pytest -q tests/test_crepe_gpu.py
