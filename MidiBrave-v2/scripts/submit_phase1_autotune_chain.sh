#!/usr/bin/env bash
set -euo pipefail
cd /home/jyhu/MidiBrave
campaign="${1:-phase1-auto-$(date +%Y%m%d-%H%M%S)}"
if [[ ! "$campaign" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "campaign must contain only letters, digits, dot, underscore, or dash" >&2
  exit 2
fi
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
mkdir -p "$root"
if [[ -e "${root}/jobs.txt" ]]; then
  echo "campaign already submitted: $campaign" >&2
  exit 1
fi

build=$(sbatch --parsable scripts/build_phase1_autotune_gpu1.sbatch "$campaign")
autotune=$(sbatch --parsable --dependency="afterok:${build}" \
  scripts/phase1_autotune_gpu8.sbatch "$campaign")
prepare=$(sbatch --parsable --dependency="afterok:${autotune}" \
  scripts/prepare_phase1_autotune_gpu1.sbatch "$campaign")
q50_baseline=$(sbatch --parsable --dependency="afterok:${prepare}" \
  --job-name=midibrave-q50-base scripts/train_q50_phase1_autotune_gpu8.sbatch \
  "$campaign" baseline)
q50_baseline_eval=$(sbatch --parsable --dependency="afterok:${q50_baseline}" \
  --job-name=midibrave-q50-base-eval scripts/evaluate_q50_phase1_autotune_gpu1.sbatch \
  "$campaign" baseline)
q50_candidate=$(sbatch --parsable --dependency="afterok:${q50_baseline_eval}" \
  --job-name=midibrave-q50-cand scripts/train_q50_phase1_autotune_gpu8.sbatch \
  "$campaign" candidate)
q50_candidate_eval=$(sbatch --parsable --dependency="afterok:${q50_candidate}" \
  --job-name=midibrave-q50-cand-eval scripts/evaluate_q50_phase1_autotune_gpu1.sbatch \
  "$campaign" candidate)
finalize=$(sbatch --parsable --dependency="afterok:${q50_candidate_eval}" \
  scripts/finalize_phase1_autotune_gpu1.sbatch "$campaign")
pilot=$(sbatch --parsable --dependency="afterok:${finalize}" \
  --job-name=midibrave-full-p1-e1 scripts/train_full_phase1_autotune_gpu8.sbatch \
  "$campaign" pilot)
pilot_gate=$(sbatch --parsable --dependency="afterok:${pilot}" \
  scripts/evaluate_full_phase1_pilot_gpu1.sbatch "$campaign")
continuation=$(sbatch --parsable --dependency="afterok:${pilot_gate}" \
  --job-name=midibrave-full-p1-run scripts/train_full_phase1_autotune_gpu8.sbatch \
  "$campaign" continue)
verify=$(sbatch --parsable --dependency="afterok:${continuation}" \
  scripts/verify_full_phase1_gpu1.sbatch "$campaign")

printf '%s\n' \
  "campaign=${campaign}" \
  "build=${build}" \
  "autotune=${autotune}" \
  "prepare_q50=${prepare}" \
  "q50_baseline=${q50_baseline}" \
  "q50_baseline_eval=${q50_baseline_eval}" \
  "q50_candidate=${q50_candidate}" \
  "q50_candidate_eval=${q50_candidate_eval}" \
  "finalize=${finalize}" \
  "full_phase1_epoch1=${pilot}" \
  "full_phase1_epoch1_gate=${pilot_gate}" \
  "full_phase1_continuation=${continuation}" \
  "full_phase1_verify=${verify}" \
  "phase2=NOT_SUBMITTED" | tee "${root}/jobs.txt"
