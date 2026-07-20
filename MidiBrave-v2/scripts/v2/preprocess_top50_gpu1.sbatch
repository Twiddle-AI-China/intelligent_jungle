#!/usr/bin/env bash
#SBATCH --job-name=mb-top50-cache
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=12:00:00
#SBATCH --array=0-9
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/top50-cache-%A_%a.out
set -euo pipefail
classes=(pad lead base pluck texture)
class_index=$((SLURM_ARRAY_TASK_ID / 2))
shard_index=$((SLURM_ARRAY_TASK_ID % 2))
class_name=${classes[$class_index]}
config="configs/v2/generated_clap_recon_top50_100k/${class_name}_safe_fallback.yaml"
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  -e HF_HOME=/data/model_weights/huggingface \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
  midibrave:v0.10.0-clap-recon bash -lc \
  "midibrave preprocess --config $config --stage all --device cuda \
   --shard-index $shard_index --shard-count 2"
