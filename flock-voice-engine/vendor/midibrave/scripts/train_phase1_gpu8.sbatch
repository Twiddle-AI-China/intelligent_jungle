#!/usr/bin/env bash
#SBATCH --job-name=midibrave-p1
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=7-00:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/phase1-%j.out
set -euo pipefail
mkdir -p /home/jyhu/MidiBrave/artifacts
srun docker run --rm --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e NCCL_DEBUG=WARN -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
  midibrave:v0.1 torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
  --config configs/base.yaml --phase 1
