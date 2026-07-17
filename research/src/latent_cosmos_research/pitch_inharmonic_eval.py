"""P0-C4B evaluation for inharmonic presets under periodicity conditioning.

`PERC BELL` and `PRIML WOOD` have no stable fundamental, so pYIN cents
metrics would be fabricated evidence. This evaluation judges them by what
their acoustics actually promise when the decoder is conditioned with the
target render's own loudness/gate/periodicity and the nominal note f0:

- onset: the output must start sounding when the target render does;
- spectral identification: the output must be closer (log-mel distance) to
  its commanded note's render than to the other three notes' renders --
  conditioning must actually move the output toward the commanded note;
- periodicity consistency: the measured voicedness of the output must track
  the target render's, i.e. no hallucinated stable tone on an inharmonic
  timbre and no collapse to noise on its tonal segments;
- envelope: the percussive decay shape must correlate with the target's.

The harmonic presets are NOT judged here: their hard constraint is the
existing intervention + output-invariance gates, rerun unchanged.
Gates are pre-registered in docs/p0c4b-periodicity-conditioning-plan.md.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import librosa
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


INHARMONIC_PRESETS = (21385, 36905)
SAMPLES_PER_FRAME = 128
REFERENCE_NOTE = 56
DEFAULT_SEED = 20260716

GATES = {
    "onset_max_frame_error": 5,
    "spectral_id_min_correct_per_preset": 3,
    "periodicity_median_abs_delta": 0.25,
    "periodicity_max_abs_delta": 0.40,
    "envelope_min_median_correlation": 0.80,
}


def frame_rms(audio: np.ndarray, samples_per_frame: int = SAMPLES_PER_FRAME) -> np.ndarray:
    frames = audio.shape[-1] // samples_per_frame
    framed = audio[: frames * samples_per_frame].reshape(frames, samples_per_frame)
    return np.sqrt(np.mean(np.square(framed), axis=-1) + 1e-12)


def onset_frame(
    rms: np.ndarray, threshold_ratio: float = 0.1, silence_floor: float = 1e-4
) -> int:
    """First frame whose RMS reaches threshold_ratio of the clip maximum.

    Returns len(rms) for silent clips so a model that fails to sound at all
    fails the onset gate instead of matching at frame zero.
    """
    peak = float(rms.max())
    if peak <= silence_floor:
        return len(rms)
    above = np.flatnonzero(rms >= threshold_ratio * peak)
    return int(above[0]) if above.size else len(rms)


def envelope_correlation(output: np.ndarray, target: np.ndarray) -> float:
    """Pearson correlation of log-RMS decay envelopes."""
    length = min(len(output), len(target))
    a = np.log10(frame_rms(output[:length]) + 1e-5)
    b = np.log10(frame_rms(target[:length]) + 1e-5)
    if a.std() <= 0 or b.std() <= 0:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


def log_mel(audio: np.ndarray, central: bool = True) -> np.ndarray:
    """Central-window log-mel spectrogram used for note identification."""
    if central:
        audio = audio[len(audio) // 4 : 3 * len(audio) // 4]
    mel = librosa.feature.melspectrogram(
        y=audio, sr=SAMPLE_RATE, n_fft=2048, hop_length=512, n_mels=128
    )
    return np.log(mel + 1e-5)


def mel_distance(a: np.ndarray, b: np.ndarray) -> float:
    frames = min(a.shape[-1], b.shape[-1])
    return float(np.mean(np.abs(a[..., :frames] - b[..., :frames])))


def summarize_preset(records: list[dict[str, object]]) -> dict[str, object]:
    """Fold one preset's per-note records into the pre-registered gates."""
    onset_errors = [abs(int(record["onset_frame_error"])) for record in records]
    spectral_correct = sum(bool(record["spectral_correct"]) for record in records)
    periodicity_deltas = [float(record["periodicity_abs_delta"]) for record in records]
    correlations = [float(record["envelope_correlation"]) for record in records]
    gates = {
        "onset_passed": bool(
            records
            and all(error <= GATES["onset_max_frame_error"] for error in onset_errors)
        ),
        "spectral_id_passed": spectral_correct
        >= GATES["spectral_id_min_correct_per_preset"],
        "periodicity_passed": bool(
            records
            and float(np.median(periodicity_deltas))
            <= GATES["periodicity_median_abs_delta"]
            and max(periodicity_deltas) <= GATES["periodicity_max_abs_delta"]
        ),
        "envelope_passed": bool(
            records
            and float(np.median(correlations))
            >= GATES["envelope_min_median_correlation"]
        ),
    }
    return {
        "interventions": len(records),
        "max_onset_frame_error": max(onset_errors) if onset_errors else None,
        "spectral_id_correct": spectral_correct,
        "median_periodicity_abs_delta": (
            float(np.median(periodicity_deltas)) if periodicity_deltas else None
        ),
        "max_periodicity_abs_delta": (
            max(periodicity_deltas) if periodicity_deltas else None
        ),
        "median_envelope_correlation": (
            float(np.median(correlations)) if correlations else None
        ),
        "gates": gates,
        "passed": all(gates.values()),
    }


