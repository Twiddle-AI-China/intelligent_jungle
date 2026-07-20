#!/usr/bin/env bash
#SBATCH --job-name=midibrave-full-p1-verify
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=03:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/full-phase1-verify-%j.out
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo "usage: sbatch verify_full_phase1_gpu1.sbatch CAMPAIGN" >&2
  exit 2
fi
campaign="$1"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
config="${root}/configs/full_phase1_selected.yaml"
decision="${root}/final-selection.json"
image="midibrave:v0.8.3-crepe-fallback"
run_name=$(awk '$1 == "run_name:" {print $2; exit}' "$config")
steps=$(awk '$1 == "phase1_steps:" {print $2; exit}' "$config")
checkpoint=$(printf "/data/midibrave/runs/%s/phase1/step-%09d.pt" "$run_name" "$steps")
training_log="/data/midibrave/runs/${run_name}/phase1/metrics.jsonl"
output="${root}/evaluation/full_phase1_final"
[[ -f "$checkpoint" ]] || { echo "missing full Phase1 checkpoint: $checkpoint" >&2; exit 1; }

srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /data:/data -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  "$image" python -m midibrave.evaluate \
    --config "$config" --checkpoint "$checkpoint" --output "$output" \
    --pairs 256 --batch-size 2 --examples 24 --grid-presets 6
srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python scripts/check_short_quality_gate.py \
    --stage 5000 --metrics "${output}/metrics.json" \
    --training-log "$training_log" --expected-updates "$steps" \
    --output "${output}/gate.json" --candidate full-phase1-final \
    --ignore-velocity --soft-fail
srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python scripts/verify_phase1_run.py \
    --config "$config" --checkpoint "$checkpoint" --metrics "$training_log" \
    --evaluation "${output}/gate.json" --decision "$decision" \
    --output "${root}/final-report.json"
