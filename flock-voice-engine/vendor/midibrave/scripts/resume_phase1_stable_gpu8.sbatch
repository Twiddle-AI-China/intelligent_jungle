#!/usr/bin/env bash
#SBATCH --job-name=midibrave-p1-stable
#SBATCH --partition=gpu8
#SBATCH --gres=gpu:8
#SBATCH --cpus-per-task=96
#SBATCH --mem=110G
#SBATCH --time=36:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/phase1-stable-%j.out

set -euo pipefail

campaign="phase1-auto-final-20260719-0455"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
run="${root}/nan-audit-20260719/fixed-replay-v087"
capture="${run}/production-failure"
image="midibrave:v0.8.7-stable"
resume="${run}/step-000090000.pt"
container_run="/data/midibrave/runs/midibrave_c9_full_p1_${campaign}/phase1"

mkdir -p "${capture}" /home/jyhu/MidiBrave/artifacts
[[ -f "${resume}" ]]
grep -q '"status":"PASS"' "${run}/replay-summary.json"

srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" \
  --shm-size=16g \
  -v /data:/data \
  -v "${run}:${container_run}" \
  -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 \
  -e MKL_NUM_THREADS=1 \
  -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
  -e NCCL_IB_DISABLE=1 \
  -e NCCL_P2P_LEVEL=NVL \
  -e MIDIBRAVE_NAN_AUDIT_START_UPDATE=999999999 \
  -e MIDIBRAVE_NAN_AUDIT_CAPTURE_SCALE_MAX=4 \
  -e MIDIBRAVE_NAN_AUDIT_DIR="${capture}" \
  -e MIDIBRAVE_MAX_CONSECUTIVE_NONFINITE=16 \
  "${image}" \
  torchrun --standalone --nproc_per_node=8 \
    -m midibrave.trainer \
    --config "${root}/configs/full_phase1_selected.yaml" \
    --phase 1 \
    --resume "${container_run}/step-000090000.pt"
