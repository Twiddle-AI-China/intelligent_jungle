#!/usr/bin/env bash
set -euo pipefail
cd /home/jyhu/MidiBrave

run_root=/data/midibrave/runs/midibrave_quality150_c9_optimized/phase1
for steps in 1448 4344 5792; do
  printf -v padded "%09d" "$steps"
  checkpoint="$run_root/step-$padded.pt"
  [[ -f "$checkpoint" ]] || { echo "missing checkpoint: $checkpoint" >&2; exit 1; }
done
final_metrics=/data/midibrave/evaluation/quality150-c9-phase1/metrics.json
[[ -f "$final_metrics" ]] || { echo "missing final metrics: $final_metrics" >&2; exit 1; }

job1448=$(sbatch --parsable --job-name=midibrave-q150-e1448 \
  scripts/evaluate_quality150_checkpoint_gpu1.sbatch 1448)
job4344=$(sbatch --parsable --job-name=midibrave-q150-e4344 \
  scripts/evaluate_quality150_checkpoint_gpu1.sbatch 4344)
job5792=$(sbatch --parsable --job-name=midibrave-q150-e5792 \
  scripts/evaluate_quality150_checkpoint_gpu1.sbatch 5792)
summary=$(sbatch --parsable \
  --dependency="afterok:${job1448}:${job4344}:${job5792}" \
  --job-name=midibrave-q150-summary \
  scripts/summarize_quality150_trajectory_gpu1.sbatch)

printf 'eval_1448=%s\neval_4344=%s\neval_5792=%s\nsummary=%s\n' \
  "$job1448" "$job4344" "$job5792" "$summary"
