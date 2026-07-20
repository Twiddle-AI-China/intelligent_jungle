#!/usr/bin/env bash
#SBATCH --job-name=midibrave-full-p1-gate
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=02:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/full-phase1-gate-%j.out
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo "usage: sbatch evaluate_full_phase1_pilot_gpu1.sbatch CAMPAIGN" >&2
  exit 2
fi
campaign="$1"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
config="${root}/configs/full_phase1_selected.yaml"
image="midibrave:v0.8.0-phase1-autotune"
run_name=$(awk '$1 == "run_name:" {print $2; exit}' "$config")
checkpoint_every=$(awk '$1 == "checkpoint_every:" {print $2; exit}' "$config")
checkpoint=$(printf "/data/midibrave/runs/%s/phase1/step-%09d.pt" "$run_name" "$checkpoint_every")
training_log="/data/midibrave/runs/${run_name}/phase1/metrics.jsonl"
output="${root}/evaluation/full_phase1_pilot"
[[ -f "$checkpoint" ]] || { echo "missing pilot checkpoint: $checkpoint" >&2; exit 1; }

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
    --stage 1000 --metrics "${output}/metrics.json" \
    --training-log "$training_log" --expected-updates "$checkpoint_every" \
    --output "${output}/gate.json" --candidate full-phase1-pilot \
    --ignore-velocity
