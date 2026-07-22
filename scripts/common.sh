#!/usr/bin/env bash
set -euo pipefail

LCS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
LCS_ROOT="$(cd "$LCS_SCRIPT_DIR/.." && pwd -P)"
LCS_ENGINE_ROOT="$LCS_ROOT/flock-voice-engine"
LCS_CONTAINER_NAME="${LCS_CONTAINER_NAME:-latent-cosmos-synth}"
LCS_IMAGE="${LCS_IMAGE:-latent-cosmos-synth:local}"
LCS_HOST_PORT="${LCS_HOST_PORT:-8090}"
LCS_CONTAINER_PORT=8090
LCS_HOST_SITE_PACKAGES="${LCS_HOST_SITE_PACKAGES:-/usr/local/lib/python3.12/dist-packages}"

if [[ -f "$LCS_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$LCS_ROOT/.env"
  set +a
fi

if docker info >/dev/null 2>&1; then
  LCS_DOCKER_PREFIX=()
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  LCS_DOCKER_PREFIX=(sudo)
else
  LCS_DOCKER_PREFIX=()
fi

lcs_docker() {
  "${LCS_DOCKER_PREFIX[@]}" docker "$@"
}

export LCS_ROOT LCS_ENGINE_ROOT LCS_CONTAINER_NAME LCS_IMAGE
export LCS_HOST_PORT LCS_CONTAINER_PORT LCS_HOST_SITE_PACKAGES
