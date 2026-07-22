#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

if lcs_docker inspect "$LCS_CONTAINER_NAME" >/dev/null 2>&1; then
  lcs_docker rm -f "$LCS_CONTAINER_NAME" >/dev/null
  echo "已停止并移除容器 $LCS_CONTAINER_NAME"
else
  echo "容器 $LCS_CONTAINER_NAME 未运行"
fi