def _conditioning_from_example(example: dict[str, torch.Tensor], frames: int, device: torch.device) -> torch.Tensor:
    conditioning = example["conditioning"][:, :frames].unsqueeze(0).to(device)
    if conditioning.shape[-1] != frames:
        raise ValueError("target render is shorter than the decoded latent")
    return conditioning


def run_inharmonic(
    model: PitchConditionedRAVE,
    dataset: DexedPitchPilotDataset,
    device: torch.device,
    preset_indices: set[int],
    audio_output: Path | None = None,
    seed: int = DEFAULT_SEED,
    oracle_target_latent: bool = False,
) -> dict[str, object]:
    by_preset: dict[int, dict[int, dict[str, object]]] = {}
    for clip in dataset.clips:
        metadata = clip["metadata"]
        if (
            int(metadata["preset_index"]) in preset_indices
            and int(metadata["velocity"]) == 75
            and int(metadata["midi_note"]) in PITCH_NOTES
        ):
            by_preset.setdefault(int(metadata["preset_index"]), {})[
                int(metadata["midi_note"])
            ] = clip
    missing = preset_indices - set(by_preset)
    if missing:
        raise ValueError(f"presets missing from the manifest: {sorted(missing)}")

    if audio_output:
        audio_output.mkdir(parents=True, exist_ok=True)
    per_preset: list[dict[str, object]] = []
    for preset_index, clips_by_note in sorted(by_preset.items()):
        if set(clips_by_note) != set(PITCH_NOTES):
            raise ValueError(f"preset {preset_index} lacks the four pilot notes")
        reference = clips_by_note[REFERENCE_NOTE]
        reference_audio = reference["audio"][..., :N_SIGNAL].unsqueeze(0).to(device)
        with torch.no_grad():
            reference_latent = _latent_mean(model, reference_audio)
        frames = reference_latent.shape[-1]

        target_audio = {
            note: dataset._example_from_clip(clips_by_note[note], 0)
            for note in PITCH_NOTES
        }
        target_mels = {
            note: log_mel(example["audio"][0, : frames * SAMPLES_PER_FRAME].numpy())
            for note, example in target_audio.items()
        }
        records: list[dict[str, object]] = []
        for note in PITCH_NOTES:
            example = target_audio[note]
            if oracle_target_latent:
                source_audio = example["audio"][..., :N_SIGNAL].unsqueeze(0).to(device)
                with torch.no_grad():
                    latent = _latent_mean(model, source_audio)
                if latent.shape[-1] != frames:
                    raise ValueError("oracle target latent has a different frame count")
            else:
                latent = reference_latent
            metadata = clips_by_note[note]["metadata"]
            expected_hz = float(metadata["expected_f0_hz"])
            conditioning = _conditioning_from_example(example, frames, device)
            # Noise-dominated excitation is intentionally stochastic at runtime,
            # but a scientific gate must be repeatable and independent of loop
            # ordering. Give every intervention its own stable RNG stream.
            intervention_seed = seed + preset_index * 100 + note
            torch.manual_seed(intervention_seed)
            if device.type == "cuda":
                torch.cuda.manual_seed_all(intervention_seed)
            with torch.no_grad():
                output, _ = model.decode_conditioned(latent, conditioning)
            waveform = output[0, 0].detach().cpu().numpy()
            target_waveform = example["audio"][0, : frames * SAMPLES_PER_FRAME].numpy()

            output_mel = log_mel(waveform)
            distances = {
                other: mel_distance(output_mel, target_mels[other])
                for other in PITCH_NOTES
            }
            nearest = min(distances, key=distances.get)
            output_summary = _pitch_summary(waveform, expected_hz)
            target_summary = _pitch_summary(target_waveform, expected_hz)
            record = {
                "preset_index": preset_index,
                "name": metadata["name"],
                "reference_midi_note": note if oracle_target_latent else REFERENCE_NOTE,
                "target_midi_note": note,
                "intervention_seed": intervention_seed,
                "onset_frame_error": onset_frame(frame_rms(waveform))
                - onset_frame(frame_rms(target_waveform)),
                "mel_distances": {str(key): value for key, value in distances.items()},
                "spectral_nearest_note": int(nearest),
                "spectral_correct": int(nearest) == note,
                "voiced_ratio_output": output_summary["voiced_ratio"],
                "voiced_ratio_target": target_summary["voiced_ratio"],
                "periodicity_abs_delta": abs(
                    output_summary["voiced_ratio"] - target_summary["voiced_ratio"]
                ),
                "envelope_correlation": envelope_correlation(waveform, target_waveform),
            }
            records.append(record)
            if audio_output:
                sf.write(
                    audio_output
                    / f"inharmonic_{preset_index:06d}_target_{note:03d}.wav",
                    waveform,
                    SAMPLE_RATE,
                )
        per_preset.append(
            {
                "preset_index": preset_index,
                "name": records[0]["name"],
                **summarize_preset(records),
                "records": records,
            }
        )
    return {
        "per_preset": per_preset,
        "summary": {
            "presets": len(per_preset),
            "presets_passed": sum(bool(item["passed"]) for item in per_preset),
            "all_passed": bool(per_preset)
            and all(bool(item["passed"]) for item in per_preset),
        },
        "seed": seed,
        "latent_source_mode": "target-oracle" if oracle_target_latent else "reference-56",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument(
        "--checkpoint",
        type=Path,
        required=True,
        help="Evaluate this exact checkpoint while taking config.gin from --run.",
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audio-output", type=Path)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--oracle-target-latent",
        action="store_true",
        help=(
            "Diagnostic only: encode each target render instead of reusing note 56. "
            "Separates reconstruction capacity from cross-pitch latent transfer."
        ),
    )
    parser.add_argument(
        "--preset-indices",
        default=",".join(str(index) for index in INHARMONIC_PRESETS),
        help="Comma-separated inharmonic preset subset.",
    )
    args = parser.parse_args()

    preset_indices = {int(value) for value in args.preset_indices.split(",") if value}
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    dataset = DexedPitchPilotDataset(
        args.manifest, n_signal=N_SIGNAL, sample_rate=SAMPLE_RATE, repeats=1
    )
    model, checkpoint = _load_model(
        args.run, PitchConditionedRAVE, device, checkpoint_override=args.checkpoint
    )
    result = run_inharmonic(
        model,
        dataset,
        device,
        preset_indices,
        args.audio_output,
        seed=args.seed,
        oracle_target_latent=args.oracle_target_latent,
    )
    report = {
        "schema_version": "p0c4b-inharmonic-eval-v2",
        "checkpoint": str(checkpoint),
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "manifest": str(args.manifest),
        "device": str(device),
        "gates_registered": GATES,
        **result,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=True), encoding="utf-8")
    print(
        json.dumps(
            {
                "checkpoint": str(checkpoint),
                "summary": result["summary"],
                "per_preset": [
                    {key: value for key, value in item.items() if key != "records"}
                    for item in result["per_preset"]
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
