"""P0-C4A output-level pitch invariance: source-latent grid and atlas paths.

The residual-latent probe measures whether source pitch is *readable* from the
latent, which keyboard-tracking timbre confounds. The product property is
narrower: with the explicit condition fixed, output pitch must not follow the
source latent. This evaluation answers that directly, without any training:

- grid: every preset is decoded from all four source-note latents under all
  four target f0 conditions; the spread across source latents per
  (preset, target) cell is the leakage measurement;
- paths: latents of same-octave-group presets are linearly interpolated under
  a fixed f0 to imitate timbre roaming, and output pitch is tracked along the
  path.

Gates are pre-registered in docs/p0c4a-review-and-output-invariance-plan.md.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

from .pitch_pilot_dataset import DexedPitchPilotDataset
from .pitch_intervention import (
    N_SIGNAL,
    PITCH_NOTES,
    SAMPLE_RATE,
    _latent_mean,
    _load_model,
    _pitch_summary,
)
from .pitch_rave import PitchConditionedRAVE


GATES = {
    "grid_spread_median_cents": 25.0,
    "grid_spread_p95_cents": 50.0,
    "control_max_abs_cents": 50.0,
    "control_min_voiced_ratio": 0.60,
    "control_slope_low": 0.90,
    "control_slope_high": 1.10,
    "path_max_abs_cents": 50.0,
    "path_min_voiced_ratio": 0.60,
}


def cell_spread_cents(f0_values: list[float]) -> float:
    """Pitch range across source latents for one (preset, target) cell."""
    values = [value for value in f0_values if math.isfinite(value) and value > 0]
    if len(values) < 2:
        return float("inf")
    return 1200.0 * math.log2(max(values) / min(values))


def response_slope(expected_hz: list[float], observed_hz: list[float]) -> float:
    pairs = [
        (math.log2(expected), math.log2(observed))
        for expected, observed in zip(expected_hz, observed_hz)
        if math.isfinite(observed) and observed > 0
    ]
    if len(pairs) < 2:
        return 0.0
    xs, ys = zip(*pairs)
    return float(np.polyfit(xs, ys, 1)[0])


def summarize_grid(records: list[dict[str, object]]) -> dict[str, object]:
    """Aggregate grid records into invariance cells, control rows and gates."""
    cells: dict[tuple[int, int], list[float]] = {}
    rows: dict[tuple[int, int], list[dict[str, object]]] = {}
    for record in records:
        cell_key = (int(record["preset_index"]), int(record["target_midi_note"]))
        row_key = (int(record["preset_index"]), int(record["source_midi_note"]))
        cells.setdefault(cell_key, []).append(float(record["median_f0_hz"]))
        rows.setdefault(row_key, []).append(record)

    cell_reports = [
        {
            "preset_index": preset,
            "target_midi_note": target,
            "sources": len(values),
            "spread_cents": cell_spread_cents(values),
        }
        for (preset, target), values in sorted(cells.items())
    ]
    spreads = [item["spread_cents"] for item in cell_reports]
    finite_spreads = [value for value in spreads if math.isfinite(value)]

    row_reports = []
    for (preset, source), row in sorted(rows.items()):
        errors = [float(item["median_abs_cents"]) for item in row]
        slope = response_slope(
            [float(item["target_f0_hz"]) for item in row],
            [float(item["median_f0_hz"]) for item in row],
        )
        passed = (
            len(row) == len(PITCH_NOTES)
            and all(error <= GATES["control_max_abs_cents"] for error in errors)
            and all(
                float(item["voiced_ratio"]) >= GATES["control_min_voiced_ratio"]
                for item in row
            )
            and GATES["control_slope_low"] <= slope <= GATES["control_slope_high"]
        )
        row_reports.append(
            {
                "preset_index": preset,
                "source_midi_note": source,
                "median_abs_cents": float(np.median(errors)),
                "max_abs_cents": float(np.max(errors)),
                "pitch_response_slope": slope,
                "passed": passed,
            }
        )

    spread_median = float(np.median(spreads)) if spreads else float("inf")
    if spreads and len(finite_spreads) == len(spreads):
        spread_p95 = float(np.percentile(spreads, 95))
    else:
        spread_p95 = float("inf")
    grid_passed = (
        spread_median <= GATES["grid_spread_median_cents"]
        and spread_p95 <= GATES["grid_spread_p95_cents"]
    )
    control_passed = bool(row_reports) and all(item["passed"] for item in row_reports)
    return {
        "cells": cell_reports,
        "control_rows": row_reports,
        "summary": {
            "cells": len(cell_reports),
            "spread_median_cents": spread_median,
            "spread_p95_cents": spread_p95,
            "control_rows_passed": sum(bool(item["passed"]) for item in row_reports),
            "control_rows": len(row_reports),
        },
        "gates": {
            "grid_spread_passed": grid_passed,
            "control_passed": control_passed,
        },
    }


def octave_pairs(
    presets: dict[int, float], tolerance_cents: float = 10.0
) -> tuple[list[tuple[int, int, float]], list[tuple[int, int, float]]]:
    """Split preset pairs into same-octave (gated) and cross-octave (informational).

    ``presets`` maps preset_index -> expected_f0_hz at the reference note. The
    gated pairs share a conditioned f0 both endpoints saw in training; cross
    pairs use the geometric mean and are reported but not gated.
    """
    gated, informational = [], []
    indices = sorted(presets)
    for left in range(len(indices)):
        for right in range(left + 1, len(indices)):
            a, b = indices[left], indices[right]
            difference = abs(1200.0 * math.log2(presets[a] / presets[b]))
            if difference <= tolerance_cents:
                gated.append((a, b, float(presets[a])))
            else:
                informational.append((a, b, float(math.sqrt(presets[a] * presets[b]))))
    return gated, informational


def summarize_paths(path_reports: list[dict[str, object]]) -> dict[str, object]:
    gated = [item for item in path_reports if item["gated"]]
    passed = bool(gated) and all(item["passed"] for item in gated)
    worst = max(
        (float(item["max_abs_cents"]) for item in gated),
        default=float("inf"),
    )
    return {
        "paths": len(path_reports),
        "gated_paths": len(gated),
        "gated_paths_passed": sum(bool(item["passed"]) for item in gated),
        "worst_gated_max_abs_cents": worst,
        "paths_passed": passed,
    }


def _reference_clips(dataset: DexedPitchPilotDataset):
    by_preset: dict[int, dict[int, dict[str, object]]] = {}
    for clip in dataset.clips:
        metadata = clip["metadata"]
        if int(metadata["velocity"]) == 75 and int(metadata["midi_note"]) in PITCH_NOTES:
            by_preset.setdefault(int(metadata["preset_index"]), {})[
                int(metadata["midi_note"])
            ] = clip
    return by_preset


def _frame_loudness(audio: torch.Tensor, frames: int) -> torch.Tensor:
    return torch.sqrt(
        audio[..., : frames * 128].reshape(1, 1, frames, 128).square().mean(-1) + 1e-12
    )[:, 0]


def run_grid(
    model: PitchConditionedRAVE,
    dataset: DexedPitchPilotDataset,
    device: torch.device,
    audio_output: Path | None = None,
) -> dict[str, object]:
    by_preset = _reference_clips(dataset)
    records: list[dict[str, object]] = []
    if audio_output:
        audio_output.mkdir(parents=True, exist_ok=True)
    for preset_index, clips_by_note in sorted(by_preset.items()):
        for source_note in PITCH_NOTES:
            source = clips_by_note[source_note]
            source_audio = source["audio"][..., :N_SIGNAL].unsqueeze(0).to(device)
            with torch.no_grad():
                latent = _latent_mean(model, source_audio)
            frames = latent.shape[-1]
            loudness = _frame_loudness(source_audio, frames)
            for target_note in PITCH_NOTES:
                target_metadata = clips_by_note[target_note]["metadata"]
                expected_hz = float(target_metadata["expected_f0_hz"])
                conditioning = torch.zeros(1, 4, frames, device=device)
                conditioning[:, 0] = expected_hz
                conditioning[:, 1] = loudness
                conditioning[:, 2] = 1.0
                conditioning[:, 3] = 1.0
                with torch.no_grad():
                    output, _ = model.decode_conditioned(latent, conditioning)
                waveform = output[0, 0].detach().cpu().numpy()
                summary = _pitch_summary(waveform, expected_hz)
                records.append(
                    {
                        "preset_index": preset_index,
                        "name": target_metadata["name"],
                        "source_midi_note": source_note,
                        "target_midi_note": target_note,
                        "target_f0_hz": expected_hz,
                        **summary,
                    }
                )
                if audio_output:
                    sf.write(
                        audio_output
                        / f"grid_{preset_index:06d}_src{source_note:03d}_tgt{target_note:03d}.wav",
                        waveform,
                        SAMPLE_RATE,
                    )
    result = summarize_grid(records)
    result["records"] = records
    return result


def run_paths(
    model: PitchConditionedRAVE,
    dataset: DexedPitchPilotDataset,
    device: torch.device,
    steps: int = 9,
    reference_note: int = 56,
    audio_output: Path | None = None,
) -> dict[str, object]:
    by_preset = _reference_clips(dataset)
    latents: dict[int, torch.Tensor] = {}
    loudness_curves: dict[int, torch.Tensor] = {}
    expected: dict[int, float] = {}
    for preset_index, clips_by_note in sorted(by_preset.items()):
        clip = clips_by_note[reference_note]
        audio = clip["audio"][..., :N_SIGNAL].unsqueeze(0).to(device)
        with torch.no_grad():
            latent = _latent_mean(model, audio)
        latents[preset_index] = latent
        loudness_curves[preset_index] = _frame_loudness(audio, latent.shape[-1])
        expected[preset_index] = float(clip["metadata"]["expected_f0_hz"])

    gated_pairs, informational_pairs = octave_pairs(expected)
    if audio_output:
        audio_output.mkdir(parents=True, exist_ok=True)
    path_reports: list[dict[str, object]] = []
    for gated, pairs in ((True, gated_pairs), (False, informational_pairs)):
        for preset_a, preset_b, conditioned_hz in pairs:
            step_summaries = []
            for step in range(steps):
                alpha = step / (steps - 1)
                latent = (1.0 - alpha) * latents[preset_a] + alpha * latents[preset_b]
                loudness = (
                    (1.0 - alpha) * loudness_curves[preset_a]
                    + alpha * loudness_curves[preset_b]
                )
                conditioning = torch.zeros(1, 4, latent.shape[-1], device=device)
                conditioning[:, 0] = conditioned_hz
                conditioning[:, 1] = loudness
                conditioning[:, 2] = 1.0
                conditioning[:, 3] = 1.0
                with torch.no_grad():
                    output, _ = model.decode_conditioned(latent, conditioning)
                waveform = output[0, 0].detach().cpu().numpy()
                summary = _pitch_summary(waveform, conditioned_hz)
                step_summaries.append({"alpha": alpha, **summary})
                if audio_output:
                    sf.write(
                        audio_output
                        / f"path_{preset_a:06d}_{preset_b:06d}_step{step:02d}.wav",
                        waveform,
                        SAMPLE_RATE,
                    )
            errors = [float(item["median_abs_cents"]) for item in step_summaries]
            voiced = [float(item["voiced_ratio"]) for item in step_summaries]
            passed = all(
                error <= GATES["path_max_abs_cents"] for error in errors
            ) and all(ratio >= GATES["path_min_voiced_ratio"] for ratio in voiced)
            path_reports.append(
                {
                    "preset_a": preset_a,
                    "preset_b": preset_b,
                    "conditioned_f0_hz": conditioned_hz,
                    "gated": gated,
                    "max_abs_cents": float(np.max(errors)),
                    "min_voiced_ratio": float(np.min(voiced)),
                    "passed": passed,
                    "steps": step_summaries,
                }
            )
    return {"paths": path_reports, "summary": summarize_paths(path_reports)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument(
        "--checkpoint",
        type=Path,
        help="Evaluate this exact checkpoint while taking config.gin from --run.",
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audio-output", type=Path)
    parser.add_argument("--path-steps", type=int, default=9)
    parser.add_argument(
        "--preset-indices",
        help="Comma-separated preset subset, e.g. the six harmonic P0-C4A presets.",
    )
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    dataset = DexedPitchPilotDataset(
        args.manifest,
        n_signal=N_SIGNAL,
        sample_rate=SAMPLE_RATE,
        repeats=1,
        preset_indices=(
            {int(value) for value in args.preset_indices.split(",") if value}
            if args.preset_indices
            else None
        ),
    )
    model, checkpoint = _load_model(
        args.run, PitchConditionedRAVE, device, checkpoint_override=args.checkpoint
    )
    grid = run_grid(model, dataset, device, args.audio_output)
    paths = run_paths(
        model, dataset, device, steps=args.path_steps, audio_output=args.audio_output
    )
    overall = (
        grid["gates"]["grid_spread_passed"]
        and grid["gates"]["control_passed"]
        and paths["summary"]["paths_passed"]
    )
    report = {
        "schema_version": "p0c4a-pitch-invariance-v1",
        "checkpoint": str(checkpoint),
        "manifest": str(args.manifest),
        "device": str(device),
        "gates_registered": GATES,
        "grid": grid,
        "paths": paths,
        "overall_passed": overall,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=True), encoding="utf-8")
    print(
        json.dumps(
            {
                "checkpoint": str(checkpoint),
                "grid_summary": grid["summary"],
                "grid_gates": grid["gates"],
                "path_summary": paths["summary"],
                "overall_passed": overall,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
