#!/usr/bin/env bash
#SBATCH --job-name=midibrave-cache-q300
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=10:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/cache-q300-%j.out
set -euo pipefail
srun docker run --rm --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e SLURM_JOB_ID -e HF_HOME=/data/model_weights/huggingface \
  -e TORCH_HOME=/data/model_weights/torchcrepe \
  -e TRANSFORMERS_OFFLINE=1 -e HF_HUB_OFFLINE=1 \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  midibrave:v0.2.1-serum bash -lc '
    set -euo pipefail
    pids=()
    for shard in 0 1 2 3 4 5 6 7; do
      CUDA_VISIBLE_DEVICES="$shard" midibrave preprocess \
        --config configs/quality300.yaml --stage pitch --device cuda \
        --shard-index "$shard" --shard-count 8 \
        >"artifacts/cache-q300-${SLURM_JOB_ID}-shard-${shard}.json" \
        2>"artifacts/cache-q300-${SLURM_JOB_ID}-shard-${shard}.err" &
      pids+=("$!")
    done
    status=0
    for pid in "${pids[@]}"; do
      wait "$pid" || status=1
    done
    exit "$status"
  '
