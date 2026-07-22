#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any


EVALUATION_METRICS = (
    ("self_f0_absolute_cents", "median"),
    ("self_f0_absolute_cents", "p90"),
    ("cross_f0_absolute_cents", "median"),
    ("cross_f0_absolute_cents", "p90"),
    ("self_f0_periodicity", "median"),
    ("cross_f0_periodicity", "median"),
    ("self_f0_low_periodicity_rate", "mean"),
    ("cross_f0_low_periodicity_rate", "mean"),
    ("self_f0_octave_error", "mean"),
    ("cross_f0_octave_error", "mean"),
    ("midi_swap_following", "mean"),
    ("self_mr_stft", "median"),
    ("cross_mr_stft", "median"),
    ("self_lsd_db", "median"),
    ("cross_lsd_db", "median"),
    ("self_rms_error_db", "median"),
    ("cross_rms_error_db", "median"),
    ("targeted_velocity_direction_accuracy", "mean"),
    ("targeted_velocity_margin_accuracy", "mean"),
    ("targeted_velocity_delta_error_db", "median"),
)
TRAIN_TERMS = (
    "cross_stft", "self_stft", "cross_pitch", "self_pitch",
    "cross_pitch_cents", "cross_pitch_activation",
    "cross_pitch_hard_negative", "cross_pitch_autocorrelation",
    "generator_grad_norm", "total",
)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]


def window_median(rows: list[dict[str, Any]], name: str,
                  begin: float, end: float) -> float | None:
    start = int(len(rows) * begin)
    stop = max(start + 1, int(math.ceil(len(rows) * end)))
    values = [float(row[name]) for row in rows[start:stop]
              if name in row and math.isfinite(float(row[name]))]
    return statistics.median(values) if values else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/data/midibrave/loss_tuning")
    parser.add_argument("--prefix", default="loss_tune_r1")
    parser.add_argument("--candidates", default="b0,c5,c6,c7")
    parser.add_argument("--stage", choices=("1000", "5000"), required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    root = Path(args.root)
    suffix = "1k" if args.stage == "1000" else "5k"
    candidates = [item.strip().lower() for item in args.candidates.split(",")
                  if item.strip()]
    summary: dict[str, Any] = {"schema": 1, "stage": int(args.stage),
                               "root": str(root.resolve()), "candidates": {}}
    for candidate in candidates:
        run = root / f"{args.prefix}_{candidate}" / "phase1"
        evaluation = root / "evaluations" / f"{args.prefix}_{candidate}_{suffix}"
        metrics_path = evaluation / "metrics.json"
        gate_path = evaluation / f"gate-{args.stage}.json"
        training_path = run / "metrics.jsonl"
        item: dict[str, Any] = {
            "training_log": str(training_path),
            "evaluation": str(metrics_path),
            "gate": str(gate_path),
        }
        if training_path.is_file():
            rows = read_jsonl(training_path)
            applied = [row for row in rows
                       if int(row.get("generator_step_applied", 0)) == 1]
            final = max(rows, key=lambda row: int(row.get("loop_step", -1)))
            loop_step = int(final["loop_step"])
            updates = int(final["generator_updates"])
            item["training"] = {
                "loop_step": loop_step,
                "generator_updates": updates,
                "amp_skips": loop_step - updates,
                "amp_skip_rate": (loop_step - updates) / max(1, loop_step),
                "effective_updates_per_second": final.get(
                    "effective_updates_per_second"),
                "peak_cuda_gib": final.get("peak_cuda_gib"),
                "terms": {
                    name: {
                        "first_10pct_median": window_median(applied, name, 0.0, 0.1),
                        "last_25pct_median": window_median(applied, name, 0.75, 1.0),
                    }
                    for name in TRAIN_TERMS
                },
            }
        if metrics_path.is_file():
            evaluation_report = read_json(metrics_path)
            metrics = evaluation_report["metrics"]
            item["evaluated_pairs"] = evaluation_report.get("evaluated_pairs")
            item["targeted_velocity_pairs"] = evaluation_report.get(
                "targeted_velocity_pairs")
            item["metrics"] = {
                f"{name}.{statistic}": metrics.get(name, {}).get(statistic)
                for name, statistic in EVALUATION_METRICS
            }
        if gate_path.is_file():
            gate = read_json(gate_path)
            item["gate_pass"] = bool(gate.get("pass"))
            item["gate_failure_count"] = len(gate.get("failures", []))
            item["gate_failures"] = gate.get("failures", [])
        summary["candidates"][candidate] = item

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    main()
