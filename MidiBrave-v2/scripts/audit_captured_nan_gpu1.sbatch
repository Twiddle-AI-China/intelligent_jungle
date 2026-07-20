#!/usr/bin/env bash
#SBATCH --job-name=midibrave-captured-nan
#SBATCH --partition=gpu1
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=12
#SBATCH --mem=15G
#SBATCH --time=2:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/captured-nan-%j.out

set -euo pipefail

campaign="phase1-auto-final-20260719-0455"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
failure_root="${MIDIBRAVE_FAILURE_ROOT:-${root}/nan-audit-20260719/anomaly-replay/failure}"
image="${MIDIBRAVE_NAN_AUDIT_IMAGE:-midibrave:v0.8.5-nan-audit}"

shopt -s nullglob
failures=("${failure_root}"/failure-rank-*.json)
if (( ${#failures[@]} == 0 )); then
  echo "no captured failure JSON" >&2
  exit 4
fi
failure="${failures[0]}"
rank="$(basename "${failure}" | sed -E 's/failure-rank-([0-9]+)\.json/\1/')"
state="${failure_root}/failure-state-rank-${rank}.pt"
batch="${failure_root}/failure-batch-rank-${rank}.pt"
output="${failure_root}/captured-nan-audit-rank-${rank}.json"
[[ -f "${state}" && -f "${batch}" ]]

srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" \
  --shm-size=16g \
  -v /data:/data \
  -v /home/jyhu/MidiBrave/scripts/audit_captured_nan.py:/workspace/MidiBrave/scripts/audit_captured_nan.py:ro \
  -w /workspace/MidiBrave \
  "${image}" \
  python scripts/audit_captured_nan.py \
    --config "${root}/configs/full_phase1_selected.yaml" \
    --state "${state}" \
    --batch "${batch}" \
    --failure-json "${failure}" \
    --output "${output}"
