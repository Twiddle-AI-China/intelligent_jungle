#!/usr/bin/env bash
set -euo pipefail
cd /home/jyhu/MidiBrave

# Phase 1 has already been accepted on the deterministic q150 validation
# stream. Start only Phase 2 from its final checkpoint, then evaluate Phase 2
# against that exact Phase 1 stream.
config="configs/quality150_c9_optimized.yaml"
[[ -f "$config" ]] || { echo "missing config: $config" >&2; exit 1; }
run_name=$(awk '$1 == "run_name:" {print $2; exit}' "$config")
phase1_steps=$(awk '$1 == "phase1_steps:" {print $2; exit}' "$config")
[[ -n "$run_name" ]] || { echo "run_name missing from $config" >&2; exit 1; }
[[ "$phase1_steps" =~ ^[0-9]+$ ]] || {
  echo "invalid phase1_steps in $config: $phase1_steps" >&2
  exit 1
}
phase1_final=$(printf "/data/midibrave/runs/%s/phase1/step-%09d.pt" \
  "$run_name" "$phase1_steps")
phase1_metrics="/data/midibrave/evaluation/quality150-c9-phase1/metrics.json"
phase1_diagnostics="/data/midibrave/evaluation/quality150-c9-phase1/pitch_diagnostics.jsonl"

[[ -f "$phase1_final" ]] || { echo "missing Phase 1 final: $phase1_final" >&2; exit 1; }
[[ -f "$phase1_metrics" ]] || { echo "missing Phase 1 metrics: $phase1_metrics" >&2; exit 1; }
[[ -f "$phase1_diagnostics" ]] || {
  echo "missing Phase 1 pitch diagnostics: $phase1_diagnostics" >&2
  exit 1
}

phase2=$(sbatch --parsable --job-name=midibrave-q150-p2 \
  scripts/train_quality150_c9_gpu8.sbatch 2)
eval2=$(sbatch --parsable --dependency="afterok:${phase2}" \
  --job-name=midibrave-q150-eval-p2 scripts/evaluate_quality150_c9_gpu1.sbatch 2)

printf 'phase1=reused:%s\nphase2=%s\neval_phase2_gate=%s\n' \
  "$phase1_final" "$phase2" "$eval2"
