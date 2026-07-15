"""P0-C2 pitch intervention and residual-latent probe on the verified pilot."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cached_conv as cc
import gin
import librosa
import numpy as np
import soundfile as sf
import torch
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score
from sklearn.model_selection import LeaveOneGroupOut
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

import rave
import rave.blocks  # noqa: F401 -- gin registrations
import rave.core

from .pitch_pilot_dataset import DexedPitchPilotDataset
from .pitch_rave import PitchConditionedRAVE


SAMPLE_RATE = 44_100
N_SIGNAL = 131_072
PITCH_NOTES = (41, 48, 56, 63)


def _load_model(run: Path, model_class, device: torch.device):
    cc.use_cached_conv(False)
    gin.clear_config()
    config = rave.core.search_for_config(str(run))
    checkpoint = rave.core.search_for_run(str(run))
    if config is None or checkpoint is None:
        raise FileNotFoundError(f"run is missing config or checkpoint: {run}")
    gin.parse_config_file(config)
    model = model_class()
    state = torch.load(checkpoint, map_location="cpu")["state_dict"]
    incompatible = model.load_state_dict(state, strict=False)
    if incompatible.unexpected_keys:
        raise RuntimeError(f"unexpected checkpoint keys: {incompatible.unexpected_keys[:5]}")
    model.eval().to(device)
    return model, Path(checkpoint)


def _latent_mean(model, audio: torch.Tensor) -> torch.Tensor:
    distribution = model.encode(audio)
    return distribution.chunk(2, dim=1)[0]


def _pitch_summary(audio: np.ndarray, expected_hz: float) -> dict[str, float]:
    f0, voiced, probability = librosa.pyin(
        audio,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=SAMPLE_RATE,
        frame_length=2048,
        hop_length=256,
    )
    start, stop = len(f0) // 4, 3 * len(f0) // 4
    valid = np.isfinite(f0[start:stop]) & voiced[start:stop]
    values = f0[start:stop][valid]
    if values.size == 0:
        return {
            "voiced_ratio": 0.0,
            "median_f0_hz": 0.0,
            "median_abs_cents": float("inf"),
            "median_voiced_probability": 0.0,
        }
    cents = 1200.0 * np.log2(values / expected_hz)
    return {
        "voiced_ratio": float(valid.mean()),
        "median_f0_hz": float(np.median(values)),
        "median_abs_cents": float(np.median(np.abs(cents))),
        "median_voiced_probability": float(np.nanmedian(probability[start:stop][valid])),
    }


def _harmonic_envelope(audio: np.ndarray, f0_hz: float, harmonics: int = 16) -> np.ndarray:
    centre = audio[len(audio) // 4 : 3 * len(audio) // 4]
    spectrum = np.abs(np.fft.rfft(centre * np.hanning(len(centre)))) + 1e-9
    frequencies = np.fft.rfftfreq(len(centre), 1.0 / SAMPLE_RATE)
    values = []
    for harmonic in range(1, harmonics + 1):
        target = harmonic * f0_hz
        if target >= SAMPLE_RATE / 2:
            values.append(1e-9)
            continue
        index = int(np.argmin(np.abs(frequencies - target)))
        radius = max(1, int(round(15.0 * len(centre) / SAMPLE_RATE)))
        values.append(float(spectrum[max(0, index - radius) : index + radius + 1].max()))
    vector = np.log(np.asarray(values))
    vector -= vector.mean()
    norm = np.linalg.norm(vector)
    return vector / norm if norm > 0 else vector


def run_intervention(
    model: PitchConditionedRAVE,
    dataset: DexedPitchPilotDataset,
    device: torch.device,
    audio_output: Path | None,
) -> dict[str, object]:
    by_preset: dict[int, list[dict[str, object]]] = {}
    for clip in dataset.clips:
        metadata = clip["metadata"]
        if int(metadata["velocity"]) == 75 and int(metadata["midi_note"]) in PITCH_NOTES:
            by_preset.setdefault(int(metadata["preset_index"]), []).append(clip)

    records: list[dict[str, object]] = []
    slopes: list[float] = []
    timbre_similarities: list[float] = []
    outputs_by_preset: dict[int, list[np.ndarray]] = {}
    per_preset: list[dict[str, object]] = []
    if audio_output:
        audio_output.mkdir(parents=True, exist_ok=True)
    for preset_index, clips in sorted(by_preset.items()):
        clips_by_note = {int(clip["metadata"]["midi_note"]): clip for clip in clips}
        reference = clips_by_note[56]
        reference_audio = reference["audio"][..., :N_SIGNAL].unsqueeze(0).to(device)
        with torch.no_grad():
            latent = _latent_mean(model, reference_audio)
        frames = latent.shape[-1]
        reference_loudness = torch.sqrt(
            reference_audio[..., : frames * 128].reshape(1, 1, frames, 128).square().mean(-1)
            + 1e-12
        )[:, 0]
        expected_values: list[float] = []
        observed_values: list[float] = []
        envelopes: list[np.ndarray] = []
        outputs: list[np.ndarray] = []
        for note in PITCH_NOTES:
            metadata = clips_by_note[note]["metadata"]
            expected_hz = float(metadata["expected_f0_hz"])
            conditioning = torch.zeros(1, 3, frames, device=device)
            conditioning[:, 0] = expected_hz
            conditioning[:, 1] = reference_loudness
            conditioning[:, 2] = 1.0
            with torch.no_grad():
                output, _ = model.decode_conditioned(latent, conditioning)
            waveform = output[0, 0].detach().cpu().numpy()
            summary = _pitch_summary(waveform, expected_hz)
            record = {
                "preset_index": preset_index,
                "name": metadata["name"],
                "reference_midi_note": 56,
                "target_midi_note": note,
                "target_f0_hz": expected_hz,
                **summary,
            }
            records.append(record)
            outputs.append(waveform)
            if summary["median_f0_hz"] > 0:
                expected_values.append(math.log2(expected_hz))
                observed_values.append(math.log2(summary["median_f0_hz"]))
                envelopes.append(_harmonic_envelope(waveform, summary["median_f0_hz"]))
            if audio_output:
                sf.write(
                    audio_output / f"preset_{preset_index:06d}_target_{note:03d}.wav",
                    waveform,
                    SAMPLE_RATE,
                )
        outputs_by_preset[preset_index] = outputs
        slope = (
            float(np.polyfit(expected_values, observed_values, 1)[0])
            if len(expected_values) >= 2
            else 0.0
        )
        slopes.append(slope)
        preset_records = [
            record for record in records if int(record["preset_index"]) == preset_index
        ]
        preset_errors = [float(record["median_abs_cents"]) for record in preset_records]
        pitch_passed = (
            len(preset_records) == len(PITCH_NOTES)
            and all(error <= 50.0 for error in preset_errors)
            and all(float(record["voiced_ratio"]) >= 0.60 for record in preset_records)
            and 0.90 <= slope <= 1.10
        )
        per_preset.append(
            {
                "preset_index": preset_index,
                "name": preset_records[0]["name"],
                "median_abs_cents": float(np.median(preset_errors)),
                "max_abs_cents": float(np.max(preset_errors)),
                "pitch_response_slope": slope,
                "passed": pitch_passed,
            }
        )
        for left in range(len(envelopes)):
            for right in range(left + 1, len(envelopes)):
                timbre_similarities.append(float(np.dot(envelopes[left], envelopes[right])))

    finite_errors = [
        float(record["median_abs_cents"])
        for record in records
        if math.isfinite(float(record["median_abs_cents"]))
    ]
    pairwise_difference = []
    for preset_outputs in outputs_by_preset.values():
        for left in range(len(preset_outputs)):
            for right in range(left + 1, len(preset_outputs)):
                difference = preset_outputs[left] - preset_outputs[right]
                pairwise_difference.append(float(np.sqrt(np.mean(difference**2))))
    return {
        "records": records,
        "per_preset": per_preset,
        "summary": {
            "presets": len(by_preset),
            "interventions": len(records),
            "voiced_interventions": len(finite_errors),
            "median_abs_cents": (
                float(np.median(finite_errors)) if finite_errors else float("inf")
            ),
            "p95_abs_cents": (
                float(np.percentile(finite_errors, 95))
                if finite_errors
                else float("inf")
            ),
            "gross_error_ratio_over_100_cents": float(
                np.mean(np.asarray(finite_errors) > 100.0)
            ) if finite_errors else 1.0,
            "median_pitch_response_slope": float(np.median(slopes)) if slopes else 0.0,
            "presets_passed": sum(bool(item["passed"]) for item in per_preset),
            "median_harmonic_envelope_cosine": (
                float(np.median(timbre_similarities)) if timbre_similarities else 0.0
            ),
            "median_pairwise_waveform_rms_difference": (
                float(np.median(pairwise_difference)) if pairwise_difference else 0.0
            ),
        },
    }


def _probe_features(model, dataset: DexedPitchPilotDataset, device: torch.device):
    features, notes, groups = [], [], []
    with torch.no_grad():
        for clip in dataset.clips:
            metadata = clip["metadata"]
            if int(metadata["velocity"]) != 75 or int(metadata["midi_note"]) not in PITCH_NOTES:
                continue
            audio = clip["audio"][..., :N_SIGNAL].unsqueeze(0).to(device)
            latent = _latent_mean(model, audio)[0]
            central = latent[:, latent.shape[-1] // 4 : 3 * latent.shape[-1] // 4]
            features.append(central.mean(dim=-1).cpu().numpy())
            notes.append(float(metadata["midi_note"]))
            groups.append(int(metadata["preset_index"]))
    return np.asarray(features), np.asarray(notes), np.asarray(groups)


def _ridge_probe(features: np.ndarray, notes: np.ndarray, groups: np.ndarray) -> dict[str, float]:
    predictions = np.zeros_like(notes)
    splitter = LeaveOneGroupOut()
    for train, test in splitter.split(features, notes, groups):
        model = make_pipeline(StandardScaler(), Ridge(alpha=1.0))
        model.fit(features[train], notes[train])
        predictions[test] = model.predict(features[test])
    cents = np.abs(predictions - notes) * 100.0
    return {
        "leave_one_preset_out_median_abs_cents": float(np.median(cents)),
        "leave_one_preset_out_p95_abs_cents": float(np.percentile(cents, 95)),
        "leave_one_preset_out_r2": float(r2_score(notes, predictions)),
    }


def _group_center(features: np.ndarray, groups: np.ndarray) -> np.ndarray:
    centered = features.copy()
    for group in np.unique(groups):
        selected = groups == group
        centered[selected] -= centered[selected].mean(axis=0, keepdims=True)
    return centered


def run_probe(baseline, conditioned, dataset, device) -> dict[str, object]:
    baseline_features, notes, groups = _probe_features(baseline, dataset, device)
    del baseline
    torch.cuda.empty_cache() if device.type == "cuda" else None
    conditioned_features, conditioned_notes, conditioned_groups = _probe_features(
        conditioned, dataset, device
    )
    if not np.array_equal(notes, conditioned_notes) or not np.array_equal(groups, conditioned_groups):
        raise RuntimeError("baseline and conditioned probe samples differ")
    baseline_result = {
        "raw": _ridge_probe(baseline_features, notes, groups),
        "within_preset_centered": _ridge_probe(
            _group_center(baseline_features, groups), notes, groups
        ),
    }
    conditioned_result = {
        "raw": _ridge_probe(conditioned_features, notes, groups),
        "within_preset_centered": _ridge_probe(
            _group_center(conditioned_features, groups), notes, groups
        ),
    }
    baseline_error = baseline_result["within_preset_centered"][
        "leave_one_preset_out_median_abs_cents"
    ]
    conditioned_error = conditioned_result["within_preset_centered"][
        "leave_one_preset_out_median_abs_cents"
    ]
    return {
        "samples": int(len(notes)),
        "presets": int(len(np.unique(groups))),
        "target": "commanded MIDI note; leave-one-preset-out",
        "baseline": baseline_result,
        "conditioned": conditioned_result,
        "conditioned_to_baseline_error_ratio": float(conditioned_error / baseline_error),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--conditioned-run", type=Path, required=True)
    parser.add_argument("--baseline-run", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audio-output", type=Path)
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    dataset = DexedPitchPilotDataset(
        args.manifest, n_signal=N_SIGNAL, sample_rate=SAMPLE_RATE, repeats=1
    )
    conditioned, conditioned_checkpoint = _load_model(
        args.conditioned_run, PitchConditionedRAVE, device
    )
    intervention = run_intervention(conditioned, dataset, device, args.audio_output)
    baseline, baseline_checkpoint = _load_model(args.baseline_run, rave.RAVE, device)
    probe = run_probe(baseline, conditioned, dataset, device)
    report = {
        "schema_version": "p0c2-pitch-intervention-v1",
        "conditioned_checkpoint": str(conditioned_checkpoint),
        "baseline_checkpoint": str(baseline_checkpoint),
        "manifest": str(args.manifest),
        "device": str(device),
        "intervention": intervention,
        "residual_latent_probe": probe,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=True), encoding="utf-8")
    print(json.dumps({"intervention": intervention["summary"], "probe": probe}, indent=2))


if __name__ == "__main__":
    main()
