#!/usr/bin/env bash
#SBATCH --job-name=mb-top50-final
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=02:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/top50-final-%j.out
set -euo pipefail
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  midibrave:v0.10.0-clap-recon bash -lc '
    set -euo pipefail
    mkdir -p /data/midibrave-v2/manifests/top50_eligible
    for class_name in pad lead base pluck texture; do
      config="configs/v2/generated_clap_recon_top50_100k/${class_name}_safe_fallback.yaml"
      midibrave finalize-cache --config "$config" \
        --output-manifest "/data/midibrave-v2/manifests/top50_eligible/${class_name}.jsonl" \
        --output-metadata "/data/midibrave-v2/manifests/top50_eligible/${class_name}.meta.json"
    done
    python scripts/v2/materialize_top50.py \
      --source-dir /data/midibrave-v2/manifests/top50_eligible \
      --output-dir /data/midibrave-v2/manifests/top50 \
      --count 50 --formal
    for class_name in pad lead base pluck texture; do
      config="configs/v2/generated_clap_recon_top50_100k/${class_name}_safe_fallback.yaml"
      midibrave validate --config "$config"
    done
  '
