#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


class AssetVerificationError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_file(path: Path, label: str) -> Path:
    if not path.is_file():
        raise AssetVerificationError(f"missing {label}: {path}")
    return path


def verify_assets(
    manifest_path: Path,
    model_root: Path,
    vendor_root: Path,
    calibration_root: Path,
) -> list[str]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    verified: list[str] = []
    for model in manifest["models"]:
        checkpoint = require_file(model_root / model["checkpoint"]["filename"], "checkpoint")
        actual_bytes = checkpoint.stat().st_size
        if actual_bytes != model["checkpoint"]["bytes"]:
            raise AssetVerificationError(
                f"{checkpoint.name} bytes {actual_bytes} != {model['checkpoint']['bytes']}"
            )
        actual_sha = sha256(checkpoint)
        if actual_sha != model["checkpoint"]["sha256"]:
            raise AssetVerificationError(
                f"{checkpoint.name} sha256 {actual_sha} != {model['checkpoint']['sha256']}"
            )
        verified.append(f"checkpoint:{checkpoint.name}")

        vendor_name = "midibrave-v2" if model["engine"] == "midibrave-v2" else "trajectorybrave"
        config = require_file(vendor_root / vendor_name / "configs" / model["config"], "config")
        expected_config_sha = model.get("configSha256")
        if expected_config_sha and sha256(config) != expected_config_sha:
            raise AssetVerificationError(f"config sha256 mismatch: {config}")
        require_file(vendor_root / vendor_name / "src" / vendor_name.replace("-v2", "") / "__init__.py", "vendor source")
        verified.append(f"config:{vendor_name}/{config.name}")

        calibration = require_file(calibration_root / model["calibration"], "calibration")
        verified.append(f"calibration:{calibration.name}")
    return verified


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify a complete MidiBrave Roamer neural asset set")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--vendor-root", type=Path, required=True)
    parser.add_argument("--calibration-root", type=Path, required=True)
    args = parser.parse_args()
    try:
        verified = verify_assets(
            args.manifest, args.model_root, args.vendor_root, args.calibration_root,
        )
    except (AssetVerificationError, OSError, KeyError, json.JSONDecodeError) as error:
        print(f"asset verification failed: {error}")
        return 2
    for item in verified:
        print(f"OK {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
