import json

import pytest

from scripts.summarize_quality150_trajectory import build_summary, load_reports


def report(step: int, scale: float = 1.0):
    metrics = {}

    def add(name, statistic, value):
        metrics.setdefault(name, {})[statistic] = value

    for prefix in ("self", "cross"):
        add(f"{prefix}_f0_absolute_cents", "median", 8.0 * scale)
        add(f"{prefix}_f0_absolute_cents", "p90", 18.0 * scale)
        add(f"{prefix}_f0_octave_error", "mean", 0.0)
        add(f"{prefix}_f0_periodicity", "median", 0.9 / scale)
        add(f"{prefix}_mr_stft", "median", 2.0 * scale)
        add(f"{prefix}_lsd_db", "median", 20.0 * scale)
        add(f"{prefix}_rms_error_db", "median", 1.0 * scale)
        add(f"{prefix}_upper_band_energy_error_db", "p90", 2.0 * scale)
        add(f"{prefix}_crest_factor_error", "p90", 2.0 * scale)
        add(f"{prefix}_envelope_ripple_error", "p90", 0.05 * scale)
        add(f"{prefix}_generated_clicks_per_second", "p90", 100.0 * scale)
    add("midi_swap_following", "mean", 1.0)
    add("timbre_preset_retrieval_at_1", "mean", 0.8)
    add("target_f0_absolute_cents", "median", 8.0)
    add("target_f0_absolute_cents", "p90", 20.0)
    add("target_f0_periodicity", "median", 0.88)
    add("target_f0_low_periodicity_rate", "mean", 0.02)
    return {
        "schema": 2,
        "config": "/same/config.yaml",
        "checkpoint_phase": 1,
        "checkpoint_generator_updates": step,
        "evaluated_pairs": 256,
        "metrics": metrics,
    }


def write_report(path, value, sample_id="same-sample"):
    path.mkdir()
    metrics = path / "metrics.json"
    metrics.write_text(json.dumps(value), encoding="utf-8")
    diagnostics = [
        {"branch": branch, "sample_id": sample_id, "note": 60, "velocity": 50}
        for branch in ("self", "cross")
    ]
    (path / "pitch_diagnostics.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in diagnostics), encoding="utf-8")
    return metrics


def test_same_validation_trajectory_passes_without_regression(tmp_path):
    paths = [write_report(tmp_path / str(step), report(step))
             for step in (1448, 5792, 23162)]
    summary = build_summary(load_reports(paths), 5792, 23162)
    assert summary["steps"] == [1448, 5792, 23162]
    assert summary["late_training_gate"]["pass"]


def test_same_validation_trajectory_flags_late_reconstruction_regression(tmp_path):
    paths = [
        write_report(tmp_path / "early", report(1448)),
        write_report(tmp_path / "reference", report(5792)),
        write_report(tmp_path / "final", report(23162, scale=1.2)),
    ]
    summary = build_summary(load_reports(paths), 5792, 23162)
    assert not summary["late_training_gate"]["pass"]
    failed = {item["metric"] for item in summary["late_training_gate"]["failures"]}
    assert "self_mr_stft" in failed
    assert "cross_crest_factor_error" in failed


def test_same_validation_trajectory_rejects_mismatched_target_stream(tmp_path):
    first = report(1448)
    second = report(5792)
    second["metrics"]["target_f0_absolute_cents"]["median"] = 9.0
    paths = [write_report(tmp_path / "first", first),
             write_report(tmp_path / "second", second)]
    with pytest.raises(ValueError, match="validation stream mismatch"):
        load_reports(paths)


def test_same_validation_trajectory_rejects_different_sample_order(tmp_path):
    paths = [write_report(tmp_path / "first", report(1448), sample_id="sample-a"),
             write_report(tmp_path / "second", report(5792), sample_id="sample-b")]
    with pytest.raises(ValueError, match="sample identity/order"):
        load_reports(paths)
