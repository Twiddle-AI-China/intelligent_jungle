#!/usr/bin/env bash
#SBATCH --job-name=midibrave-q150-summary
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=00:15:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/quality150-trajectory-summary-%j.out
set -euo pipefail
mkdir -p /home/jyhu/MidiBrave/artifacts

srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  midibrave:v0.7.0-condition-gain python scripts/summarize_quality150_trajectory.py \
    --metrics \
      /data/midibrave/evaluation/quality150-c9-phase1-step-000001448/metrics.json \
      /data/midibrave/evaluation/quality150-c9-phase1-step-000004344/metrics.json \
      /data/midibrave/evaluation/quality150-c9-phase1-step-000005792/metrics.json \
      /data/midibrave/evaluation/quality150-c9-phase1/metrics.json \
    --reference-step 5792 --final-step 23162 \
    --output-dir /data/midibrave/evaluation/quality150-c9-phase1-trajectory
