#!/usr/bin/env bash
#SBATCH --job-name=midibrave-resume-guard
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=00:45:00
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/resume-guard-%j.out
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: sbatch test_phase1_resume_guard_gpu8.sbatch CAMPAIGN [SUCCESSFUL_UPDATES]" >&2
  exit 2
fi

campaign="$1"
successful_updates="${2:-20}"
[[ "$successful_updates" =~ ^[1-9][0-9]*$ ]] || {
  echo "SUCCESSFUL_UPDATES must be a positive integer" >&2
  exit 2
}
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
config="${root}/configs/full_phase1_selected.yaml"
run_name=$(awk '$1 == "run_name:" {print $2; exit}' "$config")
checkpoint="/data/midibrave/runs/${run_name}/phase1/step-000075365.pt"
image="midibrave:v0.8.3-crepe-fallback"
smoke_root="${root}/resume-guard/job-${SLURM_JOB_ID}"

[[ -f "$config" ]] || { echo "missing config: $config" >&2; exit 1; }
[[ -f "$checkpoint" ]] || { echo "missing checkpoint: $checkpoint" >&2; exit 1; }
mkdir -p "$smoke_root" /home/jyhu/MidiBrave/artifacts

raw_step="${checkpoint##*/step-}"
raw_step="${raw_step%.pt}"
start_updates=$((10#$raw_step))
target_updates=$((start_updates + successful_updates))

srun --kill-on-bad-exit=1 --cpu-bind=cores docker run --rm \
  --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /data:/data \
  -v "$smoke_root:/data/midibrave/runs/${run_name}" \
  -v "$checkpoint:/resume/checkpoint.pt:ro" \
  -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
  -e NCCL_P2P_LEVEL=NVL -e NCCL_IB_DISABLE=1 \
  -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
  "$image" torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
    --config "$config" --phase 1 --resume /resume/checkpoint.pt \
    --max-effective-updates "$target_updates"

python3 - "$target_updates" "$successful_updates" \
  "$smoke_root/phase1/metrics.jsonl" <<'PY'
import json
import math
import sys
from pathlib import Path

target = int(sys.argv[1])
successful_updates = int(sys.argv[2])
metrics_path = Path(sys.argv[3])
rows = [json.loads(line) for line in metrics_path.read_text().splitlines() if line.strip()]
if not rows:
    raise SystemExit("resume guard produced no metrics")
last = rows[-1]
if int(last["generator_updates"]) != target:
    raise SystemExit(f"resume guard stopped at {last['generator_updates']} != {target}")
if int(last["gradients_finite"]) != 1:
    raise SystemExit("resume guard final update has non-finite gradients")
required = ("total", "cross_pitch", "self_pitch", "peak_cuda_reserved_gib")
bad_rows = []
for row in rows:
    bad = {name: row.get(name) for name in required
           if name in row and not math.isfinite(float(row[name]))}
    if bad:
        bad_rows.append({"loop_step": row.get("loop_step"), "values": bad})
if bad_rows:
    raise SystemExit(f"resume guard has non-finite forward metrics: {bad_rows[:5]}")
skipped = sum(int(row.get("gradients_finite", 1)) == 0 for row in rows)
maximum_skips = max(10, successful_updates // 250)
if skipped > maximum_skips:
    raise SystemExit(f"resume guard skipped {skipped} > {maximum_skips} updates")
if float(last["scale_after"]) < 2.0:
    raise SystemExit(f"resume guard scaler collapsed to {last['scale_after']}")
print(json.dumps({
    "status": "PASS",
    "start_updates": target - successful_updates,
    "final_updates": target,
    "successful_updates": successful_updates,
    "skipped_updates": skipped,
    "maximum_skips": maximum_skips,
    "scale_after": last["scale_after"],
    "peak_cuda_reserved_gib": last["peak_cuda_reserved_gib"],
    "effective_pairs_per_second": last["effective_pairs_per_second"],
}, sort_keys=True))
PY
