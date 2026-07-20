#!/usr/bin/env bash
#SBATCH --job-name=midibrave-p1-auto-finalize
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=00:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/phase1-auto-finalize-%j.out
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo "usage: sbatch finalize_phase1_autotune_gpu1.sbatch CAMPAIGN" >&2
  exit 2
fi
campaign="$1"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
image="midibrave:v0.8.0-phase1-autotune"

srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python scripts/finalize_phase1_autotune.py \
    --campaign "$campaign" \
    --selection "${root}/performance-selection.json" \
    --baseline-gate "${root}/evaluation/q50_baseline/gate.json" \
    --candidate-gate "${root}/evaluation/q50_candidate/gate.json" \
    --base configs/full_c9_optimized.yaml \
    --full-manifest /data/midibrave/manifests/serum_strict_1822_eligible.jsonl \
    --full-metadata /data/midibrave/manifests/serum_strict_1822_eligible.meta.json \
    --output-config "${root}/configs/full_phase1_selected.yaml" \
    --output-decision "${root}/final-selection.json"
srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" midibrave validate --config "${root}/configs/full_phase1_selected.yaml"
