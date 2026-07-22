#!/usr/bin/env bash
#SBATCH --job-name=midibrave-disc-bench
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=00:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/discriminator-benchmark-%j.out
set -euo pipefail
srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  midibrave:v0.2.1-serum python scripts/benchmark_discriminators.py \
    --batch 2 --samples 65536 --warmup 5 --iterations 20
