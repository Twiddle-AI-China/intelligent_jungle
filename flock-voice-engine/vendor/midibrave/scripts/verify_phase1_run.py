#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import torch
import yaml


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--metrics", required=True)
    parser.add_argument("--evaluation")
    parser.add_argument("--decision", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    config_path = Path(args.config)
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    checkpoint_path = Path(args.checkpoint)
    checkpoint: dict[str, Any] = torch.load(
        checkpoint_path, map_location="cpu", weights_only=False)
    rows = [
        json.loads(line) for line in Path(args.metrics).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    final = max(rows, key=lambda row: int(row.get("generator_updates", -1)))
    expected = int(raw["train"]["phase1_steps"])
    run_root = Path(raw["train"]["output_dir"]) / raw["train"]["run_name"]
    checks = {
        "checkpoint_exists": checkpoint_path.is_file(),
        "checkpoint_format": int(checkpoint.get("format", 0)) == 3,
        "phase1_only": int(checkpoint.get("phase", 0)) == 1,
        "updates_complete": int(checkpoint.get("generator_updates", -1)) == expected,
        "metrics_complete": int(final.get("generator_updates", -1)) == expected,
        "world_size_eight": int(checkpoint.get("world_size", -1)) == 8,
        "config_hash_matches": checkpoint.get("config_hash") == sha256(config_path),
        "manifest_hash_matches": checkpoint.get("manifest_hash")
                                 == sha256(Path(raw["data"]["manifest"])),
        "metadata_hash_matches": checkpoint.get("manifest_metadata_hash")
                                 == sha256(Path(raw["data"]["manifest_metadata"])),
        "final_scalars_finite": all(
            math.isfinite(float(value))
            for value in final.values()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        ),
        "phase2_absent": not (run_root / "phase2").exists(),
    }
    evaluation = None
    if args.evaluation:
        evaluation = json.loads(Path(args.evaluation).read_text(encoding="utf-8"))
    result = {
        "schema": 1,
        "pass": all(checks.values()),
        "checks": checks,
        "checkpoint": str(checkpoint_path.resolve()),
        "checkpoint_sha256": sha256(checkpoint_path),
        "expected_updates": expected,
        "final_metrics": final,
        "evaluation": evaluation,
        "decision": json.loads(Path(args.decision).read_text(encoding="utf-8")),
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")
    print(json.dumps(result, sort_keys=True))
    if not result["pass"]:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
