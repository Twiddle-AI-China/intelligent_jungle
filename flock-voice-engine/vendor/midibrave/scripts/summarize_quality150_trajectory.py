#!/usr/bin/env python3
"""Compare q150 Phase-1 checkpoints on one deterministic validation stream."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


METRICS = (
    ("self_f0_absolute_cents", "median"),
    ("self_f0_absolute_cents", "p90"),
    ("cross_f0_absolute_cents", "median"),
    ("cross_f0_absolute_cents", "p90"),
    ("self_f0_octave_error", "mean"),
    ("cross_f0_octave_error", "mean"),
    ("self_f0_periodicity", "median"),
    ("cross_f0_periodicity", "median"),
    ("midi_swap_following", "mean"),
    ("self_mr_stft", "median"),
    ("cross_mr_stft", "median"),
    ("self_lsd_db", "median"),
    ("cross_lsd_db", "median"),
    ("self_rms_error_db", "median"),
    ("cross_rms_error_db", "median"),
    ("self_upper_band_energy_error_db", "p90"),
    ("cross_upper_band_energy_error_db", "p90"),
    ("self_crest_factor_error", "p90"),
    ("cross_crest_factor_error", "p90"),
    ("self_envelope_ripple_error", "p90"),
    ("cross_envelope_ripple_error", "p90"),
    ("self_generated_clicks_per_second", "p90"),
    ("cross_generated_clicks_per_second", "p90"),
    ("timbre_preset_retrieval_at_1", "mean"),
)

TARGET_CONTROLS = (
    ("target_f0_absolute_cents", "median"),
    ("target_f0_absolute_cents", "p90"),
    ("target_f0_periodicity", "median"),
    ("target_f0_low_periodicity_rate", "mean"),
)

TARGET_TOLERANCES = {
    ("target_f0_absolute_cents", "median"): 0.1,
    ("target_f0_absolute_cents", "p90"): 0.1,
    ("target_f0_periodicity", "median"): 0.001,
    ("target_f0_low_periodicity_rate", "mean"): 0.001,
}


def metric(report: dict[str, Any], name: str, statistic: str) -> float:
    try:
        result = float(report["metrics"][name][statistic])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"missing metric {name}.{statistic}") from error
    if not math.isfinite(result):
        raise ValueError(f"non-finite metric {name}.{statistic}")
    return result


def stream_fingerprint(metrics_path: Path) -> str:
    diagnostics = metrics_path.with_name("pitch_diagnostics.jsonl")
    if not diagnostics.is_file():
        raise ValueError(f"missing pitch diagnostics beside {metrics_path}")
    digest = hashlib.sha256()
    with diagnostics.open(encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            identity = (
                row.get("branch"), row.get("sample_id"),
                int(row.get("note", -1)), int(row.get("velocity", -1)),
            )
            digest.update(json.dumps(identity, separators=(",", ":")).encode("utf-8"))
            digest.update(b"\n")
    return digest.hexdigest()


def load_reports(paths: list[Path]) -> list[dict[str, Any]]:
    reports = []
    for path in paths:
        report = json.loads(path.read_text(encoding="utf-8"))
        if report.get("schema") != 2:
            raise ValueError(f"unsupported metrics schema in {path}")
        if int(report.get("checkpoint_phase", -1)) != 1:
            raise ValueError(f"expected Phase 1 checkpoint in {path}")
        report["_path"] = str(path.resolve())
        report["_stream_fingerprint"] = stream_fingerprint(path)
        reports.append(report)
    reports.sort(key=lambda item: int(item["checkpoint_generator_updates"]))
    steps = [int(item["checkpoint_generator_updates"]) for item in reports]
    if len(set(steps)) != len(steps):
        raise ValueError(f"duplicate checkpoint steps: {steps}")
    pair_counts = {int(item["evaluated_pairs"]) for item in reports}
    if len(pair_counts) != 1:
        raise ValueError(f"evaluated pair counts differ: {sorted(pair_counts)}")
    configs = {item["config"] for item in reports}
    if len(configs) != 1:
        raise ValueError(f"evaluation configs differ: {sorted(configs)}")
    fingerprints = {item["_stream_fingerprint"] for item in reports}
    if len(fingerprints) != 1:
        raise ValueError("validation sample identity/order differs across checkpoints")
    first = reports[0]
    for report in reports[1:]:
        for name, statistic in TARGET_CONTROLS:
            expected = metric(first, name, statistic)
            actual = metric(report, name, statistic)
            tolerance = TARGET_TOLERANCES[(name, statistic)]
            if not math.isclose(actual, expected, rel_tol=0.0, abs_tol=tolerance):
                raise ValueError(
                    f"validation stream mismatch for {name}.{statistic}: "
                    f"{expected} != {actual} (tolerance={tolerance})"
                )
    return reports


def build_summary(reports: list[dict[str, Any]], reference_step: int,
                  final_step: int) -> dict[str, Any]:
    by_step = {int(item["checkpoint_generator_updates"]): item for item in reports}
    if reference_step not in by_step or final_step not in by_step:
        raise ValueError(
            f"reference/final step missing; available={sorted(by_step)}, "
            f"requested={reference_step}/{final_step}"
        )
    reference = by_step[reference_step]
    final = by_step[final_step]
    steps = sorted(by_step)
    rows = []
    for name, statistic in METRICS:
        values = {str(step): metric(by_step[step], name, statistic) for step in steps}
        before = values[str(reference_step)]
        after = values[str(final_step)]
        rows.append({
            "metric": name,
            "statistic": statistic,
            "values": values,
            "late_absolute_change": after - before,
            "late_relative_change": ((after / before) - 1.0 if before != 0.0 else None),
        })

    checks: list[dict[str, Any]] = []

    def maximum(name: str, statistic: str, threshold: float) -> None:
        actual = metric(final, name, statistic)
        checks.append({"metric": name, "statistic": statistic, "operator": "<=",
                       "threshold": threshold, "actual": actual,
                       "pass": actual <= threshold})

    def minimum(name: str, statistic: str, threshold: float) -> None:
        actual = metric(final, name, statistic)
        checks.append({"metric": name, "statistic": statistic, "operator": ">=",
                       "threshold": threshold, "actual": actual,
                       "pass": actual >= threshold})

    for prefix in ("self", "cross"):
        maximum(f"{prefix}_f0_absolute_cents", "median",
                metric(reference, f"{prefix}_f0_absolute_cents", "median") * 1.02 + 1e-6)
        maximum(f"{prefix}_f0_absolute_cents", "p90",
                metric(reference, f"{prefix}_f0_absolute_cents", "p90") * 1.02 + 1e-6)
        maximum(f"{prefix}_f0_octave_error", "mean", 0.01)
        minimum(f"{prefix}_f0_periodicity", "median",
                metric(reference, f"{prefix}_f0_periodicity", "median") - 0.02)
        maximum(f"{prefix}_mr_stft", "median",
                metric(reference, f"{prefix}_mr_stft", "median") * 1.05 + 1e-6)
        maximum(f"{prefix}_lsd_db", "median",
                metric(reference, f"{prefix}_lsd_db", "median") + 1.0)
        maximum(f"{prefix}_rms_error_db", "median",
                metric(reference, f"{prefix}_rms_error_db", "median") + 0.5)
        for suffix in ("upper_band_energy_error_db", "crest_factor_error",
                       "envelope_ripple_error", "generated_clicks_per_second"):
            maximum(f"{prefix}_{suffix}", "p90",
                    metric(reference, f"{prefix}_{suffix}", "p90") * 1.10 + 1e-8)
    minimum("midi_swap_following", "mean", 0.95)
    failures = [item for item in checks if not item["pass"]]
    return {
        "schema": 1,
        "evaluated_pairs": int(reports[0]["evaluated_pairs"]),
        "config": reports[0]["config"],
        "steps": steps,
        "reference_step": reference_step,
        "final_step": final_step,
        "source_metrics": {str(int(item["checkpoint_generator_updates"])): item["_path"]
                           for item in reports},
        "validation_stream_fingerprint": reports[0]["_stream_fingerprint"],
        "rows": rows,
        "late_training_gate": {
            "pass": not failures,
            "checks": checks,
            "failures": failures,
        },
    }


def markdown(summary: dict[str, Any]) -> str:
    steps = summary["steps"]
    lines = [
        "# q150 Phase 1 同验证集 checkpoint 轨迹",
        "",
        f"- validation pairs: {summary['evaluated_pairs']}",
        f"- reference step: {summary['reference_step']}",
        f"- final step: {summary['final_step']}",
        f"- late-training gate: {'PASS' if summary['late_training_gate']['pass'] else 'FAIL'}",
        "",
        "| Metric | Statistic | " + " | ".join(str(step) for step in steps) + " |",
        "|---|---:" + "|---:" * len(steps) + "|",
    ]
    for row in summary["rows"]:
        values = [row["values"][str(step)] for step in steps]
        lines.append(
            f"| {row['metric']} | {row['statistic']} | "
            + " | ".join(f"{value:.6g}" for value in values) + " |"
        )
    lines.extend(["", "## Late-training failures", ""])
    failures = summary["late_training_gate"]["failures"]
    if not failures:
        lines.append("None.")
    else:
        lines.extend(["| Metric | Statistic | Actual | Limit |", "|---|---:|---:|---:|"])
        for item in failures:
            lines.append(
                f"| {item['metric']} | {item['statistic']} | {item['actual']:.6g} | "
                f"{item['operator']} {item['threshold']:.6g} |"
            )
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--metrics", type=Path, nargs="+", required=True)
    parser.add_argument("--reference-step", type=int, required=True)
    parser.add_argument("--final-step", type=int, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    reports = load_reports(args.metrics)
    summary = build_summary(reports, args.reference_step, args.final_step)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (args.output_dir / "summary.md").write_text(markdown(summary), encoding="utf-8")
    print(json.dumps(summary["late_training_gate"], sort_keys=True))


if __name__ == "__main__":
    main()
