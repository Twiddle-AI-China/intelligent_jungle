#!/usr/bin/env bash
#SBATCH --job-name=midibrave-nan-data-audit
#SBATCH --partition=gpu1
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=12
#SBATCH --mem=15G
#SBATCH --time=1:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/nan-data-audit-%j.out

set -euo pipefail

campaign="phase1-auto-final-20260719-0455"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
audit="${root}/nan-audit-20260719"
image="midibrave:v0.8.3-crepe-fallback"

mkdir -p "${audit}" /home/jyhu/MidiBrave/artifacts

srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" \
  --shm-size=16g \
  -v /data:/data \
  -v /home/jyhu/MidiBrave/scripts/audit_failure_data.py:/workspace/MidiBrave/scripts/audit_failure_data.py:ro \
  -w /workspace/MidiBrave \
  "${image}" \
  python scripts/audit_failure_data.py \
    --config "${root}/configs/full_phase1_selected.yaml" \
    --checkpoint-loop 75400 \
    --checkpoint-offset 40 \
    --checkpoint-epoch 5 \
    --world-size 8 \
    --failure-loops 85127 85128 85132 \
    --output "${audit}/failure-data-audit.json"
