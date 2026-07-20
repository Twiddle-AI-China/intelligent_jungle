#!/usr/bin/env bash
#SBATCH --job-name=mbv2-precision-gate
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --gres=gpu:1
#SBATCH --mem=8G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/precision-gate-%j.out
set -euo pipefail
if [[ $# -ne 1 ]]; then echo "usage: sbatch gate_precision_gpu1.sbatch TARGET" >&2; exit 2; fi
target="$1"
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  midibrave:v0.9.0-five-model-fp16 python scripts/v2/check_precision_gate.py \
  --target "$target" --output "/data/midibrave-v2/reports/precision_gate_${target}.json"
