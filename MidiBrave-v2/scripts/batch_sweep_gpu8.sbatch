#!/usr/bin/env bash
#SBATCH --job-name=midibrave-batch-sweep
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=03:00:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/batch-sweep-%j.out
set -euo pipefail
srun docker run --rm --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e SLURM_JOB_ID -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e NCCL_P2P_LEVEL=NVL -e NCCL_IB_DISABLE=1 \
  -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
  midibrave:v0.2.1-serum bash -lc '
    set -u
    for batch in 1 2 4 8; do
      accumulation=$((64 / (8 * batch)))
      config="/tmp/midibrave-sweep-b${batch}.yaml"
      python scripts/generate_sweep_config.py \
        --base configs/quality300_eligible.yaml --output "$config" \
        --batch-per-gpu "$batch" --job-id "$SLURM_JOB_ID"
      run_name="batch${batch}_job${SLURM_JOB_ID}"
      torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
        --config "$config" --phase 1 --max-effective-updates 25
      phase1_status=$?
      if [[ $phase1_status -ne 0 ]]; then
        echo "batch=${batch} phase=1 status=${phase1_status}"
        break
      fi
      phase1_checkpoint="/data/midibrave/benchmarks/${run_name}/phase1/step-000000025.pt"
      torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
        --config "$config" --phase 2 --max-effective-updates 25 \
        --resume "$phase1_checkpoint"
      phase2_status=$?
      if [[ $phase2_status -ne 0 ]]; then
        echo "batch=${batch} phase=2 status=${phase2_status}"
        break
      fi
      python scripts/summarize_sweep.py \
        --phase1 "/data/midibrave/benchmarks/${run_name}/phase1/metrics.jsonl" \
        --phase2 "/data/midibrave/benchmarks/${run_name}/phase2/metrics.jsonl" \
        --batch-per-gpu "$batch" --grad-accum "$accumulation"
    done
  '
