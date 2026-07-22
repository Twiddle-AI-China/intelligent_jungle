#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

"$SCRIPT_DIR/doctor.sh"

python3 "$SCRIPT_DIR/model_assets.py" install \
  --manifest "$LCS_ROOT/config/model-assets.json" \
  --output "$LCS_ENGINE_ROOT/model_weights/midiBrave"

python3 "$SCRIPT_DIR/assemble_web.py" \
  --root "$LCS_ROOT" \
  --output "$LCS_ROOT/runtime/web"

mkdir -p "$LCS_ROOT/runtime/logs"

echo "构建镜像 $LCS_IMAGE"
lcs_docker build --network=host \
  -f "$LCS_ENGINE_ROOT/deploy/Dockerfile" \
  -t "$LCS_IMAGE" \
  "$LCS_ENGINE_ROOT"

echo "安装完成。下一步运行: ./scripts/start.sh"
