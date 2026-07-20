#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path

from midibrave.config import Config


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--metrics", required=True)
    parser.add_argument("--target", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--maximum-step-ms", type=float, default=900.0)
    parser.add_argument("--maximum-peak-gib", type=float, default=15.0)
    args = parser.parse_args()
    config = Config.load(args.config)
    rows = [json.loads(line) for line in Path(args.metrics).read_text().splitlines()
            if line.strip()]
    rows = [row for row in rows if int(row.get("generator_updates", 0)) <= args.target]
    if not rows or int(rows[-1].get("generator_updates", 0)) < args.target:
        raise SystemExit("training metrics do not reach the requested target")
    finite = all(
        all(not isinstance(value, float) or math.isfinite(value) for value in row.values())
        for row in rows
    )
    applied = all(int(row.get("generator_step_applied", 0)) == 1 for row in rows)
    clap_rows = [row for row in rows if "cross_clap" in row]
    if not clap_rows:
        raise SystemExit("training log contains no executed CLAP reconstruction step")
    recompute_error = max(
        float(row.get("cross_clap_recompute_max_abs_error", math.inf))
        for row in clap_rows
    )
    clap_values = [float(row["cross_clap"]) for row in clap_rows]
    clipped_norm = max(
        float(row.get("cross_clap_waveform_grad_norm_clipped", math.inf))
        for row in clap_rows
    )
    stable_rows = [row for row in rows if int(row.get("generator_updates", 0)) > 20]
    step_ms = statistics.median(float(row["step_wall_ms"]) for row in stable_rows)
    peak_gib = max(float(row.get("peak_cuda_gib", 0.0)) for row in rows)
    eta_hours = step_ms * 100000 / 1000 / 3600
    report = {
        "schema": 1,
        "target": args.target,
        "finite": finite,
        "all_updates_applied": applied,
        "clap_logged_steps": len(clap_rows),
        "cross_clap_minimum": min(clap_values),
        "cross_clap_maximum": max(clap_values),
        "maximum_recompute_abs_error": recompute_error,
        "maximum_clipped_waveform_gradient_norm": clipped_norm,
        "median_step_wall_ms": step_ms,
        "projected_100k_compute_hours": eta_hours,
        "peak_cuda_gib": peak_gib,
    }
    report["passed"] = (
        finite and applied and all(0.0 <= value <= 2.0 for value in clap_values)
        and recompute_error <= 5e-3
        and clipped_norm <= config.loss.clap_gradient_norm * 1.001
        and step_ms <= args.maximum_step_ms and peak_gib <= args.maximum_peak_gib
    )
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["passed"]:
        raise SystemExit("CLAP training gate failed")


if __name__ == "__main__":
    main()
