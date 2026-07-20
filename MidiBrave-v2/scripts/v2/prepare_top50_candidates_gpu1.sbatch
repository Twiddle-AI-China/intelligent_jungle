#!/usr/bin/env bash
#SBATCH --job-name=mb-top50-prepare
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=12G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/top50-prepare-%j.out
set -euo pipefail
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=8g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  midibrave:v0.10.0-clap-recon bash -lc '
    set -euo pipefail
    python scripts/v2/materialize_top50.py \
      --source-dir /data/midibrave-v2/manifests \
      --output-dir /data/midibrave-v2/manifests/top50 \
      --count 80
    python scripts/materialize_v2_configs.py --base configs/v2/base.yaml \
      --output configs/v2/generated_clap_recon_top50_100k --top50-100k
  '
