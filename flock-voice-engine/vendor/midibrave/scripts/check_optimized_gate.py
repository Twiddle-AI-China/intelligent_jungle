#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--summary", required=True)
    args = parser.parse_args()
    result = json.loads(Path(args.summary).read_text(encoding="utf-8"))
    failures = []
    for phase in ("phase1", "phase2"):
        values = result[phase]
        if values["minimum_scale"] < 1.0:
            failures.append(f"{phase}: invalid GradScaler minimum")
        if values["peak_cuda_gib"] >= 15.5:
            failures.append(f"{phase}: peak CUDA allocation too close to 16 GiB")
        if values["median_step_ms"] <= 0 or values["p90_step_ms"] <= 0:
            failures.append(f"{phase}: invalid runtime statistics")
    if failures:
        raise SystemExit("; ".join(failures))
    print(json.dumps({"status": "pass", **result}, sort_keys=True))


if __name__ == "__main__":
    main()
