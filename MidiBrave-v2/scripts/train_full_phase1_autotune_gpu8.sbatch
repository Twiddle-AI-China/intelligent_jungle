#!/usr/bin/env bash
#SBATCH --job-name=midibrave-full-p1
#SBATCH --partition=gpu8
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=96
#SBATCH --gres=gpu:8
#SBATCH --mem=110G
#SBATCH --time=1-12:00:00
#SBATCH --requeue
#SBATCH --output=/home/jyhu/MidiBrave/artifacts/full-phase1-%j.out
set -euo pipefail
if [[ $# -ne 2 || ( "$2" != "pilot" && "$2" != "continue" ) ]]; then
  echo "usage: sbatch train_full_phase1_autotune_gpu8.sbatch CAMPAIGN pilot|continue" >&2
  exit 2
fi
campaign="$1"
stage="$2"
root="/data/midibrave/profiling/phase1-autotune/${campaign}"
config="${root}/configs/full_phase1_selected.yaml"
decision="${root}/final-selection.json"
image="midibrave:v0.8.3-crepe-fallback"
run_name=$(awk '$1 == "run_name:" {print $2; exit}' "$config")
phase1_steps=$(awk '$1 == "phase1_steps:" {print $2; exit}' "$config")
checkpoint_every=$(awk '$1 == "checkpoint_every:" {print $2; exit}' "$config")
run_root="/data/midibrave/runs/${run_name}/phase1"
pilot_final=$(printf "%s/step-%09d.pt" "$run_root" "$checkpoint_every")
full_final=$(printf "%s/step-%09d.pt" "$run_root" "$phase1_steps")
# The trainer creates /data/midibrave/runs/<run> from inside Docker (root in
# the container).  The login user cannot and must not create children directly
# under the root-owned /data/midibrave/runs directory.
mkdir -p "${root}/monitor" "${root}/torch-kernels" "${root}/torchinductor"

if [[ "$stage" == "pilot" && -f "$pilot_final" ]]; then
  echo "full-data Phase1 pilot already complete: $pilot_final"
  exit 0
fi
if [[ "$stage" == "continue" && -f "$full_final" ]]; then
  echo "full-data Phase1 already complete: $full_final"
  exit 0
fi
[[ -f "$decision" ]] || { echo "missing final selection: $decision" >&2; exit 1; }
python3 -c \
  'import json,sys; d=json.load(open(sys.argv[1])); assert d["phase2_submitted"] is False' \
  "$decision"
nccl_mode=$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["selected_runtime"]["nccl_mode"])' \
  "$decision")
cpu_bind=$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["selected_runtime"]["cpu_bind"])' \
  "$decision")
nccl_args=(-e NCCL_IB_DISABLE=1)
if [[ "$nccl_mode" == "nvl" ]]; then nccl_args+=(-e NCCL_P2P_LEVEL=NVL); fi

resume_args=()
latest=$(find "$run_root" -maxdepth 1 -type f -name 'step-*.pt' 2>/dev/null | sort | tail -n 1 || true)
if [[ -n "$latest" ]]; then
  resume_args=(--resume "$latest")
  raw_checkpoint_step="${latest##*/step-}"
  raw_checkpoint_step="${raw_checkpoint_step%.pt}"
  checkpoint_step=$((10#$raw_checkpoint_step))
  audit_dir="${root}/resume-audit/job-${SLURM_JOB_ID}"
  mkdir -p "$audit_dir"
  # A failed attempt can append metrics beyond its last durable checkpoint.
  # Archive that evidence, then atomically trim only the uncheckpointed tail so
  # the resumed run has a monotonic, checkpoint-consistent metric history.
  srun --ntasks=1 --cpu-bind=cores docker run --rm \
    -v /data:/data \
    -e RUN_ROOT="$run_root" -e AUDIT_DIR="$audit_dir" \
    -e CHECKPOINT_STEP="$checkpoint_step" \
    "$image" python -c '
import json
import os
import shutil
from pathlib import Path

run_root = Path(os.environ["RUN_ROOT"])
audit_dir = Path(os.environ["AUDIT_DIR"])
checkpoint_step = int(os.environ["CHECKPOINT_STEP"])
metrics = run_root / "metrics.jsonl"
audit_dir.mkdir(parents=True, exist_ok=True)
summary = {"checkpoint_step": checkpoint_step, "kept": 0, "dropped": 0}
if metrics.exists():
    shutil.copy2(metrics, audit_dir / "metrics.pre-resume.jsonl")
    kept = []
    for line in metrics.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if int(row.get("generator_updates", -1)) <= checkpoint_step:
            kept.append(line)
        else:
            summary["dropped"] += 1
    summary["kept"] = len(kept)
    temporary = metrics.with_suffix(".resume.tmp")
    temporary.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
    temporary.replace(metrics)
(audit_dir / "summary.json").write_text(
    json.dumps(summary, sort_keys=True) + "\n", encoding="utf-8")
print(json.dumps(summary, sort_keys=True), flush=True)
'
fi
limit_args=()
if [[ "$stage" == "pilot" ]]; then
  limit_args=(--max-effective-updates "$checkpoint_every")
else
  [[ -f "$pilot_final" ]] || { echo "pilot checkpoint required: $pilot_final" >&2; exit 1; }
fi

monitor="${root}/monitor/full-${stage}-${SLURM_JOB_ID}.csv"
printf '%s\n' \
  'timestamp,index,gpu_util,memory_util,memory_used_mib,memory_total_mib,power_w,temperature_c,sm_clock_mhz,ecc_uncorrected,throttle_reasons' \
  > "$monitor"
nvidia-smi \
  --query-gpu=timestamp,index,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,temperature.gpu,clocks.sm,ecc.errors.uncorrected.volatile.total,clocks_throttle_reasons.active \
  --format=csv,noheader,nounits -l 5 >> "$monitor" 2>"${monitor%.csv}.err" &
monitor_pid=$!
trap 'kill "$monitor_pid" 2>/dev/null || true' EXIT

srun --kill-on-bad-exit=1 --cpu-bind="$cpu_bind" docker run --rm \
  --gpus "\"device=${CUDA_VISIBLE_DEVICES}\"" --shm-size=16g \
  -v /data:/data -w /workspace/MidiBrave \
  -e OMP_NUM_THREADS=1 -e MKL_NUM_THREADS=1 \
  -e PYTORCH_KERNEL_CACHE_PATH="${root}/torch-kernels" \
  -e TORCHINDUCTOR_CACHE_DIR="${root}/torchinductor" \
  -e TORCH_NCCL_ASYNC_ERROR_HANDLING=1 \
  "${nccl_args[@]}" \
  "$image" torchrun --standalone --nproc_per_node=8 -m midibrave.trainer \
    --config "$config" --phase 1 "${resume_args[@]}" "${limit_args[@]}"

if [[ "$stage" == "pilot" ]]; then
  [[ -f "$pilot_final" ]] || { echo "missing pilot checkpoint: $pilot_final" >&2; exit 1; }
else
  [[ -f "$full_final" ]] || { echo "missing final checkpoint: $full_final" >&2; exit 1; }
fi
