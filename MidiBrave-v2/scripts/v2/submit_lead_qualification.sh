#!/usr/bin/env bash
set -euo pipefail
cd /home/jyhu/MidiBrave-v2
mkdir -p artifacts /data/midibrave-v2/reports

submit() { sbatch --parsable "$@"; }
# Reuse a previously completed, validated image build when supplied. This is
# useful after the explicit GPU runtime gate and keeps re-submission idempotent.
build="${MIDIBRAVE_BUILD_JOB:-}"
if [[ -z "$build" ]]; then
  build=$(submit scripts/v2/build_gpu1.sbatch)
fi
select=$(submit --dependency="afterok:$build" scripts/v2/select_gpu1.sbatch)
cache=$(submit --dependency="afterok:$select" scripts/v2/preprocess_lead_gpu1.sbatch)
validate=$(submit --dependency="afterok:$cache" scripts/v2/validate_lead_gpu1.sbatch)
probe=$(submit --dependency="afterok:$validate" scripts/v2/probe_precision_gpu1.sbatch)

safe200=$(submit --dependency="afterok:$probe" scripts/v2/train_lead_gpu2.sbatch \
  configs/v2/generated/lead_safe_fallback.yaml 200)
candidate200=$(submit --dependency="afterok:$safe200" scripts/v2/train_lead_gpu2.sbatch \
  configs/v2/generated/lead_fp16_candidate.yaml 200)
safe1000=$(submit --dependency="afterok:$candidate200" scripts/v2/train_lead_gpu2.sbatch \
  configs/v2/generated/lead_safe_fallback.yaml 1000)
candidate1000=$(submit --dependency="afterok:$safe1000" scripts/v2/train_lead_gpu2.sbatch \
  configs/v2/generated/lead_fp16_candidate.yaml 1000)
eval_safe1000=$(submit --dependency="afterok:$safe1000" scripts/v2/evaluate_lead_gpu1.sbatch safe_fallback 1000)
eval_candidate1000=$(submit --dependency="afterok:$candidate1000" scripts/v2/evaluate_lead_gpu1.sbatch fp16_candidate 1000)
gate1000=$(submit --dependency="afterok:$eval_safe1000:$eval_candidate1000" \
  scripts/v2/gate_precision_gpu1.sbatch 1000)

safe5000=$(submit --dependency="afterok:$gate1000" scripts/v2/train_lead_gpu2.sbatch \
  configs/v2/generated/lead_safe_fallback.yaml 5000)
candidate5000=$(submit --dependency="afterok:$safe5000" scripts/v2/train_lead_gpu2.sbatch \
  configs/v2/generated/lead_fp16_candidate.yaml 5000)
eval_safe5000=$(submit --dependency="afterok:$safe5000" scripts/v2/evaluate_lead_gpu1.sbatch safe_fallback 5000)
eval_candidate5000=$(submit --dependency="afterok:$candidate5000" scripts/v2/evaluate_lead_gpu1.sbatch fp16_candidate 5000)
gate5000=$(submit --dependency="afterok:$eval_safe5000:$eval_candidate5000" \
  scripts/v2/gate_precision_gpu1.sbatch 5000)

report=/data/midibrave-v2/reports/job_chain.json
printf '%s\n' \
  '{' \
  "  \"build\": \"$build\"," \
  "  \"select\": \"$select\"," \
  "  \"cache\": \"$cache\"," \
  "  \"validate\": \"$validate\"," \
  "  \"probe\": \"$probe\"," \
  "  \"safe200\": \"$safe200\"," \
  "  \"candidate200\": \"$candidate200\"," \
  "  \"safe1000\": \"$safe1000\"," \
  "  \"candidate1000\": \"$candidate1000\"," \
  "  \"eval_safe1000\": \"$eval_safe1000\"," \
  "  \"eval_candidate1000\": \"$eval_candidate1000\"," \
  "  \"gate1000\": \"$gate1000\"," \
  "  \"safe5000\": \"$safe5000\"," \
  "  \"candidate5000\": \"$candidate5000\"," \
  "  \"eval_safe5000\": \"$eval_safe5000\"," \
  "  \"eval_candidate5000\": \"$eval_candidate5000\"," \
  "  \"gate5000\": \"$gate5000\"" \
  '}' > "$report"
cat "$report"
