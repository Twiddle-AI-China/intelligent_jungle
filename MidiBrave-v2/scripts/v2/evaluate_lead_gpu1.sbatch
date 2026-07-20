#!/usr/bin/env bash
#SBATCH --job-name=mbv2-lead-eval
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=03:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/lead-eval-%j.out
set -euo pipefail
if [[ $# -ne 2 ]]; then echo "usage: sbatch evaluate_lead_gpu1.sbatch POLICY TARGET" >&2; exit 2; fi
policy="$1"
target="$2"
config="configs/v2/generated/lead_${policy}.yaml"
checkpoint=$(printf "/data/midibrave-v2/runs/lead_%s/phase1/step-%09d.pt" "$policy" "$target")
output="/data/midibrave-v2/reports/lead_${policy}_${target}"
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  midibrave:v0.9.0-five-model-fp16 python -m midibrave.evaluate \
  --config "$config" --checkpoint "$checkpoint" --output "$output" \
  --pairs 256 --batch-size 2 --examples 24 --grid-presets 1 --velocity-pairs 64
