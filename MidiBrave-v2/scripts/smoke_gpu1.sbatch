#!/usr/bin/env bash
#SBATCH --job-name=midibrave-smoke1
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=00:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/slurm-%j.out
set -euo pipefail
mkdir -p /home/jyhu/MidiBrave/artifacts
srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave midibrave:v0.1 \
  bash -lc 'midibrave fixture --root fixtures/generated && python -m midibrave.trainer --config configs/smoke.yaml --phase 1 --max-steps 3 && python -m midibrave.trainer --config configs/smoke.yaml --phase 2 --max-steps 3 --resume artifacts/smoke/smoke/phase1/step-000000003.pt'
