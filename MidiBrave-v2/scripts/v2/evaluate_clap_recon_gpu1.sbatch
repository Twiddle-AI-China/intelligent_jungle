#!/usr/bin/env bash
#SBATCH --job-name=mb-clap-eval
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=03:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/clap-eval-%j.out
set -euo pipefail
if [[ $# -ne 2 ]]; then echo "usage: sbatch evaluate_clap_recon_gpu1.sbatch CONFIG TARGET" >&2; exit 2; fi
config="$1"
target="$2"
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  -e MIDIBRAVE_CONFIG="$config" -e MIDIBRAVE_TARGET="$target" \
  midibrave:v0.10.0-clap-recon bash -lc '
    set -euo pipefail
    run_name=$(python -c "from midibrave.config import Config; print(Config.load(\"$MIDIBRAVE_CONFIG\").train.run_name)")
    checkpoint=$(printf "/data/midibrave-v2/runs/%s/phase1/step-%09d.pt" "$run_name" "$MIDIBRAVE_TARGET")
    output="/data/midibrave-v2/reports/${run_name}_${MIDIBRAVE_TARGET}_evaluation"
    python -m midibrave.evaluate --config "$MIDIBRAVE_CONFIG" \
      --checkpoint "$checkpoint" --output "$output" \
      --pairs 256 --batch-size 2 --examples 24 --grid-presets 1 --velocity-pairs 64
  '
