#!/usr/bin/env bash
#SBATCH --job-name=mb-clap-objective
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=02:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/clap-objective-%j.out
set -euo pipefail
config=configs/v2/generated_clap_recon_top50_100k/lead_safe_fallback.yaml
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  -e HF_HOME=/data/model_weights/huggingface \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
  midibrave:v0.10.0-clap-recon python scripts/v2/check_clap_objective.py \
  --config "$config" --output /data/midibrave-v2/reports/clap_objective.json
