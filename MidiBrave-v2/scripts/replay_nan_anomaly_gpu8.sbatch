#!/usr/bin/env bash
#SBATCH --job-name=midibrave-nan-replay
#SBATCH --partition=gpu8
#SBATCH --gres=gpu:8
#SBATCH --cpus-per-task=96
#SBATCH --mem=110G
#SBATCH --time=4:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/nan-replay-%j.out

set -euo pipefail

campaign="phase1-auto-final-20260719-0455"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
audit="${root}/nan-audit-20260719"
isolated="${audit}/anomaly-replay"
production="/data/midibrave/runs/midibrave_c9_full_p1_${campaign}/phase1"
image="midibrave:v0.8.4-nan-audit"

mkdir -p "${isolated}/failure" /home/jyhu/MidiBrave/artifacts
cp "${production}/step-000075365.pt" "${isolated}/step-000075365.pt"

set +e
srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" \
  --shm-size=16g \
  -v /data:/data \
  -v "${isolated}:/data/midibrave/runs/midibrave_c9_full_p1_${campaign}/phase1" \
  -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 \
  -e MKL_NUM_THREADS=1 \
  -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
  -e NCCL_IB_DISABLE=1 \
  -e NCCL_P2P_LEVEL=NVL \
  -e MIDIBRAVE_NAN_AUDIT_START_UPDATE=84750 \
  -e MIDIBRAVE_NAN_AUDIT_DIR="${audit}/anomaly-replay/failure" \
  "${image}" \
  torchrun --standalone --nproc_per_node=8 \
    -m midibrave.trainer \
    --config "${root}/configs/full_phase1_selected.yaml" \
    --phase 1 \
    --max-steps 85200 \
    --resume "/data/midibrave/runs/midibrave_c9_full_p1_${campaign}/phase1/step-000075365.pt"
training_status=$?
set -e

shopt -s nullglob
failures=("${isolated}"/failure/failure-rank-*.json)
if (( ${#failures[@]} > 0 )); then
  printf '{"status":"REPRODUCED","training_exit":%d,"failure":"%s"}\n' \
    "${training_status}" "${failures[0]}" | tee "${isolated}/replay-summary.json"
  exit 0
fi

printf '{"status":"NOT_REPRODUCED","training_exit":%d}\n' \
  "${training_status}" | tee "${isolated}/replay-summary.json"
exit 4
