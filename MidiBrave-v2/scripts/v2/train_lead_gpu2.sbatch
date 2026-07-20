#!/usr/bin/env bash
#SBATCH --job-name=mbv2-lead-train
#SBATCH --partition=gpu2
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --gres=gpu:2
#SBATCH --mem=28G
#SBATCH --time=12:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/lead-train-%j.out
set -euo pipefail
if [[ $# -ne 2 ]]; then echo "usage: sbatch train_lead_gpu2.sbatch CONFIG TARGET" >&2; exit 2; fi
config="$1"
target="$2"
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=16g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
  -e NCCL_P2P_LEVEL=NVL -e NCCL_IB_DISABLE=1 -e NCCL_TIMEOUT=1800 \
  -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 -e MIDIBRAVE_TRACK_ACTIVATIONS=1 \
  -e MIDIBRAVE_CONFIG="$config" -e MIDIBRAVE_TARGET="$target" \
  midibrave:v0.9.0-five-model-fp16 bash -lc '
    set -euo pipefail
    run_name=$(python -c "from midibrave.config import Config; print(Config.load(\"$MIDIBRAVE_CONFIG\").train.run_name)")
    run_dir="/data/midibrave-v2/runs/$run_name/phase1"
    final=$(printf "%s/step-%09d.pt" "$run_dir" "$MIDIBRAVE_TARGET")
    [[ -f "$final" ]] && { echo "already complete: $final"; exit 0; }
    resume_args=()
    latest=$(find "$run_dir" -maxdepth 1 -type f -name "step-*.pt" 2>/dev/null | sort | tail -n 1 || true)
    [[ -n "$latest" ]] && resume_args=(--resume "$latest")
    torchrun --standalone --nproc_per_node=2 -m midibrave.trainer \
      --config "$MIDIBRAVE_CONFIG" --phase 1 --max-effective-updates "$MIDIBRAVE_TARGET" \
      "${resume_args[@]}"
    [[ -f "$final" ]] || { echo "missing target checkpoint: $final" >&2; exit 1; }
  '
