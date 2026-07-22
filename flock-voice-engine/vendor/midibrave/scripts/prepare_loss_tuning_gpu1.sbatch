#!/usr/bin/env bash
#SBATCH --job-name=midibrave-loss-prepare
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=01:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/loss-prepare-%j.out
set -euo pipefail

srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  midibrave:v0.4.0-loss-tuning bash -lc '
    set -euo pipefail
    python scripts/generate_loss_tuning_configs.py \
      --base configs/quality300_eligible.yaml \
      --output configs/loss_tuning \
      --run-prefix loss_tune_r1
    python scripts/generate_loss_tuning_configs.py \
      --base configs/quality300_eligible.yaml \
      --output configs/loss_tuning \
      --candidates c8,c9 \
      --run-prefix loss_tune_smoke
    mkdir -p /data/midibrave/loss_tuning/audits
    python scripts/audit_pitch_objective.py \
      --config configs/loss_tuning/loss_tune_r1_c8.yaml \
      --output /data/midibrave/loss_tuning/audits/c8_pitch_objective.json
    python scripts/audit_loss_gradients.py \
      --config configs/loss_tuning/loss_tune_r1_c8.yaml \
      --output /data/midibrave/loss_tuning/audits/c8_gradients_seeded.json
  '
