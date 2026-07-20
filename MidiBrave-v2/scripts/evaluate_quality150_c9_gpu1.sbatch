#!/usr/bin/env bash
#SBATCH --job-name=midibrave-q150-eval
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=02:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/quality150-eval-%j.out
set -euo pipefail
if [[ $# -ne 1 || ( "$1" != "1" && "$1" != "2" ) ]]; then
  echo "usage: sbatch evaluate_quality150_c9_gpu1.sbatch PHASE(1|2)" >&2
  exit 2
fi
mkdir -p /home/jyhu/MidiBrave/artifacts
phase="$1"

srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e MIDIBRAVE_PHASE="$phase" \
  -e PYTHONPATH=/workspace/MidiBrave/src \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  midibrave:v0.7.0-condition-gain bash -lc '
    set -euo pipefail
    config="configs/quality150_c9_optimized.yaml"
    phase="${MIDIBRAVE_PHASE:?MIDIBRAVE_PHASE is required}"
    run_name=$(python -c "from midibrave.config import Config; print(Config.load(\"$config\").train.run_name)")
    steps=$(python -c "from midibrave.config import Config; c=Config.load(\"$config\"); print(c.train.phase1_steps if int(\"$phase\") == 1 else c.train.phase2_steps)")
    checkpoint=$(printf "/data/midibrave/runs/%s/phase%s/step-%09d.pt" "$run_name" "$phase" "$steps")
    output="/data/midibrave/evaluation/quality150-c9-phase$phase"
    [[ -f "$checkpoint" ]] || { echo "missing checkpoint: $checkpoint" >&2; exit 1; }
    python -m midibrave.evaluate \
      --config "$config" --checkpoint "$checkpoint" --output "$output" \
      --pairs 256 --batch-size 2 --examples 24 --grid-presets 6
    gate_args=(
      --stage 5000
      --metrics "$output/metrics.json"
      --training-log "/data/midibrave/runs/$run_name/phase$phase/metrics.jsonl"
      --expected-updates "$steps"
      --output "$output/gate.json"
      --candidate "quality150-c9-phase$phase"
      --ignore-velocity
    )
    if [[ "$phase" == "2" ]]; then
      gate_args+=(
        --prior /data/midibrave/evaluation/quality150-c9-phase1/metrics.json
        --require-prior-improvement
      )
    fi
    python scripts/check_short_quality_gate.py "${gate_args[@]}"
  '
