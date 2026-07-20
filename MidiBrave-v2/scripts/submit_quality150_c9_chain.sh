#!/usr/bin/env bash
set -euo pipefail
cd /home/jyhu/MidiBrave

prepare=$(sbatch --parsable scripts/prepare_quality150_gpu1.sbatch)
phase1=$(sbatch --parsable --dependency="afterok:${prepare}" \
  --job-name=midibrave-q150-p1 scripts/train_quality150_c9_gpu8.sbatch 1)
eval1=$(sbatch --parsable --dependency="afterok:${phase1}" \
  --job-name=midibrave-q150-eval-p1 scripts/evaluate_quality150_c9_gpu1.sbatch 1)
phase2=$(sbatch --parsable --dependency="afterok:${eval1}" \
  --job-name=midibrave-q150-p2 scripts/train_quality150_c9_gpu8.sbatch 2)
eval2=$(sbatch --parsable --dependency="afterok:${phase2}" \
  --job-name=midibrave-q150-eval-p2 scripts/evaluate_quality150_c9_gpu1.sbatch 2)

printf 'prepare=%s\nphase1=%s\neval_phase1_gate=%s\nphase2=%s\neval_phase2_gate=%s\n' \
  "$prepare" "$phase1" "$eval1" "$phase2" "$eval2"
