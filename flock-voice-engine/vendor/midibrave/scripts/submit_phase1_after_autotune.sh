#!/usr/bin/env bash
set -euo pipefail
cd /home/jyhu/MidiBrave
if [[ $# -ne 2 ]]; then
  echo "usage: submit_phase1_after_autotune.sh CAMPAIGN AUTOTUNE_JOB_ID" >&2
  exit 2
fi
campaign="$1"
autotune_job="$2"
[[ "$campaign" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid campaign" >&2; exit 2; }
[[ "$autotune_job" =~ ^[0-9]+$ ]] || { echo "invalid job id" >&2; exit 2; }
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
ledger="${root}/jobs-rewired.txt"
[[ ! -e "$ledger" ]] || { echo "rewired chain already exists" >&2; exit 1; }

rebuild=$(sbatch --parsable --dependency="afterok:${autotune_job}" \
  scripts/build_phase1_autotune_gpu1.sbatch "$campaign")
prepare=$(sbatch --parsable --dependency="afterok:${rebuild}" \
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
  "autotune=${autotune_job}" \
  "final_image_rebuild=${rebuild}" \
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
  "phase2=NOT_SUBMITTED" | tee "$ledger"
