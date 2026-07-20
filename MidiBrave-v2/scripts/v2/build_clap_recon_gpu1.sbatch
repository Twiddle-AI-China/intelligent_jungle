#!/usr/bin/env bash
#SBATCH --job-name=mb-clap-build
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=12G
#SBATCH --time=02:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/clap-build-%j.out
set -euo pipefail
mkdir -p /home/jyhu/MidiBrave-v2/artifacts
cd /home/jyhu/MidiBrave-v2
docker build --pull=false -t midibrave:v0.10.0-clap-recon .
