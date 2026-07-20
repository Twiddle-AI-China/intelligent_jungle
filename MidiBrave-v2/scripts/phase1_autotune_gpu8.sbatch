#!/usr/bin/env bash
#SBATCH --job-name=midibrave-p1-autotune
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=03:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/phase1-autotune-%j.out
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo "usage: sbatch phase1_autotune_gpu8.sbatch CAMPAIGN" >&2
  exit 2
fi

campaign="$1"
image="midibrave:v0.8.0-phase1-autotune"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
bench="${root}/benchmarks"
mkdir -p "$bench" /home/jyhu/MidiBrave/artifacts

run_case() {
  local case_id="$1" batch="$2" bucket="$3" compile="$4"
  local nccl_mode="$5" cpu_bind="$6" log_every="$7"
  local case_root="${bench}/${case_id}"
  local config="${case_root}/config.yaml"
  local monitor="${case_root}/gpu.csv"
  local metrics="${case_root}/runs/${case_id}/phase1/metrics.jsonl"
  local summary="${case_root}/summary.json"
  mkdir -p "$case_root"

  local compile_arg=()
  if [[ "$compile" == "1" ]]; then compile_arg=(--compile-decoder); fi
  srun --ntasks=1 --cpu-bind="$cpu_bind" docker run --rm \
    -v /data:/data -w /workspace/MidiBrave \
    "$image" python scripts/generate_phase1_autotune_config.py \
      --base configs/full_c9_optimized.yaml \
      --manifest /data/midibrave/manifests/serum_strict_1822_eligible.jsonl \
      --metadata /data/midibrave/manifests/serum_strict_1822_eligible.meta.json \
      --output "$config" --run-name "$case_id" \
      --output-dir "${case_root}/runs" --batch-per-gpu "$batch" \
      --ddp-bucket-cap-mb "$bucket" --log-every "$log_every" \
      --self-full-fraction 0.0 \
      "${compile_arg[@]}"

  printf '%s\n' \
    'timestamp,index,gpu_util,memory_util,memory_used_mib,memory_total_mib,power_w,temperature_c,sm_clock_mhz,ecc_uncorrected,throttle_reasons' \
    > "$monitor"
  nvidia-smi \
    --query-gpu=timestamp,index,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,temperature.gpu,clocks.sm,ecc.errors.uncorrected.volatile.total,clocks_throttle_reasons.active \
    --format=csv,noheader,nounits -l 1 >> "$monitor" 2>"${case_root}/nvidia-smi.err" &
  local monitor_pid=$!

  local nccl_args=(-e NCCL_IB_DISABLE=1)
  if [[ "$nccl_mode" == "nvl" ]]; then nccl_args+=(-e NCCL_P2P_LEVEL=NVL); fi
  local started ended wall_ms wall_seconds rc
  started=$(date +%s%N)
  set +e
  srun --ntasks=1 --kill-on-bad-exit=0 --cpu-bind="$cpu_bind" docker run --rm \
    --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
    -v /data:/data -w /workspace/MidiBrave \
    -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
    -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
    -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
    "${nccl_args[@]}" \
    "$image" torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config "$config" --phase 1 --max-effective-updates 240 \
      >"${case_root}/train.out" 2>"${case_root}/train.err"
  rc=$?
  set -e
  ended=$(date +%s%N)
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  wall_ms=$(( (ended - started) / 1000000 ))
  wall_seconds=$(awk -v ms="$wall_ms" 'BEGIN { printf "%.3f", ms / 1000.0 }')

  srun --ntasks=1 --cpu-bind=cores docker run --rm \
    -v /data:/data -w /workspace/MidiBrave \
    "$image" python scripts/summarize_phase1_autotune.py \
      --case-id "$case_id" --config "$config" --metrics "$metrics" \
      --monitor "$monitor" --exit-code "$rc" --expected-updates 240 \
      --warmup-updates 40 --wall-seconds "$wall_seconds" \
      --nccl-mode "$nccl_mode" --cpu-bind "$cpu_bind" --output "$summary"
}

