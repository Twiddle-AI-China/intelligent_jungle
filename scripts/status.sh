#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

if [[ "$(lcs_docker inspect -f '{{.State.Running}}' "$LCS_CONTAINER_NAME" 2>/dev/null || true)" != "true" ]]; then
  echo "容器 $LCS_CONTAINER_NAME 未运行"
  exit 1
fi

lcs_docker ps --filter "name=^/${LCS_CONTAINER_NAME}$" \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -fsS --noproxy '*' "http://127.0.0.1:$LCS_HOST_PORT/api/runtime-status"
echo
