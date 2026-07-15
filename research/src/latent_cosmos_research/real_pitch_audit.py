"""P0-C1b audit of offline pitch labels on real, note-annotated samples."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Sequence

import numpy as np

from .conditioning import midi_to_hz


NSYNTH_PATTERN = re.compile(r"^(?P<instrument>.+)-(?P<midi>\d{3})-(?P<velocity>\d{3})\.wav$")
TINYSOL_NOTE_PATTERN = re.compile(r"-(?P<note>[A-G](?:#|b)?)(?P<octave>-?\d)-")
NOTE_OFFSETS = {
    "C": 0,
    "C#": 1,
    "Db": 1,
    "D": 2,
    "D#": 3,
    "Eb": 3,
    "E": 4,
    "F": 5,
    "F#": 6,
    "Gb": 6,
    "G": 7,
    "G#": 8,
    "Ab": 8,
    "A": 9,
    "A#": 10,
    "Bb": 10,
    "B": 11,
}


@dataclass(frozen=True)
class LabeledSample:
    path: str
    dataset: str
    family: str
    instrument: str
    midi_note: int
    velocity: int | None
    expected_f0_hz: float | None = None


def parse_nsynth_path(path: Path) -> LabeledSample | None:
    match = NSYNTH_PATTERN.match(path.name)
    if not match:
        return None
    instrument = match.group("instrument")
    family = instrument.split("_", 1)[0]
    return LabeledSample(
        path=str(path),
        dataset="nsynth",
        family=family,
        instrument=instrument,
        midi_note=int(match.group("midi")),
        velocity=int(match.group("velocity")),
    )


def note_name_to_midi(note: str, octave: int) -> int:
    if note not in NOTE_OFFSETS:
        raise ValueError(f"unsupported note name: {note}")
    return (octave + 1) * 12 + NOTE_OFFSETS[note]


def parse_tinysol_path(path: Path, root: Path) -> LabeledSample | None:
    match = TINYSOL_NOTE_PATTERN.search(path.name)
    if not match:
        return None
    relative = path.relative_to(root)
    parts = relative.parts
    family = parts[0] if len(parts) > 1 else "unknown"
    instrument = parts[1] if len(parts) > 2 else family
    return LabeledSample(
        path=str(path),
        dataset="tinysol",
        family=family,
        instrument=instrument,
        midi_note=note_name_to_midi(match.group("note"), int(match.group("octave"))),
        velocity=None,
    )


def discover_samples(
    *,
    nsynth_root: Path | None = None,
    tinysol_root: Path | None = None,
    dexed_pilot: Path | None = None,
) -> list[LabeledSample]:
    samples: list[LabeledSample] = []
    if nsynth_root:
        for path in sorted(nsynth_root.glob("*.wav")):
            parsed = parse_nsynth_path(path)
            if parsed:
                samples.append(parsed)
    if tinysol_root:
        for path in sorted(tinysol_root.rglob("*.wav")):
            parsed = parse_tinysol_path(path, tinysol_root)
            if parsed:
                samples.append(parsed)
    if dexed_pilot:
        pilot = json.loads(dexed_pilot.read_text(encoding="utf-8"))
        source_root = Path(pilot["selection"]["source_root"])
        preset_categories = {
            int(item["preset_index"]): item.get("category") or "dexed"
            for item in pilot["presets"]
        }
        for item in pilot["clips"]:
            preset_index = int(item["preset_index"])
            samples.append(
                LabeledSample(
                    path=str(source_root / item["source_wav"]),
                    dataset="dexed",
                    family=f"preset-{preset_index:06d}",
                    instrument=str(item["name"]),
                    midi_note=int(item["midi_note"]),
                    velocity=int(item["velocity"]),
                    expected_f0_hz=float(item["expected_f0_hz"]),
                )
            )
    return samples


def _stable_rank(sample: LabeledSample, seed: int) -> str:
    return hashlib.sha256(f"{seed}:{sample.path}".encode()).hexdigest()


def stratified_sample(
    samples: Sequence[LabeledSample], limit_per_source: int, *, seed: int = 20260716
) -> list[LabeledSample]:
    """Round-robin dataset/family/register strata with deterministic ordering."""
    if limit_per_source <= 0:
        raise ValueError("limit_per_source must be positive")
    selected: list[LabeledSample] = []
    for dataset in sorted({sample.dataset for sample in samples}):
        source = [sample for sample in samples if sample.dataset == dataset]
        strata: dict[tuple[str, int], list[LabeledSample]] = {}
        for sample in source:
            register = sample.midi_note // 12
            strata.setdefault((sample.family, register), []).append(sample)
        for values in strata.values():
            values.sort(key=lambda sample: _stable_rank(sample, seed))
        families = sorted({key[0] for key in strata})
        family_registers = {
            family: sorted(key for key in strata if key[0] == family)
            for family in families
        }
        register_cursor = {family: 0 for family in families}
        source_selected: list[LabeledSample] = []
        while len(source_selected) < limit_per_source:
            progressed = False
            for family in families:
                keys = family_registers[family]
                for offset in range(len(keys)):
                    position = (register_cursor[family] + offset) % len(keys)
                    key = keys[position]
                    if strata[key]:
                        source_selected.append(strata[key].pop())
                        register_cursor[family] = (position + 1) % len(keys)
                        progressed = True
                        break
                if len(source_selected) >= limit_per_source:
                    break
            if not progressed:
                break
        selected.extend(source_selected)
    return selected


def _align(values: np.ndarray, frames: int, fill: float = 0.0) -> np.ndarray:
    result = np.asarray(values)[:frames]
    if result.shape[0] < frames:
        result = np.pad(result, (0, frames - result.shape[0]), constant_values=fill)
    return result


def audit_sample(
    sample: LabeledSample,
    *,
    target_sample_rate: int = 44_100,
    hop_length: int = 128,
    rms_floor: float = 0.02,
) -> dict[str, object]:
    try:
        import librosa
        import soundfile as sf
    except ImportError as error:
        raise SystemExit("real pitch audit requires `uv run --extra analysis`") from error
    waveform, source_sample_rate = sf.read(sample.path, always_2d=True, dtype="float32")
    mono = waveform.mean(axis=1)
    if source_sample_rate != target_sample_rate:
        mono = librosa.resample(
            mono, orig_sr=source_sample_rate, target_sr=target_sample_rate
        )
    f0_hz, _, voiced_probability = librosa.pyin(
        mono,
        fmin=50.0,
        fmax=2000.0,
        sr=target_sample_rate,
        frame_length=2048,
        hop_length=hop_length,
        center=True,
        fill_na=np.nan,
    )
    short_rms = librosa.feature.rms(
        y=mono, frame_length=hop_length, hop_length=hop_length, center=True
    )[0]
    long_rms = librosa.feature.rms(
        y=mono, frame_length=2048, hop_length=hop_length, center=True
    )[0]
    frames = min(len(f0_hz), len(short_rms), len(long_rms))
    f0_hz = _align(f0_hz, frames, np.nan)
    voiced_probability = _align(voiced_probability, frames, 0.0)
    short_rms = _align(short_rms, frames)
    long_rms = _align(long_rms, frames)

    core_start = frames // 4
    core_end = frames - core_start
    core_f0 = f0_hz[core_start:core_end]
    core_voiced = np.isfinite(core_f0)
    expected_hz = (
        sample.expected_f0_hz
        if sample.expected_f0_hz is not None
        else float(midi_to_hz(float(sample.midi_note)))
    )
    cents = 1200.0 * np.log2(core_f0[core_voiced] / expected_hz)
    abs_cents = np.abs(cents)
    return {
        **asdict(sample),
        "source_sample_rate": int(source_sample_rate),
        "target_sample_rate": target_sample_rate,
        "duration_seconds": float(len(mono) / target_sample_rate),
        "expected_f0_hz": expected_hz,
        "core_frames": int(core_f0.size),
        "core_voiced_ratio": float(core_voiced.mean()) if core_voiced.size else 0.0,
        "core_median_abs_cents": float(np.median(abs_cents)) if abs_cents.size else None,
        "core_p95_abs_cents": float(np.percentile(abs_cents, 95)) if abs_cents.size else None,
        "core_mean_signed_cents": float(np.mean(cents)) if cents.size else None,
        "core_octave_error_ratio": float(
            np.mean(np.minimum(np.abs(abs_cents - 1200.0), np.abs(abs_cents - 2400.0)) <= 100.0)
        ) if abs_cents.size else None,
        "core_short_gate_dropout_ratio": float(
            np.mean(short_rms[core_start:core_end] <= rms_floor)
        ),
        "core_long_gate_dropout_ratio": float(
            np.mean(long_rms[core_start:core_end] <= rms_floor)
        ),
        "core_median_voiced_probability": float(
            np.median(voiced_probability[core_start:core_end])
        ),
        "peak": float(np.max(np.abs(mono))) if mono.size else 0.0,
        "rms": float(np.sqrt(np.mean(np.square(mono, dtype=np.float64)))) if mono.size else 0.0,
    }


def _aggregate(records: Sequence[dict[str, object]]) -> dict[str, object]:
    valid = [record for record in records if record["core_median_abs_cents"] is not None]
    median_errors = np.asarray([record["core_median_abs_cents"] for record in valid], dtype=float)
    p95_errors = np.asarray([record["core_p95_abs_cents"] for record in valid], dtype=float)
    return {
        "clips": len(records),
        "clips_with_pitch": len(valid),
        "clip_pitch_coverage": len(valid) / len(records) if records else 0.0,
        "median_of_clip_median_abs_cents": float(np.median(median_errors)) if valid else None,
        "p95_of_clip_p95_abs_cents": float(np.percentile(p95_errors, 95)) if valid else None,
        "median_core_voiced_ratio": float(
            np.median([record["core_voiced_ratio"] for record in records])
        ) if records else 0.0,
        "median_short_gate_dropout_ratio": float(
            np.median([record["core_short_gate_dropout_ratio"] for record in records])
        ) if records else 0.0,
        "median_long_gate_dropout_ratio": float(
            np.median([record["core_long_gate_dropout_ratio"] for record in records])
        ) if records else 0.0,
    }


def run_audit(samples: Sequence[LabeledSample]) -> dict[str, object]:
    records = [audit_sample(sample) for sample in samples]
    by_dataset: dict[str, dict[str, object]] = {}
    by_family: dict[str, dict[str, object]] = {}
    for dataset in sorted({sample.dataset for sample in samples}):
        by_dataset[dataset] = _aggregate(
            [record for record in records if record["dataset"] == dataset]
        )
    for dataset, family in sorted({(sample.dataset, sample.family) for sample in samples}):
        by_family[f"{dataset}/{family}"] = _aggregate(
            [
                record
                for record in records
                if record["dataset"] == dataset and record["family"] == family
            ]
        )
    return {
        "schema_version": "p0c-real-pitch-audit-v1",
        "scope": "central 50% of real note-labeled clips; label audit, not decoder evidence",
        "aggregate": _aggregate(records),
        "by_dataset": by_dataset,
        "by_family": by_family,
        "records": records,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit pYIN and RMS gate labels on NSynth/TinySOL.")
    parser.add_argument("--nsynth-root", type=Path)
    parser.add_argument("--tinysol-root", type=Path)
    parser.add_argument("--dexed-pilot", type=Path)
    parser.add_argument("--limit-per-source", type=int, default=48)
    parser.add_argument("--midi-min", type=int, default=36)
    parser.add_argument("--midi-max", type=int, default=84)
    parser.add_argument("--seed", type=int, default=20260716)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.nsynth_root and not args.tinysol_root and not args.dexed_pilot:
        parser.error("at least one source root is required")
    discovered = discover_samples(
        nsynth_root=args.nsynth_root,
        tinysol_root=args.tinysol_root,
        dexed_pilot=args.dexed_pilot,
    )
    eligible = [
        sample for sample in discovered if args.midi_min <= sample.midi_note <= args.midi_max
    ]
    selected = stratified_sample(eligible, args.limit_per_source, seed=args.seed)
    report = run_audit(selected)
    report["selection"] = {
        "seed": args.seed,
        "limit_per_source": args.limit_per_source,
        "discovered": len(discovered),
        "eligible": len(eligible),
        "selected": len(selected),
        "midi_range": [args.midi_min, args.midi_max],
    }
    encoded = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
