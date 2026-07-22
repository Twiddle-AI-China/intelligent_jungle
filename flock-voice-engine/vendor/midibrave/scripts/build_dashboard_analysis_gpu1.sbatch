#!/usr/bin/env bash
#SBATCH --job-name=midibrave-dashboard-analysis
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/dashboard-analysis-%j.out

set -euo pipefail

mkdir -p /home/jyhu/MidiBrave/artifacts

srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e PYTHONPATH=/workspace/MidiBrave/src \
  -e OMP_NUM_THREADS=12 -e MKL_NUM_THREADS=12 \
  midibrave:v0.8.5-nan-audit bash -lc '
    set -euo pipefail
    python scripts/build_dashboard_analysis.py \
      --config /data/midibrave/runs/midibrave_c9_full_p1_phase1-auto-final-20260719-0455/phase1/config.yaml \
      --manifest /data/midibrave/manifests/serum_strict_1822_eligible.jsonl \
      --q150-manifest /data/midibrave/manifests/serum_quality150_eligible.jsonl \
      --cache-root /data/midibrave/cache/serum_strict_1822 \
      --q150-checkpoint /data/midibrave/runs/midibrave_quality150_c9_optimized/phase1/step-000023162.pt \
      --full-checkpoint /data/midibrave/runs/midibrave_c9_full_p1_phase1-auto-final-20260719-0455/phase1/step-000075365.pt \
      --q150-log /data/midibrave/runs/midibrave_quality150_c9_optimized/phase1/metrics.jsonl \
      --full-log /data/midibrave/runs/midibrave_c9_full_p1_phase1-auto-final-20260719-0455/phase1/metrics.jsonl \
      --output /data/midibrave/evaluation/q150-full75365-dashboard-analysis/analysis-full-range.json \
      --split train --batch-size 4096 --window-updates 1000 --curve-points 0 --scatter-points 2400
  '
