#!/usr/bin/env bash
#SBATCH --job-name=midibrave-atomic8
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=00:10:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/atomic8-%j.out
set -euo pipefail
srun docker run --rm --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  midibrave:v0.2.1-serum \
  torchrun --standalone --nproc_per_node=8 scripts/test_ddp_atomic_step.py
