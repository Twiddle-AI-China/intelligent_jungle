#!/usr/bin/env bash
#SBATCH --job-name=midibrave-eval-q300
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=04:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/evaluate-q300-%j.out
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: sbatch evaluate_quality300_gpu1.sbatch PHASE_OR_CHECKPOINT [OUTPUT_DIR]"
  exit 2
fi
checkpoint="$1"
output="${2:-/data/midibrave/evaluation/quality300-optimized}"
srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e PHASE_OR_CHECKPOINT="$checkpoint" -e EVALUATION_OUTPUT="$output" \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  midibrave:v0.3.0-optimized bash -lc '
    set -euo pipefail
    checkpoint="$PHASE_OR_CHECKPOINT"
    if [[ "$checkpoint" == "phase1" || "$checkpoint" == "phase2" ]]; then
      phase="${checkpoint#phase}"
      checkpoint=$(python -c \
        "from midibrave.config import Config; c=Config.load(\"configs/quality300_eligible.yaml\"); phase=int(\"$phase\"); steps=c.train.phase1_steps if phase == 1 else c.train.phase2_steps; print(f\"/data/midibrave/runs/{c.train.run_name}/phase{phase}/step-{steps:09d}.pt\")")
    fi
    python -m midibrave.evaluate \
      --config configs/quality300_eligible.yaml --checkpoint "$checkpoint" \
      --output "$EVALUATION_OUTPUT" \
      --pairs 256 --batch-size 2 --examples 24 --grid-presets 6
  '
