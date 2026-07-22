#!/usr/bin/env bash
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ROOT="$(cd "$ENGINE_DIR/.." && pwd -P)"
action="${1:-status}"

case "$action" in
  build)
    # shellcheck source=../../scripts/common.sh
    source "$ROOT/scripts/common.sh"
    lcs_docker build --network=host -f "$ENGINE_DIR/deploy/Dockerfile" -t "$LCS_IMAGE" "$ENGINE_DIR"
    ;;
  start|restart)
    exec "$ROOT/scripts/start.sh"
    ;;
  stop)
    exec "$ROOT/scripts/stop.sh"
    ;;
  status)
    exec "$ROOT/scripts/status.sh"
    ;;
  logs)
    exec "$ROOT/scripts/logs.sh"
    ;;
  *)
    echo "用法: $0 {build|start|restart|stop|status|logs}" >&2
    exit 2
    ;;
esac
