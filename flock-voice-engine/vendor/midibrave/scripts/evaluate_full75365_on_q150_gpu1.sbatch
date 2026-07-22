#!/usr/bin/env bash
#SBATCH --job-name=midibrave-full75365-eval
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=02:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/full75365-on-q150-eval-%j.out

set -euo pipefail

mkdir -p /home/jyhu/MidiBrave/artifacts

srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e PYTHONPATH=/workspace/MidiBrave/src \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  midibrave:v0.7.0-condition-gain bash -lc '
    set -euo pipefail
    config="configs/quality150_c9_optimized.yaml"
    checkpoint="/data/midibrave/runs/midibrave_c9_full_p1_phase1-auto-final-20260719-0455/phase1/step-000075365.pt"
    output="/data/midibrave/evaluation/full75365-on-quality150"

    [[ -f "$checkpoint" ]] || { echo "missing checkpoint: $checkpoint" >&2; exit 1; }
    [[ ! -e "$output" ]] || { echo "refusing to overwrite existing output: $output" >&2; exit 1; }

    python -m midibrave.evaluate \
      --config "$config" --checkpoint "$checkpoint" --output "$output" \
      --pairs 256 --batch-size 2 --examples 24 --grid-presets 6
  '
