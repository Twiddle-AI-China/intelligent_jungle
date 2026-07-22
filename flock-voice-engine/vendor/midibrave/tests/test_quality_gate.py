from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "check_short_quality_gate.py"


def quality_report(quality_scale: float = 1.0) -> dict:
    metrics: dict[str, dict[str, float]] = {}

    def add(name: str, statistic: str, value: float) -> None:
        metrics.setdefault(name, {})[statistic] = value

    for prefix in ("self", "cross", ""):
        stem = f"{prefix}_" if prefix else ""
        add(f"{stem}f0_absolute_cents", "median", 8.0)
        add(f"{stem}f0_absolute_cents", "p90", 18.0)
        add(f"{stem}f0_octave_error", "mean", 0.0)
        add(f"{stem}f0_periodicity", "median", 0.9)
        add(f"{stem}f0_low_periodicity_rate", "mean", 0.0)
    for prefix in ("self", "cross"):
        add(f"{prefix}_mr_stft", "median", 3.5 * quality_scale)
        add(f"{prefix}_lsd_db", "median", 32.0 * quality_scale)
        add(f"{prefix}_rms_error_db", "median", 2.0 * quality_scale)
        add(f"{prefix}_upper_band_energy_error_db", "p90", 22.0 * quality_scale)
        add(f"{prefix}_crest_factor_error", "p90", 5.0 * quality_scale)
        add(f"{prefix}_envelope_ripple_error", "p90", 0.06 * quality_scale)
        add(f"{prefix}_generated_clicks_per_second", "p90", 34000.0 * quality_scale)
    add("midi_swap_following", "mean", 1.0)
    add("timbre_preset_retrieval_at_1", "mean", 0.8)
    add("target_f0_absolute_cents", "median", 7.0)
    add("target_f0_absolute_cents", "p90", 19.0)
    add("target_f0_periodicity", "median", 0.87)
    add("target_f0_low_periodicity_rate", "mean", 0.02)
    return {"schema": 2, "evaluated_pairs": 256, "metrics": metrics}


def write_evaluation(path: Path, report: dict, sample_id: str = "same") -> Path:
    path.mkdir()
    metrics = path / "metrics.json"
    metrics.write_text(json.dumps(report), encoding="utf-8")
    diagnostics = [
        {"branch": branch, "sample_id": sample_id, "note": 60, "velocity": 50}
        for branch in ("self", "cross")
    ]
    (path / "pitch_diagnostics.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in diagnostics),
        encoding="utf-8",
    )
    return metrics


def test_short_gate_checks_training_log(tmp_path: Path):
    metrics: dict[str, dict[str, float]] = {}
    for prefix in ("self", "cross", ""):
        stem = f"{prefix}_" if prefix else ""
        metrics[f"{stem}f0_absolute_cents"] = {"median": 10.0, "p90": 20.0}
        metrics[f"{stem}f0_octave_error"] = {"mean": 0.0}
        metrics[f"{stem}f0_periodicity"] = {"median": 0.9}
        metrics[f"{stem}f0_low_periodicity_rate"] = {"mean": 0.0}
    metrics.update({
        "midi_swap_following": {"mean": 1.0},
        "target_f0_absolute_cents": {"median": 7.0, "p90": 19.0},
        "target_f0_periodicity": {"median": 0.87},
        "target_f0_low_periodicity_rate": {"mean": 0.02},
    })
    evaluation = tmp_path / "metrics.json"
    evaluation.write_text(json.dumps({"schema": 2, "metrics": metrics}),
                          encoding="utf-8")
    training = tmp_path / "metrics.jsonl"
    training.write_text("\n".join(json.dumps(row) for row in (
        {"loop_step": 21, "generator_updates": 21, "generator_step_applied": 1,
         "generator_parameter_delta": 1e-6, "generator_grad_norm": 2.0},
        {"loop_step": 1000, "generator_updates": 1000, "generator_step_applied": 1,
         "generator_parameter_delta": 1e-5, "generator_grad_norm": 1.0},
    )) + "\n", encoding="utf-8")
    output = tmp_path / "gate.json"
    subprocess.run([
        sys.executable, str(SCRIPT), "--stage", "1000",
        "--metrics", str(evaluation), "--training-log", str(training),
        "--output", str(output), "--candidate", "test",
    ], check=True)
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["pass"] is True
    names = {item["metric"] for item in report["checks"]}
    assert "training_amp_skip_rate" in names
    assert "training_applied_parameter_delta_positive" in names


