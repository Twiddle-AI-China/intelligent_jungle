#!/usr/bin/env bash
#SBATCH --job-name=midibrave-p1-auto-build
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=01:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/phase1-auto-build-%j.out
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo "usage: sbatch build_phase1_autotune_gpu1.sbatch CAMPAIGN" >&2
  exit 2
fi
campaign="$1"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
image="midibrave:v0.8.3-crepe-fallback"
mkdir -p "$root" /home/jyhu/MidiBrave/artifacts

srun --ntasks=1 --cpu-bind=cores bash -lc '
  set -euo pipefail
  cd /home/jyhu/MidiBrave
  docker build --pull=false -f Dockerfile.phase1-autotune \
    -t midibrave:v0.8.3-crepe-fallback .
'
srun --ntasks=1 --cpu-bind=cores docker run --rm --shm-size=4g \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python -m pytest -q
srun --ntasks=1 --cpu-bind=cores docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=4g \
  -v /data:/data -w /workspace/MidiBrave \
  "$image" python -m pytest -q tests/test_crepe_gpu.py

nvidia-smi \
  --query-gpu=timestamp,index,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,temperature.gpu,clocks.sm,ecc.errors.uncorrected.volatile.total,clocks_throttle_reasons.active \
  --format=csv,noheader,nounits > "${root}/nvidia-smi-probe.csv"
docker image inspect "$image" > "${root}/image-inspect.json"
cd /home/jyhu/MidiBrave
sha256sum .dockerignore Dockerfile.phase1-autotune pyproject.toml \
  configs/full_c9_optimized.yaml \
  src/midibrave/*.py scripts/*phase1* scripts/create_quality_subset.py \
  scripts/check_short_quality_gate.py training_profiles/pre_time_optimization_c9/* \
  > "${root}/source-contract.sha256"
