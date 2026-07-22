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
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--updates", type=int, default=25)
    args = parser.parse_args()
    raw = yaml.safe_load(Path(args.base).read_text(encoding="utf-8"))
    run_name = f"optimized_gate_job{args.job_id}"
    raw["train"].update({
        "phase1_steps": args.updates,
        "phase2_steps": args.updates,
        "warmup_steps": 1,
        "pitch_adversary_start": 1,
        "pitch_adversary_ramp": 1,
        "self_full_fraction": 0.0,
        "checkpoint_every": args.updates,
        "log_every": 1,
        "output_dir": "/data/midibrave/benchmarks",
        "run_name": run_name,
    })
    output = Path(args.output)
    output.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    print(json.dumps({"config": str(output), "run_name": run_name,
                      "updates": args.updates}, sort_keys=True))


if __name__ == "__main__":
    main()