def test_gate_can_make_unidentifiable_velocity_observational(tmp_path: Path):
    metrics: dict[str, dict[str, float]] = {}
    for prefix in ("self", "cross", ""):
        stem = f"{prefix}_" if prefix else ""
        metrics[f"{stem}f0_absolute_cents"] = {"median": 10.0, "p90": 20.0}
        metrics[f"{stem}f0_octave_error"] = {"mean": 0.0}
        metrics[f"{stem}f0_periodicity"] = {"median": 0.9}
        metrics[f"{stem}f0_low_periodicity_rate"] = {"mean": 0.0}
    metrics.update({
        "midi_swap_following": {"mean": 1.0},
        "target_f0_absolute_cents": {"median": 7.0, "p90": 19.0},
        "target_f0_periodicity": {"median": 0.87},
        "target_f0_low_periodicity_rate": {"mean": 0.02},
        "targeted_velocity_direction_accuracy": {"mean": 0.5},
        "targeted_velocity_margin_accuracy": {"mean": 0.0},
        "targeted_velocity_delta_error_db": {"median": 3.0},
    })
    evaluation = tmp_path / "metrics.json"
    evaluation.write_text(json.dumps({
        "schema": 2, "metrics": metrics, "targeted_velocity_pairs": 0,
    }), encoding="utf-8")
    output = tmp_path / "gate.json"
    subprocess.run([
        sys.executable, str(SCRIPT), "--stage", "5000",
        "--metrics", str(evaluation), "--output", str(output),
        "--candidate", "test", "--ignore-velocity",
    ], check=True)
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["pass"] is True
    assert not any(
        "velocity" in item["metric"] for item in report["checks"]
    )


def test_phase2_prior_gate_checks_same_stream_and_all_quality_guards(tmp_path: Path):
    prior = write_evaluation(tmp_path / "prior", quality_report())
    candidate = write_evaluation(tmp_path / "candidate", quality_report(0.98))
    training = tmp_path / "phase2.jsonl"
    training.write_text(json.dumps({
        "loop_step": 2896,
        "generator_updates": 2896,
        "generator_step_applied": 1,
        "generator_parameter_delta": 1e-5,
        "generator_grad_norm": 1.0,
    }) + "\n", encoding="utf-8")
    output = tmp_path / "gate.json"
    subprocess.run([
        sys.executable, str(SCRIPT), "--stage", "5000",
        "--metrics", str(candidate), "--prior", str(prior),
        "--training-log", str(training), "--expected-updates", "2896",
        "--require-prior-improvement", "--ignore-velocity",
        "--output", str(output), "--candidate", "phase2",
    ], check=True)
    result = json.loads(output.read_text(encoding="utf-8"))
    assert result["pass"] is True
    assert result["expected_updates"] == 2896
    assert result["prior_validation_stream"]["evaluated_pairs"] == 256
    names = {item["metric"] for item in result["checks"]}
    for prefix in ("self", "cross"):
        for suffix in (
            "mr_stft", "lsd_db", "rms_error_db",
            "upper_band_energy_error_db", "crest_factor_error",
            "envelope_ripple_error", "generated_clicks_per_second",
        ):
            assert f"{prefix}_{suffix}" in names
    assert "phase2_texture_transient_mean_relative_change" in names
    assert len(result["prior_relative_changes"]) == 12


