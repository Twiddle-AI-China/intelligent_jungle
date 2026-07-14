#!/usr/bin/env bash
set -euo pipefail

: "${PROBE_DIR:?Set PROBE_DIR to a completed lcs-model-probe output directory}"
TARGET_DIR="${TARGET_DIR:-../mvp-assets}"

manifest="$PROBE_DIR/manifest.json"
if [[ ! -f "$manifest" ]]; then
  echo "Probe manifest not found: $manifest" >&2
  exit 2
fi

uv run python - "$manifest" "$PROBE_DIR" "$TARGET_DIR" <<'PY'
import json, pathlib, shutil, sys
manifest_path, source, target = map(pathlib.Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
if not manifest.get("automated_render_safety_passed"):
    raise SystemExit("refusing to install a texture bank that failed automated safety checks")
files = manifest.get("files", [])
if len(files) < 12:
    raise SystemExit(f"expected at least 12 safe texture files, found {len(files)}")
target.mkdir(parents=True, exist_ok=True)
shutil.copy2(manifest_path, target / "manifest.json")
for name in files:
    shutil.copy2(source / name, target / name)
print(f"installed={len(files)} target={target}")
PY
