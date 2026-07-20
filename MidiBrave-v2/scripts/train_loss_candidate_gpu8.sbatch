#!/usr/bin/env bash
#SBATCH --job-name=midibrave-loss-train
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=04:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/loss-train-%j.out
set -euo pipefail
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: sbatch train_loss_candidate_gpu8.sbatch CONFIG EFFECTIVE_UPDATES [RESUME]" >&2
  exit 2
fi
config="$1"
updates="$2"
resume="${3:-}"
image_tag="${IMAGE_TAG:-midibrave:v0.4.0-loss-tuning}"
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e CONFIG="$config" -e EFFECTIVE_UPDATES="$updates" -e RESUME="$resume" \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  -e NCCL_P2P_LEVEL=NVL -e NCCL_IB_DISABLE=1 \
  -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
  "$image_tag" bash -lc '
    set -euo pipefail
    midibrave validate --config "$CONFIG"
    resume_args=()
    if [[ -n "$RESUME" ]]; then
      resume_args=(--resume "$RESUME")
    fi
    torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config "$CONFIG" --phase 1 --max-effective-updates "$EFFECTIVE_UPDATES" \
      "${resume_args[@]}"
  '
