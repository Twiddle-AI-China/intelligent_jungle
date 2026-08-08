#!/usr/bin/env bash
#SBATCH --job-name=midibrave-roamer
# Spark 当前未启用 AccountingStorage；显式 --account 会导致 InvalidAccount。
#SBATCH --partition=gpu
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --output=midibrave-roamer-%j.log

set -euo pipefail

: "${CUDA_VISIBLE_DEVICES:?This service must run inside a SLURM GPU allocation}"
: "${MIDIBRAVE_ROAMER_ROOT:?Set MIDIBRAVE_ROAMER_ROOT to the real checkout path on Spark}"
: "${MIDIBRAVE_VENDOR_ROOT:?Set MIDIBRAVE_VENDOR_ROOT to a verified vendor snapshot directory}"
: "${MIDIBRAVE_MODEL_ROOT:?Set MIDIBRAVE_MODEL_ROOT to the verified checkpoint directory}"
: "${MIDIBRAVE_CALIBRATION_ROOT:?Set MIDIBRAVE_CALIBRATION_ROOT to the voice_defaults directory}"

image="${MIDIBRAVE_ROAMER_IMAGE:-midibrave-roamer:local}"
port="${MIDIBRAVE_ROAMER_PORT:-8092}"
container="midibrave-roamer-${SLURM_JOB_ID}"
tunnel_destination="${MIDIBRAVE_TUNNEL_DESTINATION:-}"
tunnel_key="${MIDIBRAVE_TUNNEL_KEY:-}"
tunnel_remote_port="${MIDIBRAVE_TUNNEL_REMOTE_PORT:-18092}"
tunnel_pid=""

cleanup() {
  status=$?
  trap - EXIT INT TERM
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [[ -n "$tunnel_pid" ]]; then
    pkill -TERM -P "$tunnel_pid" >/dev/null 2>&1 || true
    kill "$tunnel_pid" >/dev/null 2>&1 || true
    wait "$tunnel_pid" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

if [[ -n "$tunnel_destination" ]]; then
  : "${tunnel_key:?Set MIDIBRAVE_TUNNEL_KEY when MIDIBRAVE_TUNNEL_DESTINATION is set}"
  tunnel_supervisor() {
    while true; do
      /usr/bin/ssh -NT \
        -o BatchMode=yes \
        -o ExitOnForwardFailure=yes \
        -o ServerAliveInterval=20 \
        -o ServerAliveCountMax=3 \
        -i "$tunnel_key" \
        -R "127.0.0.1:${tunnel_remote_port}:127.0.0.1:${port}" \
        "$tunnel_destination"
      status=$?
      echo "Midibrave reverse tunnel exited with status $status; retrying in 5s" >&2
      sleep 5
    done
  }
  tunnel_supervisor &
  tunnel_pid=$!
  sleep 1
  if ! kill -0 "$tunnel_pid" >/dev/null 2>&1; then
    wait "$tunnel_pid"
  fi
fi

docker run -d \
  --name "$container" \
  --gpus all \
  --network host \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  -v "$MIDIBRAVE_VENDOR_ROOT:/app/flock-voice-engine/vendor:ro" \
  -v "$MIDIBRAVE_MODEL_ROOT:/data/model_weights/midiBrave:ro" \
  -v "$MIDIBRAVE_CALIBRATION_ROOT:/app/flock-voice-engine/assets/timbre/voice_defaults:ro" \
  "$image" \
  --backend neural --host 0.0.0.0 --port "$port" --skip-assemble \
  >/dev/null

while true; do
  if ! running=$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null); then
    echo "Midibrave container disappeared while SLURM job was running" >&2
    exit 1
  fi
  if [[ "$running" != "true" ]]; then
    status=$(docker inspect --format '{{.State.ExitCode}}' "$container")
    exit "$status"
  fi
  sleep 5
done
