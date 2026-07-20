#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any


LOWER_METRICS = (
    "self_mr_stft", "cross_mr_stft", "self_lsd_db", "cross_lsd_db",
    "self_envelope_ripple_error", "cross_envelope_ripple_error",
    "self_generated_clicks_per_second", "cross_generated_clicks_per_second",
)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_metrics(path: Path, target: int) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]
    return [row for row in rows if int(row.get("generator_updates", 0)) <= target]


def numeric_summary(rows: list[dict[str, Any]], initial_scale: float = 2.0) -> dict[str, Any]:
    useful = [row for row in rows if int(row.get("generator_updates", 0)) > 50]
    finite = all(all(not isinstance(value, float) or math.isfinite(value)
                     for value in row.values()) for row in rows)
    applied = all(int(row.get("generator_step_applied", 1)) == 1 for row in rows)
    scale_min = min(float(row.get("scale_before", initial_scale)) for row in rows)
    activation = max(float(row.get("residual_activation_absmax", 0.0)) for row in rows)
    wall = [float(row["step_wall_ms"]) for row in useful if float(row.get("step_wall_ms", 0)) > 0]
    return {
        "finite": finite, "zero_optimizer_skip": applied,
        "minimum_amp_scale": scale_min,
        "activation_absmax": activation,
        "updates_per_second": (1000.0 / statistics.median(wall) if wall else 0.0),
        "passed": finite and applied and scale_min >= initial_scale and activation < 30000.0,
    }


def metric(report: dict[str, Any], name: str, statistic: str) -> float:
    return float(report["metrics"][name][statistic])


def absolute_quality(report: dict[str, Any]) -> tuple[bool, list[str]]:
    checks = {
        "f0_median": metric(report, "f0_absolute_cents", "median") <= 50.0,
        "f0_p90": metric(report, "f0_absolute_cents", "p90") <= 100.0,
        "octave_error": metric(report, "f0_octave_error", "mean") <= 0.01,
        "midi_following": metric(report, "midi_swap_following", "mean") >= 0.95,
        "periodicity": metric(report, "f0_periodicity", "median") >= 0.5,
    }
    return all(checks.values()), [name for name, passed in checks.items() if not passed]


def precision_regressions(candidate: dict[str, Any], safe: dict[str, Any]) -> list[str]:
    failures = []
    for name in LOWER_METRICS:
        statistic = "p90" if "ripple" in name or "click" in name else "mean"
        candidate_value = metric(candidate, name, statistic)
        safe_value = metric(safe, name, statistic)
        # Near-zero click/ripple metrics need an absolute numerical floor;
        # otherwise harmless estimator noise makes a 3% relative comparison
        # mathematically impossible to pass.
        allowance = max(1e-4, abs(safe_value) * 1.03)
        if candidate_value > allowance:
            failures.append(f"{name}:{candidate_value:.6g}>{allowance:.6g}")
    return failures


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=int, required=True)
    parser.add_argument("--root", default="/data/midibrave-v2")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(args.root)
    policies = ("safe_fallback", "fp16_candidate")
    summaries = {}
    evaluations = {}
    for policy in policies:
        metrics_path = root / "runs" / f"lead_{policy}" / "phase1" / "metrics.jsonl"
        eval_path = root / "reports" / f"lead_{policy}_{args.target}" / "metrics.json"
        summaries[policy] = numeric_summary(read_metrics(metrics_path, args.target))
        evaluations[policy] = read_json(eval_path)
        quality_passed, failures = absolute_quality(evaluations[policy])
        summaries[policy]["quality_passed"] = quality_passed
        summaries[policy]["quality_failures"] = failures
    probe = read_json(root / "reports" / "precision_probe.json")
    pqmf_passed = bool(probe.get(
        "candidate_precision_passed",
        float(probe["pqmf_snr_db"]) >= 60.0
        and float(probe["pqmf_band_energy_error_db"]) < 0.1,
    ))
    safe_passed = summaries["safe_fallback"]["passed"]
    candidate_regressions = precision_regressions(
        evaluations["fp16_candidate"], evaluations["safe_fallback"])
    safe_rate = summaries["safe_fallback"]["updates_per_second"]
    candidate_rate = summaries["fp16_candidate"]["updates_per_second"]
    speedup = candidate_rate / safe_rate - 1.0 if safe_rate > 0 else -1.0
    candidate_passed = (
        summaries["fp16_candidate"]["passed"] and pqmf_passed
        and not candidate_regressions and speedup >= 0.03
        and (args.target < 5000 or summaries["fp16_candidate"]["quality_passed"])
    )
    selected = "fp16_candidate" if candidate_passed else "safe_fallback"
    status = "pass"
    if not safe_passed or (args.target >= 5000 and not summaries[selected]["quality_passed"]):
        status = "no_qualified_policy"
    report = {
        "schema": 1, "target": args.target, "status": status,
        "selected_policy": selected, "summaries": summaries,
        "pqmf_passed": pqmf_passed, "speedup_fraction": speedup,
        "candidate_regressions": candidate_regressions,
        "checkpoint_paths": {
            policy: str(root / "runs" / f"lead_{policy}" / "phase1"
                        / f"step-{args.target:09d}.pt") for policy in policies
        },
    }
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))
    if status != "pass":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
