#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

python3 "$SCRIPT_DIR/model_assets.py" verify \
  --manifest "$LCS_ROOT/config/model-assets.json" \
  --output "$LCS_ENGINE_ROOT/model_weights/midiBrave"

if [[ "$(lcs_docker inspect -f '{{.State.Running}}' "$LCS_CONTAINER_NAME" 2>/dev/null || true)" != "true" ]]; then
  echo "验收失败：容器 $LCS_CONTAINER_NAME 未运行。请先执行 ./scripts/start.sh。" >&2
  exit 1
fi

lcs_docker exec "$LCS_CONTAINER_NAME" \
  python3 /app/scripts/verify_runtime.py "http://127.0.0.1:$LCS_CONTAINER_PORT"
