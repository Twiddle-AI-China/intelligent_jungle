#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

lcs_docker logs -f --tail "${LCS_LOG_TAIL:-100}" "$LCS_CONTAINER_NAME"
