#!/usr/bin/env bash
#SBATCH --job-name=midibrave-nan-numerics
#SBATCH --partition=gpu1
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=12
#SBATCH --mem=15G
#SBATCH --time=2:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/nan-numerics-%j.out

set -euo pipefail

campaign="phase1-auto-final-20260719-0455"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
audit="${root}/nan-audit-20260719"
checkpoint="/data/midibrave/runs/midibrave_c9_full_p1_${campaign}/phase1/step-000075365.pt"
image="midibrave:v0.8.3-crepe-fallback"

mkdir -p "${audit}" /home/jyhu/MidiBrave/artifacts

srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" \
  --shm-size=16g \
  -v /data:/data \
  -v /home/jyhu/MidiBrave/scripts/audit_failure_numerics.py:/workspace/MidiBrave/scripts/audit_failure_numerics.py:ro \
  -w /workspace/MidiBrave \
  "${image}" \
  python scripts/audit_failure_numerics.py \
    --config "${root}/configs/full_phase1_selected.yaml" \
    --checkpoint "${checkpoint}" \
    --failure-loop 85128 \
    --checkpoint-loop 75400 \
    --checkpoint-offset 40 \
    --epoch 5 \
    --rank 0 \
    --world-size 8 \
    --output "${audit}/failure-numerics-checkpoint-075365.json"
