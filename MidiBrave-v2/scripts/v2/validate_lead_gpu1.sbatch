#!/usr/bin/env bash
#SBATCH --job-name=mbv2-validate-lead
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=02:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/validate-lead-%j.out
set -euo pipefail
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  midibrave:v0.9.0-five-model-fp16 bash -lc '
    set -euo pipefail
    midibrave finalize-cache \
      --config configs/v2/generated/lead_safe_fallback.yaml \
      --output-manifest /data/midibrave-v2/manifests/lead.jsonl \
      --output-metadata /data/midibrave-v2/manifests/lead.meta.json \
      | tee /data/midibrave-v2/reports/lead_cache_finalization.json
    midibrave validate --config configs/v2/generated/lead_safe_fallback.yaml \
      | tee /data/midibrave-v2/reports/lead_data_validation.json
    python -m pytest -q tests
  '
