#!/usr/bin/env bash
set -euo pipefail

cd /home/jyhu/MidiBrave-v2
mkdir -p artifacts /data/midibrave-v2/reports

qualification_job="${1:-977}"
precision="${2:-safe_fallback}"
case "$precision" in
  safe_fallback|fp16_candidate) ;;
  *) echo "unsupported precision profile: $precision" >&2; exit 2 ;;
esac

classes=(pad lead base pluck texture)
targets=(10000 20000 30000 40000 50000 60000 70000 80000 90000 100000)
report="/data/midibrave-v2/reports/clap_recon_formal_100k_jobs.json"
tmp="${report}.tmp"

printf '{\n' > "$tmp"
printf '  "qualification_job": "%s",\n' "$qualification_job" >> "$tmp"
printf '  "precision_profile": "%s",\n' "$precision" >> "$tmp"
printf '  "submitted_at": "%s",\n' "$(date --iso-8601=seconds)" >> "$tmp"
printf '  "models": {\n' >> "$tmp"

for class_index in "${!classes[@]}"; do
  class_name="${classes[$class_index]}"
  config="configs/v2/generated_clap_recon_top50_100k/${class_name}_${precision}.yaml"
  [[ -f "$config" ]] || { echo "missing config: $config" >&2; exit 1; }

  dependency="$qualification_job"
  printf '    "%s": {"config": "%s", "chunks": {' "$class_name" "$config" >> "$tmp"
  for target_index in "${!targets[@]}"; do
    target="${targets[$target_index]}"
    job_id=$(sbatch --parsable --dependency="afterok:${dependency}" \
      scripts/v2/train_clap_recon_gpu2.sbatch "$config" "$target")
    dependency="$job_id"
    [[ "$target_index" -gt 0 ]] && printf ', ' >> "$tmp"
    printf '"%s": "%s"' "$target" "$job_id" >> "$tmp"
  done
  printf '}}' >> "$tmp"
  [[ "$class_index" -lt $((${#classes[@]} - 1)) ]] && printf ',' >> "$tmp"
  printf '\n' >> "$tmp"
done

printf '  }\n}\n' >> "$tmp"
mv "$tmp" "$report"
cat "$report"
