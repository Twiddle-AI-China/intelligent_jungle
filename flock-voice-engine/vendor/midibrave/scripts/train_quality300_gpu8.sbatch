#!/usr/bin/env bash
#SBATCH --job-name=midibrave-611-q300
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=48:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/quality300-%j.out
set -euo pipefail
mkdir -p /home/jyhu/MidiBrave/artifacts

# Keep each long training phase in a fresh container.  On this Octopus Docker
# runtime, starting a second torchrun after a multi-hour first phase in the same
# container can leave CUDA unavailable even though the Slurm allocation is
# healthy.  Separate containers retain the allocation and checkpoint resume
# semantics while resetting the CUDA runtime between phases.
run_phase() {
  local phase="$1"
  srun --kill-on-bad-exit=1 docker run --rm \
    --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
    -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
    -v /data:/data -w /workspace/MidiBrave \
    -e MIDIBRAVE_PHASE="$phase" \
    -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
    -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
    -e NCCL_P2P_LEVEL=NVL -e NCCL_IB_DISABLE=1 \
    -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
    midibrave:v0.3.0-optimized bash -lc '
    set -euo pipefail
    phase="${MIDIBRAVE_PHASE:?MIDIBRAVE_PHASE is required}"
    config="configs/quality300_eligible.yaml"
    midibrave validate --config "$config"
    run_root="/data/midibrave/runs/midibrave_quality300_optimized_v03"
    phase1_final=$(python -c "from midibrave.config import Config; c=Config.load(\"$config\"); print(f\"$run_root/phase1/step-{c.train.phase1_steps:09d}.pt\")")
    if [[ "$phase" == "1" ]]; then
      if [[ -f "$phase1_final" ]]; then
        echo "Phase 1 already complete: $phase1_final"
        exit 0
      fi
      phase1_resume=()
      latest_phase1=$(find "$run_root/phase1" -maxdepth 1 -type f -name "step-*.pt" 2>/dev/null | sort | tail -n 1 || true)
      if [[ -n "$latest_phase1" ]]; then
        phase1_resume=(--resume "$latest_phase1")
      fi
      torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
        --config "$config" --phase 1 "${phase1_resume[@]}"
      exit 0
    elif [[ "$phase" != "2" ]]; then
      echo "Unsupported phase: $phase" >&2
      exit 2
    fi

    if [[ ! -f "$phase1_final" ]]; then
      echo "Phase 1 final checkpoint is required: $phase1_final" >&2
      exit 1
    fi
    phase2_final=$(python -c "from midibrave.config import Config; c=Config.load(\"$config\"); print(f\"$run_root/phase2/step-{c.train.phase2_steps:09d}.pt\")")
    if [[ -f "$phase2_final" ]]; then
      echo "Phase 2 already complete: $phase2_final"
      exit 0
    fi
    phase2_resume="$phase1_final"
    latest_phase2=$(find "$run_root/phase2" -maxdepth 1 -type f -name "step-*.pt" 2>/dev/null | sort | tail -n 1 || true)
    if [[ -n "$latest_phase2" ]]; then
      phase2_resume="$latest_phase2"
    fi
    torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config "$config" --phase 2 --resume "$phase2_resume"
  '
}

run_phase 1
run_phase 2
