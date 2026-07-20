#!/usr/bin/env bash
#SBATCH --job-name=midibrave-q300-audit
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --gres=gpu:1
#SBATCH --mem=8G
#SBATCH --time=00:30:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/audit-q300-%j.out
set -euo pipefail

srun docker run --rm --shm-size=2g \
  -v /home/jyhu/MidiBrave:/workspace/MidiBrave \
  -v /data:/data -w /workspace/MidiBrave \
  midibrave:v0.3.0-optimized python tools/audit_q300_results.py

docker image inspect midibrave:v0.3.0-optimized \
  --format 'image_id={{.Id}} created={{.Created}}'
