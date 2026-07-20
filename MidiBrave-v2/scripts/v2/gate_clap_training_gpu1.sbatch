#!/usr/bin/env bash
#SBATCH --job-name=mb-clap-gate
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=12G
#SBATCH --time=01:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/clap-gate-%j.out
set -euo pipefail
if [[ $# -ne 2 ]]; then echo "usage: sbatch gate_clap_training_gpu1.sbatch CONFIG TARGET" >&2; exit 2; fi
config="$1"
target="$2"
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=8g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  -e MIDIBRAVE_CONFIG="$config" -e MIDIBRAVE_TARGET="$target" \
  midibrave:v0.10.0-clap-recon bash -lc '
    run_name=$(python -c "from midibrave.config import Config; print(Config.load(\"$MIDIBRAVE_CONFIG\").train.run_name)")
    python scripts/v2/check_clap_training_gate.py \
      --config "$MIDIBRAVE_CONFIG" \
      --metrics "/data/midibrave-v2/runs/$run_name/phase1/metrics.jsonl" \
      --target "$MIDIBRAVE_TARGET" \
      --output "/data/midibrave-v2/reports/${run_name}_${MIDIBRAVE_TARGET}_gate.json"
  '
