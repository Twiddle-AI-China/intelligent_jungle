#!/usr/bin/env bash
#SBATCH --job-name=midibrave-q50-eval
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=02:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/q50-eval-%j.out
set -euo pipefail
if [[ $# -ne 2 || ( "$2" != "baseline" && "$2" != "candidate" ) ]]; then
  echo "usage: sbatch evaluate_q50_phase1_autotune_gpu1.sbatch CAMPAIGN baseline|candidate" >&2
  exit 2
fi
campaign="$1"
role="$2"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
config="${root}/configs/q50_${role}.yaml"
image="midibrave:v0.8.0-phase1-autotune"
run_name=$(awk '$1 == "run_name:" {print $2; exit}' "$config")
steps=$(awk '$1 == "phase1_steps:" {print $2; exit}' "$config")
checkpoint=$(printf "%s/runs/%s/phase1/step-%09d.pt" "$root" "$run_name" "$steps")
training_log="${root}/runs/${run_name}/phase1/metrics.jsonl"
output="${root}/evaluation/q50_${role}"
[[ -f "$checkpoint" ]] || { echo "missing checkpoint: $checkpoint" >&2; exit 1; }

srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /data:/data -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  "$image" python -m midibrave.evaluate \
    --config "$config" --checkpoint "$checkpoint" --output "$output" \
    --pairs 256 --batch-size 2 --examples 24 --grid-presets 6

gate_args=(
  --stage 5000 --metrics "${output}/metrics.json"
  --training-log "$training_log" --expected-updates "$steps"
  --output "${output}/gate.json" --candidate "q50-${role}"
  --ignore-velocity --soft-fail
)
if [[ "$role" == "candidate" ]]; then
  gate_args+=(--baseline "${root}/evaluation/q50_baseline/metrics.json")
fi
srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python scripts/check_short_quality_gate.py "${gate_args[@]}"
[[ -f "${output}/gate.json" ]] || { echo "missing q50 gate output" >&2; exit 1; }
