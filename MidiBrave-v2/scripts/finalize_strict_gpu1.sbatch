#!/usr/bin/env bash
#SBATCH --job-name=midibrave-610-finalize
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=03:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/finalize-strict-%j.out
set -euo pipefail
srun docker run --rm --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  midibrave:v0.3.0-optimized bash -lc '
    set -euo pipefail
    midibrave finalize-cache \
      --config configs/base.yaml \
      --output-manifest /data/midibrave/manifests/serum_strict_1822_eligible.jsonl \
      --output-metadata /data/midibrave/manifests/serum_strict_1822_eligible.meta.json
    midibrave finalize-cache \
      --config configs/quality300.yaml \
      --output-manifest /data/midibrave/manifests/serum_quality300_eligible_optimized.jsonl \
      --output-metadata /data/midibrave/manifests/serum_quality300_eligible_optimized.meta.json
    python scripts/generate_quality_config.py \
      --base configs/quality300.yaml \
      --manifest /data/midibrave/manifests/serum_quality300_eligible_optimized.jsonl \
      --metadata /data/midibrave/manifests/serum_quality300_eligible_optimized.meta.json \
      --output configs/quality300_eligible.yaml
    midibrave validate --config configs/quality300_eligible.yaml
  '
