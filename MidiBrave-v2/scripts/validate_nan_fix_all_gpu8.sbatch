#!/usr/bin/env bash
#SBATCH --job-name=midibrave-validate-fix
#SBATCH --partition=gpu8
#SBATCH --gres=gpu:8
#SBATCH --cpus-per-task=96
#SBATCH --mem=110G
#SBATCH --time=2:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/validate-nan-fix-%j.out

set -euo pipefail

campaign="phase1-auto-final-20260719-0455"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
failure_root="${root}/nan-audit-20260719/anomaly-continuation/failure"
image="midibrave:v0.8.6-nan-fix"
config="${root}/configs/full_phase1_selected.yaml"

srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" \
  --shm-size=16g \
  -v /data:/data \
  -v /home/jyhu/MidiBrave/scripts/audit_captured_nan.py:/workspace/MidiBrave/scripts/audit_captured_nan.py:ro \
  -w /workspace/MidiBrave \
  "${image}" bash -lc '
    set -uo pipefail
    failure_root="$1"
    config="$2"
    pids=()
    for rank in $(seq 0 7); do
      CUDA_VISIBLE_DEVICES="${rank}" python scripts/audit_captured_nan.py \
        --config "${config}" \
        --state "${failure_root}/failure-state-rank-${rank}.pt" \
        --batch "${failure_root}/failure-batch-rank-${rank}.pt" \
        --failure-json "${failure_root}/failure-rank-${rank}.json" \
        --output "${failure_root}/nan-fix-audit-rank-${rank}.json" \
        > "${failure_root}/nan-fix-audit-rank-${rank}.out" 2>&1 &
      pids+=("$!")
    done
    status=0
    for pid in "${pids[@]}"; do
      wait "${pid}" || status=1
    done
    for rank in $(seq 0 7); do
      printf "rank=%s " "${rank}"
      cat "${failure_root}/nan-fix-audit-rank-${rank}.out"
    done
    exit "${status}"
  ' -- "${failure_root}" "${config}"
