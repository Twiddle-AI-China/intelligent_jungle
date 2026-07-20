#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--batch-per-gpu", type=int, required=True)
    parser.add_argument("--job-id", required=True)
    args = parser.parse_args()
    world_size = 8
    global_pairs = 64
    denominator = world_size * args.batch_per_gpu
    if global_pairs % denominator:
        raise ValueError("batch_per_gpu must preserve a global optimizer batch of 64")
    raw = yaml.safe_load(Path(args.base).read_text(encoding="utf-8"))
    accumulation = global_pairs // denominator
    run_name = f"batch{args.batch_per_gpu}_job{args.job_id}"
    raw["train"].update({
        "phase1_steps": 25,
        "phase2_steps": 25,
        "batch_per_gpu": args.batch_per_gpu,
        "grad_accum": accumulation,
        "checkpoint_every": 25,
        "log_every": 1,
        "output_dir": "/data/midibrave/benchmarks",
        "run_name": run_name,
    })
    output = Path(args.output)
    output.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    print(json.dumps({
        "config": str(output),
        "run_name": run_name,
        "batch_per_gpu": args.batch_per_gpu,
        "grad_accum": accumulation,
        "global_pairs": global_pairs,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
