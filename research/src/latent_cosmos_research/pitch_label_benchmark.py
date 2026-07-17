"""Synthetic ground-truth benchmark for P0-C pitch-label selection.

The P0-B training adapter deliberately used torchaudio's NCCF estimator as a
smoke-quality label source.  This module measures that exact extraction path on
signals whose fundamental frequency, gate and voiced state are known.  It does
not evaluate the conditioned decoder and must not be presented as evidence of
pitch controllability.
"""
from __future__ import annotations

import argparse
import json
import math
import platform
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np

from .conditioning import midi_to_hz


SAMPLE_RATE = 44_100
SAMPLES_PER_FRAME = 128
RMS_FLOOR = 0.02
DEFAULT_MIDI_NOTES = (36, 43, 48, 55, 60, 67, 72, 79, 84)
DEFAULT_TARGET_RMS = (0.04, 0.12)
DEFAULT_PROFILES = ("sine", "saw", "odd", "missing_fundamental")

QUALITY_THRESHOLDS = {
    "median_abs_cents_max": 25.0,
    "p95_abs_cents_max": 50.0,
    "gross_pitch_error_ratio_max": 0.01,
    "voiced_recall_min": 0.95,
    "unvoiced_false_positive_ratio_max": 0.05,
    "gate_error_ratio_max": 0.01,
}


@dataclass(frozen=True)
class SyntheticPitchCase:
    name: str
    category: str
    waveform: np.ndarray
    true_f0_hz: np.ndarray
    true_gate: np.ndarray
    metadata: dict[str, object]

    @property
    def frames(self) -> int:
        return int(self.true_f0_hz.shape[0])


def _normalize_rms(waveform: np.ndarray, target_rms: float) -> np.ndarray:
    measured = float(np.sqrt(np.mean(np.square(waveform, dtype=np.float64))))
    if measured == 0.0:
        return np.zeros_like(waveform, dtype=np.float32)
    return (waveform * (target_rms / measured)).astype(np.float32)


