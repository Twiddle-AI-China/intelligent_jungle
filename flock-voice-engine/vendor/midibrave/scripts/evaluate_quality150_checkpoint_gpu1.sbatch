#!/usr/bin/env bash
#SBATCH --job-name=midibrave-q150-trajectory
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=02:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/quality150-trajectory-eval-%j.out
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-9]+$ || "$1" -le 0 ]]; then
  echo "usage: sbatch evaluate_quality150_checkpoint_gpu1.sbatch POSITIVE_STEP" >&2
  exit 2
fi

mkdir -p /home/jyhu/MidiBrave/artifacts
steps="$1"

srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e MIDIBRAVE_STEPS="$steps" \
  -e PYTHONPATH=/workspace/MidiBrave/src \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  midibrave:v0.7.0-condition-gain bash -lc '
    set -euo pipefail
    config="configs/quality150_c9_optimized.yaml"
    steps="${MIDIBRAVE_STEPS:?MIDIBRAVE_STEPS is required}"
    printf -v padded "%09d" "$steps"
    run_name=$(python -c "from midibrave.config import Config; print(Config.load(\"$config\").train.run_name)")
    checkpoint="/data/midibrave/runs/$run_name/phase1/step-$padded.pt"
    output="/data/midibrave/evaluation/quality150-c9-phase1-step-$padded"
    [[ -f "$checkpoint" ]] || { echo "missing checkpoint: $checkpoint" >&2; exit 1; }
    python -m midibrave.evaluate \
      --config "$config" --checkpoint "$checkpoint" --output "$output" \
      --pairs 256 --batch-size 2 --examples 0 --grid-presets 1 --velocity-pairs 64
  '
