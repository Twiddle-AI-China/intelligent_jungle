#!/usr/bin/env bash
#SBATCH --job-name=midibrave-q150-train
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=06:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/quality150-train-%j.out
set -euo pipefail
if [[ $# -ne 1 || ( "$1" != "1" && "$1" != "2" ) ]]; then
  echo "usage: sbatch train_quality150_c9_gpu8.sbatch PHASE(1|2)" >&2
  exit 2
fi
mkdir -p /home/jyhu/MidiBrave/artifacts
phase="$1"

# Preserve the inner quotes: Docker's --gpus parser otherwise treats an
# eight-device comma list as both Count and DeviceIDs.
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e MIDIBRAVE_PHASE="$phase" \
  -e PYTHONPATH=/workspace/MidiBrave/src \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  -e NCCL_P2P_LEVEL=NVL -e NCCL_IB_DISABLE=1 \
  -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
  midibrave:v0.7.0-condition-gain bash -lc '
    set -euo pipefail
    config="configs/quality150_c9_optimized.yaml"
    phase="${MIDIBRAVE_PHASE:?MIDIBRAVE_PHASE is required}"
    midibrave validate --config "$config"
    run_name=$(python -c "from midibrave.config import Config; print(Config.load(\"$config\").train.run_name)")
    run_root="/data/midibrave/runs/$run_name"
    phase1_steps=$(python -c "from midibrave.config import Config; print(Config.load(\"$config\").train.phase1_steps)")
    phase2_steps=$(python -c "from midibrave.config import Config; print(Config.load(\"$config\").train.phase2_steps)")
    phase1_final=$(printf "%s/phase1/step-%09d.pt" "$run_root" "$phase1_steps")

    if [[ "$phase" == "1" ]]; then
      if [[ -f "$phase1_final" ]]; then
        echo "Phase 1 already complete: $phase1_final"
        exit 0
      fi
      resume_args=()
      latest=$(find "$run_root/phase1" -maxdepth 1 -type f -name "step-*.pt" 2>/dev/null | sort | tail -n 1 || true)
      if [[ -n "$latest" ]]; then resume_args=(--resume "$latest"); fi
      torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
        --config "$config" --phase 1 "${resume_args[@]}"
      [[ -f "$phase1_final" ]] || { echo "missing Phase 1 final: $phase1_final" >&2; exit 1; }
      exit 0
    fi

    [[ -f "$phase1_final" ]] || { echo "Phase 1 final required: $phase1_final" >&2; exit 1; }
    phase2_final=$(printf "%s/phase2/step-%09d.pt" "$run_root" "$phase2_steps")
    if [[ -f "$phase2_final" ]]; then
      echo "Phase 2 already complete: $phase2_final"
      exit 0
    fi
    resume="$phase1_final"
    latest=$(find "$run_root/phase2" -maxdepth 1 -type f -name "step-*.pt" 2>/dev/null | sort | tail -n 1 || true)
    if [[ -n "$latest" ]]; then resume="$latest"; fi
    torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config "$config" --phase 2 --resume "$resume"
    [[ -f "$phase2_final" ]] || { echo "missing Phase 2 final: $phase2_final" >&2; exit 1; }
  '
