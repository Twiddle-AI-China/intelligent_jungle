#!/bin/bash
#SBATCH --job-name=midibrave-prof8
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --mem=110G
#SBATCH --gres=gpu:8
#SBATCH --time=01:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/profile-gpu8-%j.out

set -euo pipefail

mkdir -p /data/midibrave/profiling

for phase in 1 2; do
  output="/data/midibrave/profiling/gpu8-${SLURM_JOB_ID}/phase${phase}"
  srun docker run --rm --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
    -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
    -v /data:/data \
    -w /workspace/MidiBrave \
    -e OMP_NUM_THREADS=1 \
    -e MKL_NUM_THREADS=1 \
    -e NCCL_P2P_LEVEL=NVL \
    -e NCCL_IB_DISABLE=1 \
    -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
    -e PROFILE_PHASE="${phase}" \
    -e PROFILE_OUTPUT="${output}" \
    -e PROFILE_CONFIG=/workspace/MidiBrave/configs/quality300_eligible.yaml \
    midibrave:v0.2.1-serum \
    torchrun --standalone --nproc_per_node=8 scripts/profile_runtime.py
done