def _harmonic_indices(profile: str, f0_hz: float, sample_rate: int) -> tuple[np.ndarray, np.ndarray]:
    maximum = max(1, min(32, int((sample_rate / 2.0) // f0_hz)))
    indices = np.arange(1, maximum + 1, dtype=np.float64)
    if profile == "sine":
        return np.asarray([1.0]), np.asarray([1.0])
    if profile == "saw":
        return indices, 1.0 / indices
    if profile == "odd":
        odd = indices[indices.astype(np.int64) % 2 == 1]
        return odd, 1.0 / odd
    if profile == "missing_fundamental":
        missing = indices[indices >= 2]
        if missing.size < 2:
            return np.asarray([1.0]), np.asarray([1.0])
        return missing, 1.0 / missing
    raise ValueError(f"unknown harmonic profile: {profile}")


def synthesize_harmonic(
    f0_hz: float,
    target_rms: float,
    frames: int,
    *,
    profile: str,
    sample_rate: int = SAMPLE_RATE,
    samples_per_frame: int = SAMPLES_PER_FRAME,
) -> np.ndarray:
    samples = frames * samples_per_frame
    time = np.arange(samples, dtype=np.float64) / float(sample_rate)
    harmonics, amplitudes = _harmonic_indices(profile, f0_hz, sample_rate)
    phase = 2.0 * math.pi * f0_hz * harmonics[:, None] * time[None, :]
    waveform = np.sum(amplitudes[:, None] * np.sin(phase), axis=0)
    return _normalize_rms(waveform, target_rms)


def build_synthetic_suite(
    *,
    frames: int = 192,
    midi_notes: Sequence[int] = DEFAULT_MIDI_NOTES,
    target_rms_values: Sequence[float] = DEFAULT_TARGET_RMS,
    profiles: Sequence[str] = DEFAULT_PROFILES,
    seed: int = 7,
) -> list[SyntheticPitchCase]:
    if frames < 64:
        raise ValueError("frames must be >= 64 so NCCF median smoothing has stable context")
    cases: list[SyntheticPitchCase] = []
    for midi_note in midi_notes:
        f0_hz = float(midi_to_hz(float(midi_note)))
        for target_rms in target_rms_values:
            for profile in profiles:
                waveform = synthesize_harmonic(
                    f0_hz, target_rms, frames, profile=profile
                )
                cases.append(
                    SyntheticPitchCase(
                        name=f"midi-{midi_note}_{profile}_rms-{target_rms:.3f}",
                        category=f"voiced/{profile}",
                        waveform=waveform,
                        true_f0_hz=np.full(frames, f0_hz, dtype=np.float32),
                        true_gate=np.ones(frames, dtype=np.float32),
                        metadata={
                            "midi_note": midi_note,
                            "f0_hz": f0_hz,
                            "target_rms": target_rms,
                            "profile": profile,
                        },
                    )
                )

    samples = frames * SAMPLES_PER_FRAME
    rng = np.random.default_rng(seed)
    silence = np.zeros(samples, dtype=np.float32)
    cases.append(
        SyntheticPitchCase(
            name="silence",
            category="unvoiced/silence",
            waveform=silence,
            true_f0_hz=np.zeros(frames, dtype=np.float32),
            true_gate=np.zeros(frames, dtype=np.float32),
            metadata={"target_rms": 0.0},
        )
    )
    for target_rms in target_rms_values:
        white = _normalize_rms(rng.standard_normal(samples), target_rms)
        lowpass = np.convolve(
            rng.standard_normal(samples + 15), np.ones(16) / 16.0, mode="valid"
        )[:samples]
        lowpass = _normalize_rms(lowpass, target_rms)
        for profile, waveform in (("white", white), ("lowpass", lowpass)):
            cases.append(
                SyntheticPitchCase(
                    name=f"noise-{profile}_rms-{target_rms:.3f}",
                    category=f"unvoiced/noise-{profile}",
                    waveform=waveform,
                    true_f0_hz=np.zeros(frames, dtype=np.float32),
                    true_gate=np.ones(frames, dtype=np.float32),
                    metadata={"target_rms": target_rms, "profile": profile},
                )
            )

    # A frame-aligned note with real note-on/off regions checks that f0=0 and
    # gate=0 survive transitions rather than only all-silence examples.
    active_start = frames // 4
    active_end = frames - active_start
    for midi_note in (45, 69):
        f0_hz = float(midi_to_hz(float(midi_note)))
        active_frames = active_end - active_start
        waveform = np.zeros(samples, dtype=np.float32)
        waveform[
            active_start * SAMPLES_PER_FRAME : active_end * SAMPLES_PER_FRAME
        ] = synthesize_harmonic(f0_hz, 0.12, active_frames, profile="saw")
        true_f0 = np.zeros(frames, dtype=np.float32)
        true_f0[active_start:active_end] = f0_hz
        true_gate = np.zeros(frames, dtype=np.float32)
        true_gate[active_start:active_end] = 1.0
        cases.append(
            SyntheticPitchCase(
                name=f"segmented-midi-{midi_note}",
                category="transition/voiced-silence",
                waveform=waveform,
                true_f0_hz=true_f0,
                true_gate=true_gate,
                metadata={"midi_note": midi_note, "f0_hz": f0_hz},
            )
        )
    return cases


def _safe_ratio(numerator: int, denominator: int) -> float:
    return float(numerator / denominator) if denominator else 0.0


def summarize_predictions(
    true_f0_hz: np.ndarray,
    true_gate: np.ndarray,
    predicted_f0_hz: np.ndarray,
    predicted_gate: np.ndarray,
) -> dict[str, float | int]:
    true_f0 = np.asarray(true_f0_hz, dtype=np.float64).reshape(-1)
    pred_f0 = np.asarray(predicted_f0_hz, dtype=np.float64).reshape(-1)
    true_gate_flat = np.asarray(true_gate).reshape(-1) > 0.5
    pred_gate_flat = np.asarray(predicted_gate).reshape(-1) > 0.5
    if not (true_f0.shape == pred_f0.shape == true_gate_flat.shape == pred_gate_flat.shape):
        raise ValueError("truth and prediction arrays must have identical shapes")

    true_voiced = true_f0 > 0.0
    pred_voiced = pred_f0 > 0.0
    both_voiced = true_voiced & pred_voiced
    unvoiced = ~true_voiced
    cents = 1200.0 * np.log2(pred_f0[both_voiced] / true_f0[both_voiced])
    abs_cents = np.abs(cents)
    octave_distance = np.minimum.reduce(
        [np.abs(abs_cents - octave) for octave in (1200.0, 2400.0, 3600.0)]
    ) if abs_cents.size else np.asarray([], dtype=np.float64)

    result: dict[str, float | int] = {
        "frames": int(true_f0.size),
        "true_voiced_frames": int(true_voiced.sum()),
        "true_unvoiced_frames": int(unvoiced.sum()),
        "predicted_voiced_frames": int(pred_voiced.sum()),
        "voiced_recall": _safe_ratio(int(both_voiced.sum()), int(true_voiced.sum())),
        "unvoiced_false_positive_ratio": _safe_ratio(
            int((pred_voiced & unvoiced).sum()), int(unvoiced.sum())
        ),
        "gate_error_ratio": float(np.mean(true_gate_flat != pred_gate_flat)),
        "gate_false_open_ratio": _safe_ratio(
            int((pred_gate_flat & ~true_gate_flat).sum()), int((~true_gate_flat).sum())
        ),
        "gate_false_closed_ratio": _safe_ratio(
            int((~pred_gate_flat & true_gate_flat).sum()), int(true_gate_flat.sum())
        ),
        "pitch_compared_frames": int(abs_cents.size),
        "median_abs_cents": float(np.median(abs_cents)) if abs_cents.size else 0.0,
        "p95_abs_cents": float(np.percentile(abs_cents, 95)) if abs_cents.size else 0.0,
        "p99_abs_cents": float(np.percentile(abs_cents, 99)) if abs_cents.size else 0.0,
        "mean_signed_cents": float(np.mean(cents)) if cents.size else 0.0,
        "within_50_cents_ratio": float(np.mean(abs_cents <= 50.0)) if abs_cents.size else 0.0,
        "gross_pitch_error_ratio": float(np.mean(abs_cents >= 600.0)) if abs_cents.size else 0.0,
        "octave_error_ratio": float(np.mean(octave_distance <= 100.0)) if octave_distance.size else 0.0,
    }
    return result


def _recommendation(metrics: dict[str, float | int]) -> tuple[str, list[str]]:
    failures: list[str] = []
    comparisons = (
        ("median_abs_cents", "median_abs_cents_max", lambda value, threshold: value <= threshold),
        ("p95_abs_cents", "p95_abs_cents_max", lambda value, threshold: value <= threshold),
        (
            "gross_pitch_error_ratio",
            "gross_pitch_error_ratio_max",
            lambda value, threshold: value <= threshold,
        ),
        ("voiced_recall", "voiced_recall_min", lambda value, threshold: value >= threshold),
        (
            "unvoiced_false_positive_ratio",
            "unvoiced_false_positive_ratio_max",
            lambda value, threshold: value <= threshold,
        ),
        ("gate_error_ratio", "gate_error_ratio_max", lambda value, threshold: value <= threshold),
    )
    for metric_name, threshold_name, predicate in comparisons:
        value = float(metrics[metric_name])
        threshold = QUALITY_THRESHOLDS[threshold_name]
        if not predicate(value, threshold):
            failures.append(f"{metric_name}={value:.6g} violates {threshold_name}={threshold:.6g}")

    pitch_metrics = {"median_abs_cents", "p95_abs_cents", "gross_pitch_error_ratio", "voiced_recall"}
    pitch_failed = any(item.split("=", 1)[0] in pitch_metrics for item in failures)
    voicing_failed = any(item.startswith("unvoiced_false_positive_ratio=") for item in failures)
    if not failures:
        decision = "provisionally_accept_nccf_pending_real_corpus_audit"
    elif not pitch_failed and voicing_failed:
        decision = "keep_nccf_pitch_candidate_but_add_separate_voicing_estimator"
    else:
        decision = "replace_or_reconfigure_nccf_before_long_training"
    return decision, failures


def _frame_rms_gate(cases: Sequence[SyntheticPitchCase]) -> np.ndarray:
    waveforms = np.stack([case.waveform for case in cases])
    frames = cases[0].frames
    framed = waveforms.reshape(len(cases), frames, SAMPLES_PER_FRAME)
    rms = np.sqrt(np.mean(np.square(framed, dtype=np.float64), axis=-1) + 1e-12)
    return (rms > RMS_FLOOR).astype(np.float32)


def _prediction_report(
    cases: Sequence[SyntheticPitchCase],
    predicted_f0: np.ndarray,
    predicted_gate: np.ndarray,
    estimator: dict[str, object],
    runtime: dict[str, object],
) -> dict[str, object]:
    true_f0 = np.stack([case.true_f0_hz for case in cases])
    true_gate = np.stack([case.true_gate for case in cases])
    aggregate = summarize_predictions(true_f0, true_gate, predicted_f0, predicted_gate)

    category_metrics: dict[str, dict[str, float | int]] = {}
    for category in sorted({case.category for case in cases}):
        indices = [index for index, case in enumerate(cases) if case.category == category]
        category_metrics[category] = summarize_predictions(
            true_f0[indices], true_gate[indices], predicted_f0[indices], predicted_gate[indices]
        )

    midi_metrics: dict[str, dict[str, float | int]] = {}
    midi_notes = sorted(
        {int(case.metadata["midi_note"]) for case in cases if "midi_note" in case.metadata}
    )
    for midi_note in midi_notes:
        indices = [
            index
            for index, case in enumerate(cases)
            if case.category.startswith("voiced/") and case.metadata.get("midi_note") == midi_note
        ]
        if indices:
            midi_metrics[str(midi_note)] = summarize_predictions(
                true_f0[indices], true_gate[indices], predicted_f0[indices], predicted_gate[indices]
            )

    decision, failures = _recommendation(aggregate)
    return {
        "estimator": estimator,
        "runtime": runtime,
        "aggregate": aggregate,
        "by_category": category_metrics,
        "by_midi_note": midi_metrics,
        "decision": decision,
        "threshold_failures": failures,
    }


def evaluate_cases(
    cases: Sequence[SyntheticPitchCase],
    *,
    batch_size: int = 16,
    device: str = "cpu",
) -> dict[str, object]:
    try:
        import torch
        import torchaudio
        from .pitch_rave import extract_conditioning
    except ImportError as error:
        raise SystemExit("benchmark requires `uv run --extra rave`") from error
    if not cases:
        raise ValueError("at least one synthetic case is required")
    frame_counts = {case.frames for case in cases}
    sample_counts = {case.waveform.shape[0] for case in cases}
    if len(frame_counts) != 1 or len(sample_counts) != 1:
        raise ValueError("all cases must share one frame and sample length")

    predictions: list[np.ndarray] = []
    torch_device = torch.device(device)
    for start in range(0, len(cases), batch_size):
        batch = np.stack([case.waveform for case in cases[start : start + batch_size]])
        audio = torch.from_numpy(batch[:, None, :]).to(torch_device)
        conditioning = extract_conditioning(
            audio, SAMPLE_RATE, SAMPLES_PER_FRAME, rms_floor=RMS_FLOOR
        )
        predictions.extend(conditioning.detach().cpu().numpy())

    pred_f0 = np.stack([prediction[0] for prediction in predictions])
    pred_gate = np.stack([prediction[2] for prediction in predictions])
    return _prediction_report(
        cases,
        pred_f0,
        pred_gate,
        estimator={
            "name": "torchaudio.functional.detect_pitch_frequency",
            "algorithm": "NCCF + median smoothing",
            "torch_version": torch.__version__,
            "torchaudio_version": torchaudio.__version__,
        },
        runtime={"device": str(torch_device), "platform": platform.platform()},
    )


def evaluate_pyin_cases(cases: Sequence[SyntheticPitchCase]) -> dict[str, object]:
    try:
        import librosa
    except ImportError as error:
        raise SystemExit("pYIN comparison requires `uv run --extra rave --extra analysis`") from error
    if not cases:
        raise ValueError("at least one synthetic case is required")
    predicted: list[np.ndarray] = []
    for case in cases:
        f0_hz, _, _ = librosa.pyin(
            case.waveform,
            fmin=50.0,
            fmax=2000.0,
            sr=SAMPLE_RATE,
            frame_length=2048,
            hop_length=SAMPLES_PER_FRAME,
            center=True,
            fill_na=np.nan,
        )
        aligned = np.nan_to_num(
            f0_hz[: case.frames], nan=0.0, posinf=0.0, neginf=0.0
        ).astype(np.float32)
        if aligned.shape[0] < case.frames:
            aligned = np.pad(aligned, (0, case.frames - aligned.shape[0]))
        predicted.append(aligned)
    return _prediction_report(
        cases,
        np.stack(predicted),
        _frame_rms_gate(cases),
        estimator={
            "name": "librosa.pyin",
            "algorithm": "probabilistic YIN",
            "librosa_version": librosa.__version__,
            "frame_length": 2048,
            "hop_length": SAMPLES_PER_FRAME,
        },
        runtime={"device": "cpu", "platform": platform.platform()},
    )


def run_benchmark(
    *,
    frames: int = 192,
    batch_size: int = 16,
    device: str = "cpu",
    estimators: Sequence[str] = ("nccf", "pyin"),
) -> dict[str, object]:
    cases = build_synthetic_suite(frames=frames)
    candidates: dict[str, dict[str, object]] = {}
    if "nccf" in estimators:
        candidates["nccf_current"] = evaluate_cases(
            cases, batch_size=batch_size, device=device
        )
    if "pyin" in estimators:
        candidates["pyin_offline"] = evaluate_pyin_cases(cases)
    unknown = set(estimators) - {"nccf", "pyin"}
    if unknown:
        raise ValueError(f"unknown estimators: {sorted(unknown)}")

    nccf = candidates.get("nccf_current")
    pyin = candidates.get("pyin_offline")
    if nccf and pyin:
        nccf_pitch_failed = float(nccf["aggregate"]["gross_pitch_error_ratio"]) > QUALITY_THRESHOLDS[
            "gross_pitch_error_ratio_max"
        ]
        pyin_pitch_passed = (
            float(pyin["aggregate"]["median_abs_cents"]) <= QUALITY_THRESHOLDS["median_abs_cents_max"]
            and float(pyin["aggregate"]["p95_abs_cents"]) <= QUALITY_THRESHOLDS["p95_abs_cents_max"]
            and float(pyin["aggregate"]["gross_pitch_error_ratio"])
            <= QUALITY_THRESHOLDS["gross_pitch_error_ratio_max"]
        )
        if nccf_pitch_failed and pyin_pitch_passed:
            decision = "precompute_pyin_candidate_labels_then_audit_real_corpus_voicing_and_gate"
        else:
            decision = "no_label_strategy_selected_review_candidate_failures"
    else:
        decision = "single_estimator_diagnostic_only"

    return {
        "schema_version": "p0c-pitch-label-benchmark-v2",
        "scope": "synthetic label extraction only; not decoder pitch-control evidence",
        "dataset": {
            "cases": len(cases),
            "frames_per_case": frames,
            "sample_rate": SAMPLE_RATE,
            "samples_per_frame": SAMPLES_PER_FRAME,
            "midi_notes": sorted(
                {int(case.metadata["midi_note"]) for case in cases if "midi_note" in case.metadata}
            ),
            "categories": {
                category: sum(case.category == category for case in cases)
                for category in sorted({case.category for case in cases})
            },
        },
        "thresholds": QUALITY_THRESHOLDS,
        "candidates": candidates,
        "decision": decision,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark the P0-B NCCF training labels on synthetic f0/voicing truth."
    )
    parser.add_argument("--frames", type=int, default=192)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument(
        "--estimators",
        default="nccf,pyin",
        help="comma-separated candidates: nccf,pyin",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    estimators = tuple(item.strip() for item in args.estimators.split(",") if item.strip())
    report = run_benchmark(
        frames=args.frames, batch_size=args.batch_size, device=args.device, estimators=estimators
    )
    encoded = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