for replicate in 1 2; do
  for batch in 10 11 12 13 14; do
    run_case "batch-b${batch}-r${replicate}" "$batch" 16 0 nvl cores 100
  done
done

srun --ntasks=1 --cpu-bind=cores docker run --rm \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python scripts/select_phase1_autotune.py \
    --summaries "${bench}/batch-b*-r*/summary.json" \
    --replicate-field batch_per_gpu --baseline-group 10 \
    --minimum-replicates 2 --minimum-improvement 0.03 \
    --output "${root}/batch-selection.json"
selected_batch=$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["selected"]["batch_per_gpu"])' \
  "${root}/batch-selection.json")

for bucket in 16 25 32 64; do
  run_case "bucket-b${selected_batch}-k${bucket}" "$selected_batch" "$bucket" 0 nvl cores 100
done
srun --ntasks=1 --cpu-bind=cores docker run --rm \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python scripts/select_phase1_autotune.py \
    --summaries "${bench}/bucket-b${selected_batch}-k*/summary.json" \
    --baseline-case "bucket-b${selected_batch}-k16" \
    --output "${root}/bucket-selection.json"
selected_bucket=$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["selected"]["ddp_bucket_cap_mb"])' \
  "${root}/bucket-selection.json")

infra_baseline="infra-b${selected_batch}-k${selected_bucket}-c0-nnvl-pcores-l100"

for compile in 0 1; do
  for nccl in nvl default; do
    for bind in cores none; do
      for log_every in 21 100; do
        run_case \
          "infra-b${selected_batch}-k${selected_bucket}-c${compile}-n${nccl}-p${bind}-l${log_every}" \
          "$selected_batch" "$selected_bucket" "$compile" "$nccl" "$bind" "$log_every"
      done
    done
  done
done

srun --ntasks=1 --cpu-bind=cores docker run --rm \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python scripts/select_phase1_autotune.py \
    --summaries "${bench}/infra-b${selected_batch}-k${selected_bucket}-*/summary.json" \
    --baseline-case "$infra_baseline" --minimum-improvement 0.01 \
    --output "${root}/infra-preliminary-selection.json"

confirm_batch=$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["selected"]["batch_per_gpu"])' \
  "${root}/infra-preliminary-selection.json")
confirm_bucket=$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["selected"]["ddp_bucket_cap_mb"])' \
  "${root}/infra-preliminary-selection.json")
confirm_compile=$(python3 -c \
  'import json,sys; print(int(bool(json.load(open(sys.argv[1]))["selected"]["compile_decoder"])))' \
  "${root}/infra-preliminary-selection.json")
confirm_nccl=$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["selected"]["nccl_mode"])' \
  "${root}/infra-preliminary-selection.json")
confirm_bind=$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["selected"]["cpu_bind"])' \
  "${root}/infra-preliminary-selection.json")
confirm_log_every=$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["selected"]["log_every"])' \
  "${root}/infra-preliminary-selection.json")
run_case infra-confirm-selected "$confirm_batch" "$confirm_bucket" \
  "$confirm_compile" "$confirm_nccl" "$confirm_bind" "$confirm_log_every"

srun --ntasks=1 --cpu-bind=cores docker run --rm \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python scripts/confirm_phase1_infra.py \
    --preliminary "${root}/infra-preliminary-selection.json" \
    --confirmation "${bench}/infra-confirm-selected/summary.json" \
    --minimum-improvement 0.01 --output "${root}/infra-selection.json"
srun --ntasks=1 --cpu-bind=cores docker run --rm \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python scripts/compose_phase1_performance_selection.py \
    --batch-selection "${root}/batch-selection.json" \
    --infra-selection "${root}/infra-selection.json" \
    --minimum-improvement 0.03 --output "${root}/performance-selection.json"
