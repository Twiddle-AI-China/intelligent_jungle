#!/usr/bin/env bash
#SBATCH --job-name=midibrave-opt-smoke8
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=00:45:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/smoke8-v02-%j.out
set -euo pipefail
srun docker run --rm --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels \
  -e MIDIBRAVE_DETERMINISTIC=1 -e CUBLAS_WORKSPACE_CONFIG=:4096:8 \
  -e NCCL_P2P_LEVEL=NVL -e NCCL_IB_DISABLE=1 \
  -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
  midibrave:v0.3.0-optimized bash -lc '
    set -euo pipefail
    torchrun --standalone --nproc_per_node=8 scripts/test_ddp_atomic_step.py
    midibrave fixture --root fixtures/generated --samples 65536
    midibrave validate --config configs/smoke.yaml
    torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config configs/smoke.yaml --phase 1 --max-effective-updates 4
    torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config configs/smoke_resumed.yaml --phase 1 --max-effective-updates 2
    torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config configs/smoke_resumed.yaml --phase 1 --max-effective-updates 4 \
      --resume artifacts/candidate/smoke_resumed_v02/phase1/step-000000002.pt
    python scripts/compare_checkpoints.py \
      artifacts/candidate/smoke_continuous_v02/phase1/step-000000004.pt \
      artifacts/candidate/smoke_resumed_v02/phase1/step-000000004.pt \
      --atol 1e-6 --rtol 1e-5
    torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config configs/smoke.yaml --phase 2 --max-effective-updates 3 \
      --resume artifacts/candidate/smoke_continuous_v02/phase1/step-000000004.pt
    torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config configs/smoke_resumed.yaml --phase 2 --max-effective-updates 1 \
      --resume artifacts/candidate/smoke_resumed_v02/phase1/step-000000004.pt
    torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
      --config configs/smoke_resumed.yaml --phase 2 --max-effective-updates 3 \
      --resume artifacts/candidate/smoke_resumed_v02/phase2/step-000000001.pt
    python scripts/compare_checkpoints.py \
      artifacts/candidate/smoke_continuous_v02/phase2/step-000000003.pt \
      artifacts/candidate/smoke_resumed_v02/phase2/step-000000003.pt \
      --atol 1e-6 --rtol 1e-5
  '
