#!/usr/bin/env bash
#SBATCH --job-name=midibrave-opt-build
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=01:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/build-optimized-%j.out
set -euo pipefail

srun bash -lc '
  set -euo pipefail
  cd /home/jyhu/MidiBrave
  docker build --pull=false -t midibrave:v0.3.0-optimized .
'

srun docker run --rm --shm-size=4g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  midibrave:v0.3.0-optimized python -m pytest -q
