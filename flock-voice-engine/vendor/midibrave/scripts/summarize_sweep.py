#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * fraction))]


def summarize(path: str, warmup: int, global_pairs: int,
              updates: int = 25) -> dict[str, float | int]:
    rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines()
            if line.strip()]
    rows = [row for row in rows
            if row.get("generator_step_applied") == 1
            and int(row["generator_updates"]) > warmup]
    if len(rows) != updates - warmup:
        raise ValueError(
            f"expected {updates - warmup} measured updates in {path}, got {len(rows)}")
    wall = [float(row["step_wall_ms"]) for row in rows]
    data_wait = [float(row["data_wait_ms"]) for row in rows]
    median_ms = statistics.median(wall)
    return {
        "measured_updates": len(rows),
        "median_step_ms": median_ms,
        "p90_step_ms": percentile(wall, 0.9),
        "median_data_wait_ms": statistics.median(data_wait),
        "p90_data_wait_ms": percentile(data_wait, 0.9),
        "peak_cuda_gib": max(float(row["peak_cuda_gib"]) for row in rows),
        "effective_pairs_per_second": global_pairs / (median_ms / 1000.0),
        "minimum_scale": min(float(row["scale_after"]) for row in rows),
        "maximum_scale": max(float(row["scale_after"]) for row in rows),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase1", required=True)
    parser.add_argument("--phase2", required=True)
    parser.add_argument("--batch-per-gpu", type=int, required=True)
    parser.add_argument("--grad-accum", type=int, required=True)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--updates", type=int, default=25)
    args = parser.parse_args()
    global_pairs = 8 * args.batch_per_gpu * args.grad_accum
    print(json.dumps({
        "batch_per_gpu": args.batch_per_gpu,
        "grad_accum": args.grad_accum,
        "global_pairs": global_pairs,
        "phase1": summarize(args.phase1, args.warmup, global_pairs, args.updates),
        "phase2": summarize(args.phase2, args.warmup, global_pairs, args.updates),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
