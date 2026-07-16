"""Select a small timbre-diverse, multi-pitch Dexed pilot without copying audio."""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
from pathlib import Path
from typing import Sequence

import numpy as np

from .conditioning import midi_to_hz


PITCH_CONDITIONS = ((41, 75), (48, 75), (56, 75), (63, 75))
VELOCITY_CONDITIONS = ((56, 25), (56, 75), (56, 127))
ALL_CONDITIONS = tuple(dict.fromkeys(PITCH_CONDITIONS + VELOCITY_CONDITIONS))
FEATURE_NAMES = (
    "spectral_centroid_mean",
    "spectral_flatness_mean",
    "spectral_flux_mean",
    "attack_time_mean",
    "effective_duration_mean",
    "harmonic_energy_mean",
    "noisiness_mean",
    "inharmonicity_mean",
    "odd_even_ratio_mean",
    "rms_energy_mean",
)


def octave_residual_cents(f0_hz: float, reference_hz: float = 261.6255653005986) -> float:
    cents = 1200.0 * math.log2(f0_hz / reference_hz)
    return abs(cents - round(cents / 1200.0) * 1200.0)


def _read_candidates(database: Path) -> list[dict[str, object]]:
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    feature_sql = ", ".join(f"t.{name}" for name in FEATURE_NAMES)
    rows = connection.execute(
        f"""
        SELECT p.preset_index, p.name, p.bank, p.category,
               t.f0_mean, t.f0_std, {feature_sql}
        FROM presets p
        JOIN renders r ON r.preset_id = p.id
        JOIN features_tt t ON t.preset_id = p.id
        WHERE r.qc_valid = 1 AND r.is_silent = 0 AND r.clipping_detected = 0
          AND t.f0_mean BETWEEN 50 AND 2000
        ORDER BY p.preset_index
        """
    ).fetchall()
    connection.close()
    candidates: list[dict[str, object]] = []
    for row in rows:
        f0_hz = float(row["f0_mean"])
        f0_std = float(row["f0_std"] or 0.0)
        noisiness = row["noisiness_mean"]
        if octave_residual_cents(f0_hz) > 35.0:
            continue
        if f0_std / f0_hz > 0.10:
            continue
        if noisiness is not None and float(noisiness) > 0.35:
            continue
        candidates.append(dict(row))
    return candidates


def _read_render_manifest(path: Path) -> dict[int, dict[tuple[int, int], dict[str, object]]]:
    grouped: dict[int, dict[tuple[int, int], dict[str, object]]] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            item = json.loads(line)
            grouped.setdefault(int(item["preset_index"]), {})[
                (int(item["midi_note"]), int(item["velocity"]))
            ] = item
    return grouped


def _feature_matrix(candidates: Sequence[dict[str, object]]) -> np.ndarray:
    matrix = np.asarray(
        [
            [float(candidate[name]) if candidate[name] is not None else np.nan for name in FEATURE_NAMES]
            for candidate in candidates
        ],
        dtype=np.float64,
    )
    medians = np.nanmedian(matrix, axis=0)
    missing = np.where(np.isnan(matrix))
    matrix[missing] = medians[missing[1]]
    low, high = np.percentile(matrix, [25, 75], axis=0)
    scale = np.where(high > low, high - low, 1.0)
    return np.clip((matrix - medians) / scale, -5.0, 5.0)


def farthest_point_selection(
    candidates: Sequence[dict[str, object]], count: int
) -> list[dict[str, object]]:
    if count <= 0:
        raise ValueError("count must be positive")
    if len(candidates) < count:
        raise ValueError(f"only {len(candidates)} candidates available for requested {count}")
    matrix = _feature_matrix(candidates)
    norms = np.linalg.norm(matrix, axis=1)
    selected_indices = [int(np.argmin(norms))]
    minimum_distance = np.linalg.norm(matrix - matrix[selected_indices[0]], axis=1)
    while len(selected_indices) < count:
        minimum_distance[selected_indices] = -1.0
        next_index = int(np.argmax(minimum_distance))
        selected_indices.append(next_index)
        distance = np.linalg.norm(matrix - matrix[next_index], axis=1)
        minimum_distance = np.minimum(minimum_distance, distance)
    return [candidates[index] for index in selected_indices]


