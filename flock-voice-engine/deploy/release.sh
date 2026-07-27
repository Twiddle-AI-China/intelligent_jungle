#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
exec env PYTHONDONTWRITEBYTECODE=1 python3 "$SCRIPT_DIR/release_control.py" "$@"
