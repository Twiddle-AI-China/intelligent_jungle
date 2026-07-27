#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 2 ]]; then echo "usage: verify-candidate.sh RELEASE_DIR BASE_URL" >&2; exit 2; fi
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
exec python3 "$SCRIPT_DIR/release_control.py" verify-candidate --release-dir "$1" --base-url "$2"
