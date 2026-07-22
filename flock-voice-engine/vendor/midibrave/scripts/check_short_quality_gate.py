#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


class GateFailure(RuntimeError):
    pass


def load_report(path: str) -> dict[str, Any]:
    report = json.loads(Path(path).read_text(encoding="utf-8"))
    if int(report.get("schema", 0)) < 2:
        raise GateFailure(f"short gate requires evaluation schema >=2: {path}")
    if not isinstance(report.get("metrics"), dict):
        raise GateFailure(f"missing metrics: {path}")
    return report


def load_training_rows(path: str) -> list[dict[str, Any]]:
    rows = []
    for line_number, line in enumerate(
            Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise GateFailure(
                f"invalid training JSON at {path}:{line_number}") from error
        if not isinstance(row, dict):
            raise GateFailure(f"training row is not an object at {path}:{line_number}")
        rows.append(row)
    if not rows:
        raise GateFailure(f"empty training log: {path}")
    return rows


def value(metrics: dict[str, Any], name: str, statistic: str) -> float:
    try:
        result = float(metrics[name][statistic])
    except (KeyError, TypeError, ValueError) as error:
        raise GateFailure(f"missing metric {name}.{statistic}") from error
    if not math.isfinite(result):
        raise GateFailure(f"non-finite metric {name}.{statistic}")
    return result


TARGET_STREAM_TOLERANCES = {
    ("target_f0_absolute_cents", "median"): 0.1,
    ("target_f0_absolute_cents", "p90"): 0.1,
    ("target_f0_periodicity", "median"): 0.001,
    ("target_f0_low_periodicity_rate", "mean"): 0.001,
}


def stream_fingerprint(metrics_path: str) -> str:
    """Hash the ordered validation identities used by an evaluation report."""
    diagnostics = Path(metrics_path).with_name("pitch_diagnostics.jsonl")
    if not diagnostics.is_file():
        raise GateFailure(f"missing pitch diagnostics beside {metrics_path}")
    digest = hashlib.sha256()
    for line_number, line in enumerate(
            diagnostics.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            identity = (
                row["branch"], row["sample_id"],
                int(row["note"]), int(row["velocity"]),
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise GateFailure(
                f"invalid pitch diagnostic identity at {diagnostics}:{line_number}"
            ) from error
        digest.update(json.dumps(identity, separators=(",", ":")).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def verify_same_validation_stream(
        metrics_path: str, report: dict[str, Any],
        prior_path: str, prior_report: dict[str, Any]) -> dict[str, Any]:
    evaluated_pairs = int(report.get("evaluated_pairs", -1))
    prior_pairs = int(prior_report.get("evaluated_pairs", -1))
    if evaluated_pairs <= 0 or prior_pairs <= 0 or evaluated_pairs != prior_pairs:
        raise GateFailure(
            f"prior comparison requires identical evaluated_pairs: "
            f"{evaluated_pairs} != {prior_pairs}"
        )
    fingerprint = stream_fingerprint(metrics_path)
    prior_fingerprint = stream_fingerprint(prior_path)
    if fingerprint != prior_fingerprint:
        raise GateFailure(
            "prior comparison uses a different validation sample identity/order"
        )
    metrics = report["metrics"]
    prior = prior_report["metrics"]
    for (name, statistic), tolerance in TARGET_STREAM_TOLERANCES.items():
        actual = value(metrics, name, statistic)
        expected = value(prior, name, statistic)
        if not math.isclose(actual, expected, rel_tol=0.0, abs_tol=tolerance):
            raise GateFailure(
                f"prior comparison target stream differs for {name}.{statistic}: "
                f"{actual} != {expected} (tolerance={tolerance})"
            )
    return {
        "evaluated_pairs": evaluated_pairs,
        "fingerprint": fingerprint,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=("1000", "5000"), required=True)
    parser.add_argument("--metrics", required=True)
    parser.add_argument("--baseline")
    parser.add_argument("--prior")
    parser.add_argument("--training-log")
    parser.add_argument("--expected-updates", type=int)
    parser.add_argument("--output", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--soft-fail", action="store_true")
    parser.add_argument(
        "--require-prior-improvement", action="store_true",
        help=("Require at least 1%% mean relative improvement across Phase 2 "
              "texture/transient metrics, in addition to per-metric guards."),
    )
    parser.add_argument(
        "--ignore-velocity", action="store_true",
        help="Report velocity metrics but exclude them from hard pass/fail criteria.",
    )
    args = parser.parse_args()

    try:
        report = load_report(args.metrics)
        baseline_report = load_report(args.baseline) if args.baseline else None
        prior_report = load_report(args.prior) if args.prior else None
        training_rows = load_training_rows(args.training_log) if args.training_log else None
        metrics = report["metrics"]
        baseline = baseline_report["metrics"] if baseline_report else None
        prior = prior_report["metrics"] if prior_report else None
        stage = int(args.stage)
        expected_updates = args.expected_updates or stage
        if expected_updates <= 0:
            raise GateFailure("expected updates must be positive")
        if args.require_prior_improvement and prior_report is None:
            raise GateFailure("--require-prior-improvement requires --prior")
        baseline_validation_stream = None
        if baseline_report is not None:
            baseline_validation_stream = verify_same_validation_stream(
                args.metrics, report, args.baseline, baseline_report)
        validation_stream = None
        if prior_report is not None:
            validation_stream = verify_same_validation_stream(
                args.metrics, report, args.prior, prior_report)
        failures: list[dict[str, Any]] = []
        checks: list[dict[str, Any]] = []
        prior_relative_changes: list[dict[str, Any]] = []

        def maximum(name: str, statistic: str, threshold: float) -> None:
            actual = value(metrics, name, statistic)
            passed = actual <= threshold
            checks.append({"metric": name, "statistic": statistic,
                           "operator": "<=", "threshold": threshold,
                           "actual": actual, "pass": passed})
            if not passed:
                failures.append(checks[-1])

        def minimum(name: str, statistic: str, threshold: float) -> None:
            actual = value(metrics, name, statistic)
            passed = actual >= threshold
            checks.append({"metric": name, "statistic": statistic,
                           "operator": ">=", "threshold": threshold,
                           "actual": actual, "pass": passed})
            if not passed:
                failures.append(checks[-1])

        def training_check(name: str, actual: float | int | bool,
                           operator: str, threshold: float | int | bool,
                           passed: bool) -> None:
            check = {"metric": name, "operator": operator,
                     "threshold": threshold, "actual": actual, "pass": passed}
            checks.append(check)
            if not passed:
                failures.append(check)

        f0_median = 100.0 if stage == 1000 else 50.0
        f0_p90 = 200.0 if stage == 1000 else 100.0
        octave = 0.05 if stage == 1000 else 0.01
        periodicity = 0.35 if stage == 1000 else 0.50
        low_periodicity = 0.30 if stage == 1000 else 0.10
        following = 0.85 if stage == 1000 else 0.95
        for prefix in ("self", "cross"):
            maximum(f"{prefix}_f0_absolute_cents", "median", f0_median)
            maximum(f"{prefix}_f0_absolute_cents", "p90", f0_p90)
            maximum(f"{prefix}_f0_octave_error", "mean", octave)
            minimum(f"{prefix}_f0_periodicity", "median", periodicity)
            maximum(f"{prefix}_f0_low_periodicity_rate", "mean", low_periodicity)
        maximum("f0_absolute_cents", "median", f0_median)
        maximum("f0_absolute_cents", "p90", f0_p90)
        maximum("f0_octave_error", "mean", octave)
        minimum("f0_periodicity", "median", periodicity)
        maximum("f0_low_periodicity_rate", "mean", low_periodicity)
        minimum("midi_swap_following", "mean", following)

        maximum("target_f0_absolute_cents", "median", 25.0)
        maximum("target_f0_absolute_cents", "p90", 50.0)
        minimum("target_f0_periodicity", "median", 0.80)
        maximum("target_f0_low_periodicity_rate", "mean", 0.05)

        if training_rows is not None:
            final = max(training_rows, key=lambda row: int(row.get("loop_step", -1)))
            final_loop = int(final.get("loop_step", -1))
            final_updates = int(final.get("generator_updates", -1))
            inferred_skips = final_loop - final_updates
            logged_skips = sum(
                int(row.get("generator_step_applied", 1)) == 0
                for row in training_rows)
            skip_rate = inferred_skips / max(1, final_loop)
            applied = [row for row in training_rows
                       if int(row.get("generator_step_applied", 0)) == 1]
            applied_scalars_finite = all(
                math.isfinite(float(item))
                for row in applied
                for item in row.values()
                if isinstance(item, (int, float)) and not isinstance(item, bool)
            )
            applied_deltas_positive = bool(applied) and all(
                float(row.get("generator_parameter_delta", 0.0)) > 0.0
                for row in applied)
            training_check("training_generator_updates", final_updates, ">=",
                           expected_updates, final_updates >= expected_updates)
            training_check("training_amp_skip_rate", skip_rate, "<=", 0.01,
                           0 <= skip_rate <= 0.01)
            training_check("training_logged_skip_count", logged_skips, "==",
                           inferred_skips, logged_skips == inferred_skips)
            training_check("training_applied_scalars_finite",
                           applied_scalars_finite, "==", True,
                           applied_scalars_finite)
            training_check("training_applied_parameter_delta_positive",
                           applied_deltas_positive, "==", True,
                           applied_deltas_positive)

        if baseline is not None:
            stft_factor = 1.15 if stage == 1000 else 1.05
            lsd_offset = 2.0 if stage == 1000 else 1.0
            rms_offset = 1.0 if stage == 1000 else 0.5
            for prefix in ("self", "cross"):
                maximum(f"{prefix}_mr_stft", "median",
                        value(baseline, f"{prefix}_mr_stft", "median") * stft_factor)
                maximum(f"{prefix}_lsd_db", "median",
                        value(baseline, f"{prefix}_lsd_db", "median") + lsd_offset)
                maximum(f"{prefix}_rms_error_db", "median",
                        value(baseline, f"{prefix}_rms_error_db", "median") + rms_offset)
                if stage == 5000:
                    for artifact in ("upper_band_energy_error_db", "crest_factor_error",
                                     "envelope_ripple_error",
                                     "generated_clicks_per_second"):
                        baseline_value = value(baseline, f"{prefix}_{artifact}", "p90")
                        maximum(f"{prefix}_{artifact}", "p90",
                                baseline_value * 1.10 + 1e-8)

        if stage == 5000 and not args.ignore_velocity:
            if int(report.get("targeted_velocity_pairs", 0)) < 64:
                failures.append({"metric": "targeted_velocity_pairs", "operator": ">=",
                                 "threshold": 64,
                                 "actual": int(report.get("targeted_velocity_pairs", 0)),
                                 "pass": False})
            minimum("targeted_velocity_direction_accuracy", "mean", 0.80)
            minimum("targeted_velocity_margin_accuracy", "mean", 0.60)
            maximum("targeted_velocity_delta_error_db", "median", 2.0)

        if prior is not None and stage == 5000:
            texture_metrics = (
                ("mr_stft", "median", 0.1),
                ("lsd_db", "median", 1.0),
                ("upper_band_energy_error_db", "p90", 0.1),
                ("crest_factor_error", "p90", 0.1),
                ("envelope_ripple_error", "p90", 0.001),
                ("generated_clicks_per_second", "p90", 1.0),
            )
            artifact_tolerances = {
                "upper_band_energy_error_db": 0.10,
                "crest_factor_error": 0.05,
                "envelope_ripple_error": 0.0001,
                "generated_clicks_per_second": 1.0,
            }
            for prefix in ("self", "cross"):
                maximum(f"{prefix}_f0_absolute_cents", "median",
                        value(prior, f"{prefix}_f0_absolute_cents", "median") * 1.02 + 0.1)
                maximum(f"{prefix}_f0_absolute_cents", "p90",
                        value(prior, f"{prefix}_f0_absolute_cents", "p90") * 1.02 + 0.1)
                minimum(f"{prefix}_f0_periodicity", "median",
                        value(prior, f"{prefix}_f0_periodicity", "median") - 0.021)
                maximum(f"{prefix}_f0_low_periodicity_rate", "mean",
                        value(prior, f"{prefix}_f0_low_periodicity_rate", "mean")
                        + 0.021)
                maximum(f"{prefix}_mr_stft", "median",
                        value(prior, f"{prefix}_mr_stft", "median") * 1.02 + 0.001)
                maximum(f"{prefix}_lsd_db", "median",
                        value(prior, f"{prefix}_lsd_db", "median") + 1.05)
                maximum(f"{prefix}_rms_error_db", "median",
                        value(prior, f"{prefix}_rms_error_db", "median") + 0.55)
                for artifact, tolerance in artifact_tolerances.items():
                    maximum(
                        f"{prefix}_{artifact}", "p90",
                        value(prior, f"{prefix}_{artifact}", "p90") * 1.10
                        + tolerance,
                    )
                for suffix, statistic, floor in texture_metrics:
                    name = f"{prefix}_{suffix}"
                    before = value(prior, name, statistic)
                    after = value(metrics, name, statistic)
                    prior_relative_changes.append({
                        "metric": name,
                        "statistic": statistic,
                        "prior": before,
                        "actual": after,
                        "relative_change": ((after - before)
                                            / max(abs(before), floor)),
                    })
            minimum(
                "midi_swap_following", "mean",
                max(0.95, value(prior, "midi_swap_following", "mean") - 0.01),
            )
            minimum(
                "timbre_preset_retrieval_at_1", "mean",
                value(prior, "timbre_preset_retrieval_at_1", "mean") - 0.05,
            )
            if args.require_prior_improvement:
                mean_change = sum(
                    item["relative_change"] for item in prior_relative_changes
                ) / len(prior_relative_changes)
                training_check(
                    "phase2_texture_transient_mean_relative_change",
                    mean_change, "<=", -0.01, mean_change <= -0.01,
                )

        result = {
            "schema": 1,
            "candidate": args.candidate,
            "stage": stage,
            "evaluation": str(Path(args.metrics).resolve()),
            "baseline": str(Path(args.baseline).resolve()) if args.baseline else None,
            "baseline_validation_stream": baseline_validation_stream,
            "prior": str(Path(args.prior).resolve()) if args.prior else None,
            "prior_validation_stream": validation_stream,
            "prior_relative_changes": prior_relative_changes,
            "training_log": (str(Path(args.training_log).resolve())
                             if args.training_log else None),
            "expected_updates": expected_updates,
            "pass": not failures,
            "checks": checks,
            "failures": failures,
        }
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n",
                          encoding="utf-8")
        print(json.dumps(result, sort_keys=True))
        if failures and not args.soft_fail:
            raise SystemExit(3)
    except GateFailure as error:
        result = {"schema": 1, "candidate": args.candidate, "stage": int(args.stage),
                  "pass": False, "infrastructure_error": str(error)}
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n",
                          encoding="utf-8")
        print(json.dumps(result, sort_keys=True))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
