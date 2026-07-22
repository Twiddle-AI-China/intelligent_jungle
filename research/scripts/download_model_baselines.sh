#!/usr/bin/env bash
set -euo pipefail

root="${1:-../models/external}"
mkdir -p "$root"

download() {
  local name="$1" url="$2" expected="$3"
  local target="$root/$name"
  if [[ ! -f "$target" ]] || [[ "$(shasum -a 256 "$target" | awk '{print $1}')" != "$expected" ]]; then
    curl -L --fail --retry 3 --progress-bar -o "$target.part" "$url"
    mv "$target.part" "$target"
  fi
  local actual
  actual="$(shasum -a 256 "$target" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "checksum mismatch: $target" >&2; exit 2; }
  printf '%s  %s\n' "$actual" "$target"
}

download freesoundloop10k_raspi_b2048_r44100_z16.ts \
  https://huggingface.co/Tangible-Music-Lab/RAVE_models/resolve/main/freesoundloop10k_raspi_b2048_r44100_z16.ts \
  3ec093e132ce75d7fee3b8b734c739ebf8711a57ee332a60bce4359e2e34073e

download mrp_strengjavera_b2048_r44100_z16.ts \
  https://huggingface.co/Intelligent-Instruments-Lab/rave-models/resolve/main/mrp_strengjavera_b2048_r44100_z16.ts \
  28cb170630b6675bc7b0ef94e42bf6c11f2db08c0805d2a91576d140a83063ff
