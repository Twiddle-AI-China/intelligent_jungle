#!/usr/bin/env bash
#SBATCH --job-name=midibrave-p1-auto-prepare
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/phase1-auto-prepare-%j.out
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo "usage: sbatch prepare_phase1_autotune_gpu1.sbatch CAMPAIGN" >&2
  exit 2
fi
campaign="$1"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
image="midibrave:v0.8.0-phase1-autotune"

srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=4g \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python scripts/prepare_phase1_autotune.py \
    --campaign "$campaign" --campaign-root "$root" \
    --selection "${root}/performance-selection.json" \
    --base configs/full_c9_optimized.yaml \
    --full-manifest /data/midibrave/manifests/serum_strict_1822_eligible.jsonl \
    --full-metadata /data/midibrave/manifests/serum_strict_1822_eligible.meta.json \
    --preset-manifest /data/datasets/latent-cosmos-synth/serum-dataset/metadata/presets.jsonl

srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" bash -lc \
  "midibrave validate --config '${root}/configs/q50_baseline.yaml' && midibrave validate --config '${root}/configs/q50_candidate.yaml'"
