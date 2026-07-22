#!/usr/bin/env bash
#SBATCH --job-name=midibrave-smoke8
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=00:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/slurm-%j.out
set -euo pipefail
mkdir -p /home/jyhu/MidiBrave/artifacts
srun docker run --rm --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e NCCL_DEBUG=WARN -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 midibrave:v0.1 \
  bash -lc 'midibrave fixture --root fixtures/generated && torchrun --standalone --nproc_per_node=8 -m midibrave.trainer --config configs/smoke.yaml --phase 1 --max-steps 3 && torchrun --standalone --nproc_per_node=8 -m midibrave.trainer --config configs/smoke.yaml --phase 2 --max-steps 3 --resume artifacts/smoke/smoke/phase1/step-000000003.pt'
