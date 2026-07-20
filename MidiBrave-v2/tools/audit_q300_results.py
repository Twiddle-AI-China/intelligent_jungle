from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path


RUN_ROOT = Path("/data/midibrave/runs/midibrave_quality300_optimized_v03")
EVALUATION_ROOT = Path("/data/midibrave/evaluation")
PHASES = {
    1: (40_564, EVALUATION_ROOT / "quality300-optimized-phase1"),
    2: (5_071, EVALUATION_ROOT / "quality300-optimized-phase2"),
}
REQUIRED_METRICS = {
    "self_mr_stft",
    "cross_mr_stft",
    "self_lsd_db",
    "cross_lsd_db",
    "self_upper_band_energy_error_db",
    "cross_upper_band_energy_error_db",
    "self_generated_clicks_per_second",
    "cross_generated_clicks_per_second",
    "self_crest_factor_error",
    "cross_crest_factor_error",
    "self_envelope_ripple_error",
    "cross_envelope_ripple_error",
    "self_rms_error_db",
    "cross_rms_error_db",
    "f0_absolute_cents",
    "f0_signed_cents",
    "f0_octave_error",
    "f0_periodicity",
    "f0_low_periodicity_rate",
    "target_f0_absolute_cents",
    "target_f0_octave_error",
    "target_f0_periodicity",
    "target_f0_low_periodicity_rate",
    "midi_swap_following",
    "velocity_direction_accuracy",
    "velocity_margin_accuracy",
    "velocity_delta_error_db",
    "same_preset_timbre_cosine",
    "timbre_preset_retrieval_at_1",
    "pitch_adversary_accuracy",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_last_jsonl(path: Path) -> dict[str, object]:
    require(path.is_file(), f"missing JSONL: {path}")
    last = ""
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                last = line
    require(bool(last), f"empty JSONL: {path}")
    return json.loads(last)


def audit_phase(phase: int, steps: int, output: Path) -> dict[str, object]:
    checkpoint = RUN_ROOT / f"phase{phase}" / f"step-{steps:09d}.pt"
    require(checkpoint.is_file(), f"missing final checkpoint: {checkpoint}")
    require(checkpoint.stat().st_size > 90_000_000, f"truncated checkpoint: {checkpoint}")

    last = read_last_jsonl(RUN_ROOT / f"phase{phase}" / "metrics.jsonl")
    require(int(last["generator_updates"]) == steps,
            f"phase {phase} last generator update is not {steps}")
    require(int(last["gradients_finite"]) == 1, f"phase {phase} final gradients are not finite")
    require(int(last["generator_step_applied"]) == 1,
            f"phase {phase} final generator step was not applied")
    if phase == 2:
        require(int(last["discriminator_updates"]) == steps,
                f"phase 2 last discriminator update is not {steps}")
        require(int(last["discriminator_step_applied"]) == 1,
                "phase 2 final discriminator step was not applied")
        require(float(last["pitch_adversary"]) > 0.0,
                "phase 2 pitch adversary was not enabled")

    metrics_path = output / "metrics.json"
    require(metrics_path.is_file(), f"missing evaluation report: {metrics_path}")
    report = json.loads(metrics_path.read_text(encoding="utf-8"))
    require(int(report["checkpoint_phase"]) == phase, f"wrong evaluated phase in {metrics_path}")
    require(int(report["checkpoint_generator_updates"]) == steps,
            f"wrong evaluated checkpoint update in {metrics_path}")
    require(int(report["evaluated_pairs"]) == 256, f"incomplete pair evaluation in {metrics_path}")
    require(int(report["listening_examples"]) == 24,
            f"incomplete listening examples in {metrics_path}")
    require(int(report["midi_grid"]["presets"]) == 6, f"wrong MIDI grid presets in {metrics_path}")
    require(int(report["midi_grid"]["audio_files"]) == 432,
            f"incomplete MIDI grid in {metrics_path}")

    metrics = report["metrics"]
    missing = REQUIRED_METRICS.difference(metrics)
    require(not missing, f"missing evaluation metrics in {metrics_path}: {sorted(missing)}")
    for name in REQUIRED_METRICS:
        summary = metrics[name]
        require(int(summary.get("count", 0)) > 0, f"empty metric {name} in {metrics_path}")
        for statistic in ("mean", "median", "p90"):
            require(math.isfinite(float(summary[statistic])),
                    f"non-finite {name}.{statistic} in {metrics_path}")

    example_wavs = list((output / "examples").glob("*.wav"))
    grid_wavs = list((output / "midi_grid").rglob("*.wav"))
    require(len(example_wavs) == 96, f"expected 96 listening WAVs, found {len(example_wavs)}")
    require(len(grid_wavs) == 432, f"expected 432 grid WAVs, found {len(grid_wavs)}")
    grid_manifest = output / "midi_grid" / "grid.jsonl"
    require(grid_manifest.is_file(), f"missing MIDI grid manifest: {grid_manifest}")
    require(sum(1 for line in grid_manifest.open(encoding="utf-8") if line.strip()) == 432,
            f"incomplete MIDI grid manifest: {grid_manifest}")

    return {
        "phase": phase,
        "checkpoint": str(checkpoint),
        "checkpoint_bytes": checkpoint.stat().st_size,
        "checkpoint_sha256": sha256(checkpoint),
        "generator_updates": steps,
        "evaluated_pairs": report["evaluated_pairs"],
        "listening_wavs": len(example_wavs),
        "midi_grid_wavs": len(grid_wavs),
        "metrics": len(metrics),
    }


def main() -> None:
    results = [audit_phase(phase, *PHASES[phase]) for phase in sorted(PHASES)]
    print(json.dumps({"status": "pass", "phases": results}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
