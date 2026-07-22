#!/usr/bin/env bash
#SBATCH --job-name=midibrave-pipeline
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/pipeline-%j.out
set -euo pipefail
srun docker run --rm --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e HF_HOME=/data/model_weights/huggingface \
  -e TRANSFORMERS_OFFLINE=1 -e HF_HUB_OFFLINE=1 \
  midibrave:v0.2.1-serum bash -lc '
    midibrave fixture --root fixtures/real-clap --samples 81920
    midibrave preprocess --config configs/pipeline.yaml --stage all --device cuda
    midibrave validate --config configs/pipeline.yaml
    python -m midibrave.trainer --config configs/pipeline.yaml --phase 1 \
      --max-effective-updates 3
    python -m midibrave.trainer --config configs/pipeline.yaml --phase 2 \
      --max-effective-updates 3 \
      --resume artifacts/candidate/real_clap_v02/phase1/step-000000003.pt
  '
