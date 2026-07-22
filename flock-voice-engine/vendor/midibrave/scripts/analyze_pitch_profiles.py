#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np

from midibrave.config import Config
from midibrave.data import SampleRecord, _supports_all_pair_modes, load_manifest
from analyze_pitch_windows import max_window_ratio


def coverage(records: list[SampleRecord], ratios: list[float], threshold: float,
             minimum_notes: int) -> dict:
    eligible = [record for record, ratio in zip(records, ratios) if ratio >= threshold]
    groups: dict[str, list[SampleRecord]] = defaultdict(list)
    for record in eligible:
        groups[record.group_id].append(record)
    retained_groups = {
        group: members for group, members in groups.items()
        if len({record.midi_note for record in members}) >= minimum_notes
        and _supports_all_pair_modes(members)
    }
    retained = [record for members in retained_groups.values() for record in members]
    return {
        "window_eligible_samples": len(eligible),
        "retained_samples_after_pair_coverage": len(retained),
        "retained_presets": len(retained_groups),
        "zero_ratio_samples": sum(ratio == 0.0 for ratio in ratios),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    config = Config.load(args.config)
    records = load_manifest(config.data.manifest)
    cache_root = Path(config.data.cache_root) / "pitch"
    window_frames = config.data.window_samples // config.data.pitch_hop_length
    edge_frames = math.ceil(
        config.data.stable_edge_seconds * config.data.sample_rate
        / config.data.pitch_hop_length)
    profiles = {
        "periodicity_0.50_cents_50": (0.50, 50.0),
        "periodicity_0.30_cents_100": (0.30, 100.0),
        "periodicity_0.20_cents_100": (0.20, 100.0),
        "periodicity_0.10_cents_100": (0.10, 100.0),
    }
    ratios: dict[str, list[float]] = {name: [] for name in profiles}
    for record in records:
        with np.load(cache_root / f"{record.sample_id}.npz", allow_pickle=False) as pitch:
            f0 = pitch["f0"].astype(np.float64)
            periodicity = pitch["periodicity"].astype(np.float64)
            frame_rms = pitch["frame_rms"].astype(np.float64)
        frame_db = 20.0 * np.log10(frame_rms + 1e-8)
        energy_threshold = max(-60.0, float(frame_db.max()) - 40.0)
        target_hz = record.a4_tuning_hz * 2.0 ** ((record.midi_note - 69.0) / 12.0)
        cents = 1200.0 * np.log2((f0 + 1e-7) / (target_hz + 1e-7))
        for name, (periodicity_min, cents_max) in profiles.items():
            valid = (np.isfinite(f0) & np.isfinite(periodicity)
                     & (periodicity >= periodicity_min)
                     & (np.abs(cents) <= cents_max)
                     & (frame_db >= energy_threshold))
            ratios[name].append(max_window_ratio(valid, window_frames, edge_frames))
    report = {
        "samples": len(records),
        "window_frames": window_frames,
        "edge_frames": edge_frames,
        "profiles": {},
    }
    for name, values in ratios.items():
        array = np.asarray(values)
        report["profiles"][name] = {
            "max_valid_ratio_quantiles": {
                str(value): float(np.quantile(array, value))
                for value in (0.0, 0.01, 0.05, 0.10, 0.25, 0.50)
            },
            "threshold_0.15": coverage(
                records, values, 0.15, config.data.minimum_distinct_notes_per_preset),
            "threshold_0.25": coverage(
                records, values, 0.25, config.data.minimum_distinct_notes_per_preset),
        }
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        Path(args.output).write_text(encoded, encoding="utf-8")
    print(encoded, end="")


if __name__ == "__main__":
    main()