def build_pilot_manifest(
    database: Path,
    render_manifest: Path,
    *,
    count: int = 24,
) -> dict[str, object]:
    renders = _read_render_manifest(render_manifest)
    candidates = [
        candidate
        for candidate in _read_candidates(database)
        if all(condition in renders.get(int(candidate["preset_index"]), {}) for condition in ALL_CONDITIONS)
    ]
    selected = farthest_point_selection(candidates, count)
    clips: list[dict[str, object]] = []
    for candidate in selected:
        preset_index = int(candidate["preset_index"])
        pitch_offset_octaves = round(
            math.log2(float(candidate["f0_mean"]) / 261.6255653005986)
        )
        for midi_note, velocity in ALL_CONDITIONS:
            source = renders[preset_index][(midi_note, velocity)]
            commanded_f0_hz = float(midi_to_hz(float(midi_note)))
            clips.append(
                {
                    "preset_index": preset_index,
                    "name": candidate["name"],
                    "bank": candidate["bank"],
                    "category": candidate["category"],
                    "midi_note": midi_note,
                    "velocity": velocity,
                    "commanded_f0_hz": commanded_f0_hz,
                    "pitch_offset_octaves": pitch_offset_octaves,
                    "expected_f0_hz": commanded_f0_hz * (2.0 ** pitch_offset_octaves),
                    "role": (
                        "pitch+velocity"
                        if (midi_note, velocity) == (56, 75)
                        else "pitch" if velocity == 75 else "velocity"
                    ),
                    "source_wav": source["wav_path"],
                    "source_sample_rate": int(source["sample_rate"]),
                    "target_sample_rate": 44_100,
                    "note_on_seconds": 0.0,
                    "note_off_seconds": 3.0,
                    "window_seconds": 4.0,
                    "label_source": "controlled_midi_render",
                }
            )
    return {
        "schema_version": "p0c-dexed-pilot-v1",
        "selection": {
            "source_root": str(render_manifest.parent),
            "candidate_presets": len(candidates),
            "selected_presets": len(selected),
            "clips": len(clips),
            "pitch_conditions": [list(value) for value in PITCH_CONDITIONS],
            "velocity_conditions": [list(value) for value in VELOCITY_CONDITIONS],
            "feature_space": list(FEATURE_NAMES),
            "filters": {
                "midi60_octave_residual_cents_max": 35.0,
                "relative_f0_std_max": 0.10,
                "noisiness_mean_max": 0.35,
                "qc_valid": True,
            },
            "conditioning_labels": {
                "f0": "commanded MIDI plus verified per-preset integer-octave offset",
                "loudness": "measured from resampled waveform; velocity is not treated as acoustic RMS truth",
                "gate": "controlled render event: open [0s,3s), closed [3s,4s]",
            },
        },
        "presets": [
            {
                "preset_index": int(candidate["preset_index"]),
                "name": candidate["name"],
                "bank": candidate["bank"],
                "category": candidate["category"],
                "midi60_observed_f0_hz": float(candidate["f0_mean"]),
                "midi60_octave_residual_cents": octave_residual_cents(float(candidate["f0_mean"])),
                "features": {name: candidate[name] for name in FEATURE_NAMES},
            }
            for candidate in selected
        ],
        "clips": clips,
    }