def test_phase2_prior_gate_requires_meaningful_texture_benefit(tmp_path: Path):
    prior = write_evaluation(tmp_path / "prior", quality_report())
    candidate = write_evaluation(tmp_path / "candidate", quality_report())
    output = tmp_path / "gate.json"
    completed = subprocess.run([
        sys.executable, str(SCRIPT), "--stage", "5000",
        "--metrics", str(candidate), "--prior", str(prior),
        "--require-prior-improvement", "--ignore-velocity",
        "--output", str(output), "--candidate", "phase2",
    ], check=False)
    assert completed.returncode == 3
    result = json.loads(output.read_text(encoding="utf-8"))
    failed = {item["metric"] for item in result["failures"]}
    assert "phase2_texture_transient_mean_relative_change" in failed


def test_phase2_prior_gate_rejects_artifact_regression(tmp_path: Path):
    prior_report = quality_report()
    candidate_report = quality_report(0.95)
    candidate_report["metrics"]["self_envelope_ripple_error"]["p90"] = 0.075
    prior = write_evaluation(tmp_path / "prior", prior_report)
    candidate = write_evaluation(tmp_path / "candidate", candidate_report)
    output = tmp_path / "gate.json"
    completed = subprocess.run([
        sys.executable, str(SCRIPT), "--stage", "5000",
        "--metrics", str(candidate), "--prior", str(prior),
        "--require-prior-improvement", "--ignore-velocity",
        "--output", str(output), "--candidate", "phase2",
    ], check=False)
    assert completed.returncode == 3
    result = json.loads(output.read_text(encoding="utf-8"))
    assert "self_envelope_ripple_error" in {
        item["metric"] for item in result["failures"]
    }


def test_phase2_prior_gate_allows_small_quantile_rounding_tolerance(tmp_path: Path):
    prior_report = quality_report()
    candidate_report = quality_report(0.95)
    prior_ripple = prior_report["metrics"]["self_envelope_ripple_error"]["p90"]
    candidate_report["metrics"]["self_envelope_ripple_error"]["p90"] = (
        prior_ripple * 1.10 + 0.00005
    )
    prior = write_evaluation(tmp_path / "prior", prior_report)
    candidate = write_evaluation(tmp_path / "candidate", candidate_report)
    output = tmp_path / "gate.json"
    subprocess.run([
        sys.executable, str(SCRIPT), "--stage", "5000",
        "--metrics", str(candidate), "--prior", str(prior),
        "--require-prior-improvement", "--ignore-velocity",
        "--output", str(output), "--candidate", "phase2",
    ], check=True)


def test_phase2_prior_gate_rejects_different_validation_identity(tmp_path: Path):
    prior = write_evaluation(tmp_path / "prior", quality_report(), "sample-a")
    candidate = write_evaluation(
        tmp_path / "candidate", quality_report(0.98), "sample-b")
    output = tmp_path / "gate.json"
    completed = subprocess.run([
        sys.executable, str(SCRIPT), "--stage", "5000",
        "--metrics", str(candidate), "--prior", str(prior),
        "--require-prior-improvement", "--ignore-velocity",
        "--output", str(output), "--candidate", "phase2",
    ], check=False)
    assert completed.returncode == 2
    result = json.loads(output.read_text(encoding="utf-8"))
    assert "different validation sample identity/order" in result["infrastructure_error"]


def test_baseline_gate_rejects_different_validation_identity(tmp_path: Path):
    baseline = write_evaluation(tmp_path / "baseline", quality_report(), "sample-a")
    candidate = write_evaluation(
        tmp_path / "candidate", quality_report(0.98), "sample-b")
    output = tmp_path / "gate.json"
    completed = subprocess.run([
        sys.executable, str(SCRIPT), "--stage", "5000",
        "--metrics", str(candidate), "--baseline", str(baseline),
        "--ignore-velocity", "--output", str(output), "--candidate", "q50",
    ], check=False)
    assert completed.returncode == 2
    result = json.loads(output.read_text(encoding="utf-8"))
    assert "different validation sample identity/order" in result["infrastructure_error"]
