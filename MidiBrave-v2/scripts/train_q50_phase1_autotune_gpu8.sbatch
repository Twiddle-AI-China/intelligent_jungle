#!/usr/bin/env bash
#SBATCH --job-name=midibrave-q50-p1
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=03:00:00
#SBATCH --requeue
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/q50-phase1-%j.out
set -euo pipefail
if [[ $# -ne 2 || ( "$2" != "baseline" && "$2" != "candidate" ) ]]; then
  echo "usage: sbatch train_q50_phase1_autotune_gpu8.sbatch CAMPAIGN baseline|candidate" >&2
  exit 2
fi
campaign="$1"
role="$2"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
config="${root}/configs/q50_${role}.yaml"
image="midibrave:v0.8.0-phase1-autotune"
run_name=$(awk '$1 == "run_name:" {print $2; exit}' "$config")
steps=$(awk '$1 == "phase1_steps:" {print $2; exit}' "$config")
run_root="${root}/runs/${run_name}/phase1"
final=$(printf "%s/step-%09d.pt" "$run_root" "$steps")
mkdir -p "${root}/monitor" "$run_root"
if [[ -f "$final" ]]; then
  echo "q50 ${role} already complete: $final"
  exit 0
fi

if [[ "$role" == "baseline" ]]; then
  nccl_mode=nvl
  cpu_bind=cores
else
  nccl_mode=$(python3 -c \
    'import json,sys; print(json.load(open(sys.argv[1]))["selected"]["nccl_mode"])' \
    "${root}/performance-selection.json")
  cpu_bind=$(python3 -c \
    'import json,sys; print(json.load(open(sys.argv[1]))["selected"]["cpu_bind"])' \
    "${root}/performance-selection.json")
fi
nccl_args=(-e NCCL_IB_DISABLE=1)
if [[ "$nccl_mode" == "nvl" ]]; then nccl_args+=(-e NCCL_P2P_LEVEL=NVL); fi
resume_args=()
latest=$(find "$run_root" -maxdepth 1 -type f -name 'step-*.pt' 2>/dev/null | sort | tail -n 1 || true)
if [[ -n "$latest" ]]; then resume_args=(--resume "$latest"); fi

monitor="${root}/monitor/q50-${role}-${SLURM_JOB_ID}.csv"
printf '%s\n' \
  'timestamp,index,gpu_util,memory_util,memory_used_mib,memory_total_mib,power_w,temperature_c,sm_clock_mhz,ecc_uncorrected,throttle_reasons' \
  > "$monitor"
nvidia-smi \
  --query-gpu=timestamp,index,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,temperature.gpu,clocks.sm,ecc.errors.uncorrected.volatile.total,clocks_throttle_reasons.active \
  --format=csv,noheader,nounits -l 1 >> "$monitor" 2>"${monitor%.csv}.err" &
monitor_pid=$!
trap 'kill "$monitor_pid" 2>/dev/null || true' EXIT

srun --kill-on-bad-exit=1 --cpu-bind="$cpu_bind" docker run --rm \
  --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /data:/data -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
  "${nccl_args[@]}" \
  "$image" torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
    --config "$config" --phase 1 "${resume_args[@]}"
[[ -f "$final" ]] || { echo "missing q50 final checkpoint: $final" >&2; exit 1; }
