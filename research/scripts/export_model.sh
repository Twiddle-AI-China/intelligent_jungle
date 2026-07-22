#!/usr/bin/env bash
set -euo pipefail

: "${RUN_PATH:?Set RUN_PATH to a RAVE run or BRAVE checkpoint}"

if [[ -z "${CUDA_VISIBLE_DEVICES:-}" ]]; then
  echo "Run export inside qgpu so the model environment matches training." >&2
  exit 2
fi

args=(export --run "$RUN_PATH" --streaming)
if [[ "${MODEL_KIND:-rave}" == "brave" ]]; then
  # BRAVE's standard TorchScript path uses the same RAVE exporter. Its H5
  # Minifusion export is evaluated separately because it has a different host.
  args=(export --run "$RUN_PATH")
fi
uv run rave "${args[@]}"
