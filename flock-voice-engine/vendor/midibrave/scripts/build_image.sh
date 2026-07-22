#!/usr/bin/env bash
set -euo pipefail
cd /home/jyhu/MidiBrave
image_tag="${1:-midibrave:v0.3.0-optimized}"
docker build --pull=false -t "$image_tag" .
