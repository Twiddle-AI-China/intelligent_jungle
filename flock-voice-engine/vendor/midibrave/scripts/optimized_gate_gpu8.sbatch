#!/usr/bin/env bash
#SBATCH --job-name=midibrave-opt-gate8
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=02:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/optimized-gate-%j.out
set -euo pipefail

srun docker run --rm --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e SLURM_JOB_ID -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  -e NCCL_P2P_LEVEL=NVL -e NCCL_IB_DISABLE=1 \
  -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
  midibrave:v0.3.0-optimized bash -lc '
    set -euo pipefail
    updates=25
    config="/tmp/midibrave-optimized-gate.yaml"
    python scripts/generate_optimized_gate_config.py \
      --base configs/quality300_eligible.yaml --output "$config" \
      --job-id "$SLURM_JOB_ID" --updates "$updates"
    run_name="optimized_gate_job${SLURM_JOB_ID}"
    torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config "$config" --phase 1 --max-effective-updates "$updates"
    phase1_checkpoint="/data/midibrave/benchmarks/${run_name}/phase1/step-000000025.pt"
    torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config "$config" --phase 2 --max-effective-updates "$updates" \
      --resume "$phase1_checkpoint"
    summary="/data/midibrave/benchmarks/${run_name}/summary.json"
    python scripts/summarize_sweep.py \
      --phase1 "/data/midibrave/benchmarks/${run_name}/phase1/metrics.jsonl" \
      --phase2 "/data/midibrave/benchmarks/${run_name}/phase2/metrics.jsonl" \
      --batch-per-gpu 10 --grad-accum 1 --updates "$updates" > "$summary"
    python scripts/check_optimized_gate.py --summary "$summary"
  '
