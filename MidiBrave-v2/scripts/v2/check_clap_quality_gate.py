#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def metric(report, name, statistic):
    return float(report["metrics"][name][statistic])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evaluation", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = json.loads(Path(args.evaluation).read_text(encoding="utf-8"))
    checks = {
        "f0_median_cents": metric(report, "f0_absolute_cents", "median") <= 50.0,
        "f0_p90_cents": metric(report, "f0_absolute_cents", "p90") <= 100.0,
        "octave_error": metric(report, "f0_octave_error", "mean") <= 0.01,
        "midi_following": metric(report, "midi_swap_following", "mean") >= 0.95,
        "periodicity": metric(report, "f0_periodicity", "median") >= 0.5,
        "self_stft": metric(report, "self_mr_stft", "mean") <= 4.5,
        "cross_stft": metric(report, "cross_mr_stft", "mean") <= 4.5,
    }
    result = {
        "schema": 1,
        "checks": checks,
        "failed": [name for name, passed in checks.items() if not passed],
        "passed": all(checks.values()),
    }
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2, sort_keys=True))
    if not result["passed"]:
        raise SystemExit("1k CLAP reconstruction quality gate failed")


if __name__ == "__main__":
    main()
