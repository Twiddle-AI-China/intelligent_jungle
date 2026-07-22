#!/usr/bin/env bash
#SBATCH --job-name=midibrave-precision
#SBATCH --partition=gpu8
#SBATCH --gres=gpu:8
#SBATCH --cpus-per-task=48
#SBATCH --mem=100G
#SBATCH --time=2:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/precision-%j.out

set -euo pipefail

campaign="phase1-auto-final-20260719-0455"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
failure_root="${root}/nan-audit-20260719/anomaly-continuation/failure"
image="midibrave:v0.8.5-nan-audit"
config="${root}/configs/full_phase1_selected.yaml"

srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" \
  --shm-size=16g \
  -v /data:/data \
  -v /home/jyhu/MidiBrave/scripts/audit_captured_nan.py:/workspace/MidiBrave/scripts/audit_captured_nan.py:ro \
  -v /home/jyhu/MidiBrave/scripts/probe_decoder_precision.py:/workspace/MidiBrave/scripts/probe_decoder_precision.py:ro \
  -w /workspace/MidiBrave \
  "${image}" bash -lc '
    set -uo pipefail
    failure_root="$1"
    config="$2"
    ranks=(0 3 5)
    pids=()
    for device in 0 1 2; do
      rank="${ranks[$device]}"
      CUDA_VISIBLE_DEVICES="${device}" python scripts/probe_decoder_precision.py \
        --config "${config}" \
        --state "${failure_root}/failure-state-rank-${rank}.pt" \
        --batch "${failure_root}/failure-batch-rank-${rank}.pt" \
        --failure-json "${failure_root}/failure-rank-${rank}.json" \
        --output "${failure_root}/decoder-precision-rank-${rank}.json" \
        > "${failure_root}/decoder-precision-rank-${rank}.out" 2>&1 &
      pids+=("$!")
    done
    status=0
    for pid in "${pids[@]}"; do
      wait "${pid}" || status=1
    done
    for rank in "${ranks[@]}"; do
      printf "rank=%s " "${rank}"
      cat "${failure_root}/decoder-precision-rank-${rank}.out"
    done
    exit "${status}"
  ' -- "${failure_root}" "${config}"
