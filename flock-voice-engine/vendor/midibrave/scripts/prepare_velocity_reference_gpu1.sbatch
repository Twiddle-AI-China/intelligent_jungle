#!/usr/bin/env bash
#SBATCH --job-name=midibrave-velocity-reference
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/velocity-reference-prepare-%j.out
set -euo pipefail
image_tag="${IMAGE_TAG:-midibrave:v0.6.0-velocity-reference}"

srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  "$image_tag" bash -lc '
    set -euo pipefail
    python scripts/generate_loss_tuning_configs.py \
      --base configs/quality300_eligible.yaml \
      --output artifacts/r4_configs \
      --candidates c12,c13 \
      --run-prefix loss_tune_r1
    midibrave validate --config artifacts/r4_configs/loss_tune_r1_c12.yaml
    midibrave validate --config artifacts/r4_configs/loss_tune_r1_c13.yaml
    python scripts/audit_loss_gradients.py \
      --config artifacts/r4_configs/loss_tune_r1_c12.yaml \
      --output /workspace/MidiBrave/artifacts/r4-c12-gradient-audit.json
  '
