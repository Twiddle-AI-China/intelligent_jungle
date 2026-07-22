#!/usr/bin/env bash
#SBATCH --job-name=midibrave-q150-prepare
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/quality150-prepare-%j.out
set -euo pipefail
mkdir -p /home/jyhu/MidiBrave/artifacts

srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e PYTHONPATH=/workspace/MidiBrave/src \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  midibrave:v0.7.0-condition-gain bash -lc '
    set -euo pipefail
    python scripts/create_quality_subset.py \
      --manifest /data/midibrave/manifests/serum_quality300_eligible_optimized.jsonl \
      --metadata /data/midibrave/manifests/serum_quality300_eligible_optimized.meta.json \
      --preset-manifest /data/datasets/latent-cosmos-synth/serum-dataset/metadata/presets.jsonl \
      --output-manifest /data/midibrave/manifests/serum_quality150_eligible.jsonl \
      --output-metadata /data/midibrave/manifests/serum_quality150_eligible.meta.json \
      --presets-per-category 25 --expected-categories 6 \
      --name quality150-from-q300-eligible
    python scripts/generate_quality_config.py \
      --base configs/quality300.yaml \
      --manifest /data/midibrave/manifests/serum_quality150_eligible.jsonl \
      --metadata /data/midibrave/manifests/serum_quality150_eligible.meta.json \
      --output configs/quality150_c9_optimized.yaml \
      --run-name midibrave_quality150_c9_optimized \
      --phase1-epochs 16 --phase2-epochs 2
    midibrave validate --config configs/quality150_c9_optimized.yaml
  '
