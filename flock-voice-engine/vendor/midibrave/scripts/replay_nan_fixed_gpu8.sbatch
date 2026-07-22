#!/usr/bin/env bash
#SBATCH --job-name=midibrave-nan-fixed
#SBATCH --partition=gpu8
#SBATCH --gres=gpu:8
#SBATCH --cpus-per-task=96
#SBATCH --mem=110G
#SBATCH --time=2:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/nan-fixed-%j.out

set -euo pipefail

campaign="phase1-auto-final-20260719-0455"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
audit="${root}/nan-audit-20260719"
production="/data/midibrave/runs/midibrave_c9_full_p1_${campaign}/phase1"
isolated="${audit}/fixed-replay-v087"
capture="${isolated}/failure"
image="midibrave:v0.8.7-stable"
resume="${production}/step-000075365.pt"
container_run="/data/midibrave/runs/midibrave_c9_full_p1_${campaign}/phase1"

mkdir -p "${isolated}" "${capture}" /home/jyhu/MidiBrave/artifacts
[[ -f "${resume}" ]]

set +e
srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" \
  --shm-size=16g \
  -v /data:/data \
  -v "${isolated}:${container_run}" \
  -v "${resume}:/checkpoint/step-000075365.pt:ro" \
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
    --max-steps 90000 \
    --resume /checkpoint/step-000075365.pt
training_status=$?
set -e

shopt -s nullglob
failures=("${capture}"/failure-rank-*.json)
if (( training_status == 0 && ${#failures[@]} == 0 )) \
    && [[ -f "${isolated}/step-000090000.pt" ]]; then
  printf '{"status":"PASS","training_exit":0,"start":75365,"end":90000}\n' \
    | tee "${isolated}/replay-summary.json"
  exit 0
fi

printf '{"status":"FAIL","training_exit":%d,"failure_count":%d}\n' \
  "${training_status}" "${#failures[@]}" | tee "${isolated}/replay-summary.json"
exit 4
