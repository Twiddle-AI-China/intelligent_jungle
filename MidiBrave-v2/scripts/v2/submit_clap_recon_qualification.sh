#!/usr/bin/env bash
set -euo pipefail
cd /home/jyhu/MidiBrave-v2
mkdir -p artifacts /data/midibrave-v2/reports
submit() { sbatch --parsable "$@"; }
config=configs/v2/generated_clap_recon_top50_100k/lead_safe_fallback.yaml

build=$(submit scripts/v2/build_clap_recon_gpu1.sbatch)
tests=$(submit --dependency="afterok:$build" scripts/v2/test_clap_recon_gpu1.sbatch)
prepare=$(submit --dependency="afterok:$tests" scripts/v2/prepare_top50_candidates_gpu1.sbatch)
cache=$(submit --dependency="afterok:$prepare" scripts/v2/preprocess_top50_gpu1.sbatch)
finalize=$(submit --dependency="afterok:$cache" scripts/v2/finalize_top50_gpu1.sbatch)
objective=$(submit --dependency="afterok:$finalize" scripts/v2/check_clap_objective_gpu1.sbatch)
train200=$(submit --dependency="afterok:$objective" scripts/v2/train_clap_recon_gpu2.sbatch "$config" 200)
gate200=$(submit --dependency="afterok:$train200" scripts/v2/gate_clap_training_gpu1.sbatch "$config" 200)
train1000=$(submit --dependency="afterok:$gate200" scripts/v2/train_clap_recon_gpu2.sbatch "$config" 1000)
gate1000=$(submit --dependency="afterok:$train1000" scripts/v2/gate_clap_training_gpu1.sbatch "$config" 1000)
eval1000=$(submit --dependency="afterok:$gate1000" scripts/v2/evaluate_clap_recon_gpu1.sbatch "$config" 1000)
quality1000=$(submit --dependency="afterok:$eval1000" scripts/v2/gate_clap_quality_gpu1.sbatch "$config" 1000)

report=/data/midibrave-v2/reports/clap_recon_qualification_chain.json
printf '%s\n' \
  '{' \
  "  \"build\": \"$build\"," \
  "  \"tests\": \"$tests\"," \
  "  \"prepare_top80\": \"$prepare\"," \
  "  \"cache_top80\": \"$cache\"," \
  "  \"finalize_top50\": \"$finalize\"," \
  "  \"clap_objective\": \"$objective\"," \
  "  \"train_200\": \"$train200\"," \
  "  \"gate_200\": \"$gate200\"," \
  "  \"train_1000\": \"$train1000\"," \
  "  \"gate_1000\": \"$gate1000\"," \
  "  \"evaluate_1000\": \"$eval1000\"," \
  "  \"quality_1000\": \"$quality1000\"" \
  '}' > "$report"
cat "$report"
