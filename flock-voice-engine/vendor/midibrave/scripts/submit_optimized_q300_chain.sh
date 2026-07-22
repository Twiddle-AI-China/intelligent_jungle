#!/usr/bin/env bash
set -euo pipefail
cd /home/jyhu/MidiBrave

build=$(sbatch --parsable scripts/build_optimized_gpu1.sbatch)
smoke=$(sbatch --parsable --dependency="afterok:${build}" scripts/smoke_gpu8_candidate.sbatch)
cache=$(sbatch --parsable --dependency="afterok:${smoke}" scripts/preprocess_strict_gpu8.sbatch)
finalize=$(sbatch --parsable --dependency="afterok:${cache}" scripts/finalize_strict_gpu1.sbatch)
gate=$(sbatch --parsable --dependency="afterok:${finalize}" scripts/optimized_gate_gpu8.sbatch)
train=$(sbatch --parsable --dependency="afterok:${gate}" scripts/train_quality300_gpu8.sbatch)
eval_phase1=$(sbatch --parsable --dependency="afterok:${train}" \
  --job-name=midibrave-612-eval-p1 scripts/evaluate_quality300_gpu1.sbatch \
  phase1 /data/midibrave/evaluation/quality300-optimized-phase1)
eval_phase2=$(sbatch --parsable --dependency="afterok:${eval_phase1}" \
  --job-name=midibrave-613-eval-p2 scripts/evaluate_quality300_gpu1.sbatch \
  phase2 /data/midibrave/evaluation/quality300-optimized-phase2)

printf 'build=%s\nsmoke=%s\njob609_cache=%s\njob610_finalize=%s\ngate=%s\njob611_q300=%s\njob612_eval_phase1=%s\njob613_eval_phase2=%s\n' \
  "$build" "$smoke" "$cache" "$finalize" "$gate" "$train" "$eval_phase1" "$eval_phase2"