def verify_pilot_manifest(
    pilot: dict[str, object],
    audit: dict[str, object],
    *,
    voiced_ratio_min: float = 0.80,
    median_abs_cents_max: float = 50.0,
    p95_abs_cents_max: float = 75.0,
    verified_count: int | None = None,
) -> dict[str, object]:
    records_by_preset: dict[int, list[dict[str, object]]] = {}
    for record in audit["records"]:
        if record["dataset"] != "dexed" or int(record["velocity"]) != 75:
            continue
        preset_index = int(str(record["family"]).split("-")[-1])
        records_by_preset.setdefault(preset_index, []).append(record)

    passed: list[int] = []
    failures: dict[str, list[str]] = {}
    for preset in pilot["presets"]:
        preset_index = int(preset["preset_index"])
        records = records_by_preset.get(preset_index, [])
        reasons: list[str] = []
        observed_conditions = {(int(record["midi_note"]), int(record["velocity"])) for record in records}
        missing = sorted(set(PITCH_CONDITIONS) - observed_conditions)
        if missing:
            reasons.append(f"missing pitch conditions: {missing}")
        for record in records:
            label = f"note{record['midi_note']}"
            if float(record["core_voiced_ratio"]) < voiced_ratio_min:
                reasons.append(f"{label} voiced_ratio={record['core_voiced_ratio']:.4f}")
            median_error = record["core_median_abs_cents"]
            p95_error = record["core_p95_abs_cents"]
            if median_error is None or float(median_error) > median_abs_cents_max:
                reasons.append(f"{label} median_abs_cents={median_error}")
            if p95_error is None or float(p95_error) > p95_abs_cents_max:
                reasons.append(f"{label} p95_abs_cents={p95_error}")
        if reasons:
            failures[str(preset_index)] = reasons
        else:
            passed.append(preset_index)

    eligible_passed = list(passed)
    if verified_count is not None:
        if verified_count <= 0:
            raise ValueError("verified_count must be positive")
        if len(eligible_passed) < verified_count:
            raise ValueError(
                f"only {len(eligible_passed)} presets passed verification; "
                f"requested {verified_count}"
            )
        passed = eligible_passed[:verified_count]

    verified = dict(pilot)
    verified["schema_version"] = "p0c-dexed-pilot-verified-v1"
    verified["selection"] = dict(pilot["selection"])
    verified["selection"]["verification"] = {
        "input_presets": len(pilot["presets"]),
        "passed_presets": len(passed),
        "eligible_passed_presets": len(eligible_passed),
        "rejected_presets": len(failures),
        "voiced_ratio_min": voiced_ratio_min,
        "median_abs_cents_max": median_abs_cents_max,
        "p95_abs_cents_max": p95_abs_cents_max,
        "failures": failures,
    }
    verified["selection"]["selected_presets"] = len(passed)
    verified["presets"] = [
        preset for preset in pilot["presets"] if int(preset["preset_index"]) in passed
    ]
    verified["clips"] = [
        clip for clip in pilot["clips"] if int(clip["preset_index"]) in passed
    ]
    verified["selection"]["clips"] = len(verified["clips"])
    return verified


def main() -> None:
    parser = argparse.ArgumentParser(description="Select a small existing Dexed pitch×timbre pilot.")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--render-manifest", type=Path, required=True)
    parser.add_argument("--count", type=int, default=24)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audit", type=Path)
    parser.add_argument("--verified-output", type=Path)
    parser.add_argument(
        "--verified-count",
        type=int,
        help="Keep this many verified presets in original farthest-point order.",
    )
    args = parser.parse_args()
    report = build_pilot_manifest(
        args.database, args.render_manifest, count=args.count
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report["selection"], indent=2, sort_keys=True))
    if args.audit:
        if not args.verified_output:
            parser.error("--verified-output is required with --audit")
        audit = json.loads(args.audit.read_text(encoding="utf-8"))
        verified = verify_pilot_manifest(
            report, audit, verified_count=args.verified_count
        )
        args.verified_output.parent.mkdir(parents=True, exist_ok=True)
        args.verified_output.write_text(
            json.dumps(verified, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        print(json.dumps(verified["selection"]["verification"], indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
