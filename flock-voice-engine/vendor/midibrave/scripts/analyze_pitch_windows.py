#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from dataclasses import asdict
from pathlib import Path

import numpy as np

from midibrave.config import Config
from midibrave.data import SampleRecord, _supports_all_pair_modes, load_manifest


def max_window_ratio(valid: np.ndarray, window_frames: int, edge_frames: int) -> float:
    first = edge_frames
    last = len(valid) - window_frames - edge_frames
    if last < first:
        return 0.0
    cumulative = np.concatenate((np.zeros(1, dtype=np.int64),
                                 np.cumsum(valid.astype(np.int64))))
    starts = np.arange(first, last + 1, dtype=np.int64)
    counts = cumulative[starts + window_frames] - cumulative[starts]
    return float(counts.max() / window_frames)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--output")
    parser.add_argument("--thresholds", default="0.15,0.25,0.50,0.75,0.90,1.00")
    args = parser.parse_args()
    config = Config.load(args.config)
    records = load_manifest(config.data.manifest)
    cache_root = Path(config.data.cache_root) / "pitch"
    window_frames = config.data.window_samples // config.data.pitch_hop_length
    edge_frames = math.ceil(
        config.data.stable_edge_seconds * config.data.sample_rate
        / config.data.pitch_hop_length)
    ratios = []
    stable = []
    by_threshold: dict[float, list[SampleRecord]] = {}
    thresholds = [float(value) for value in args.thresholds.split(",")]
    for threshold in thresholds:
        by_threshold[threshold] = []
    for record in records:
        with np.load(cache_root / f"{record.sample_id}.npz", allow_pickle=False) as pitch:
            valid = pitch["valid"].astype(np.bool_)
            ratio = max_window_ratio(valid, window_frames, edge_frames)
            ratios.append(ratio)
            stable.append(bool(len(pitch["stable_intervals"])))
        for threshold in thresholds:
            if ratio >= threshold:
                by_threshold[threshold].append(record)

    threshold_reports = {}
    for threshold, eligible in by_threshold.items():
        groups: dict[str, list[SampleRecord]] = defaultdict(list)
        for record in eligible:
            groups[record.group_id].append(record)
        retained_groups = {
            group: members for group, members in groups.items()
            if len({record.midi_note for record in members})
            >= config.data.minimum_distinct_notes_per_preset
            and _supports_all_pair_modes(members)
        }
        retained = [record for members in retained_groups.values() for record in members]
        split_samples: dict[str, int] = defaultdict(int)
        split_presets: dict[str, set[str]] = defaultdict(set)
        for record in retained:
            split = record.split or "unset"
            split_samples[split] += 1
            split_presets[split].add(record.preset_id)
        threshold_reports[str(threshold)] = {
            "window_eligible_samples": len(eligible),
            "retained_samples_after_pair_coverage": len(retained),
            "retained_presets": len(retained_groups),
            "split_samples": dict(split_samples),
            "split_presets": {key: len(value) for key, value in split_presets.items()},
        }
    array = np.asarray(ratios, dtype=np.float64)
    report = {
        "manifest": config.data.manifest,
        "samples": len(records),
        "window_frames": window_frames,
        "edge_frames": edge_frames,
        "strict_contiguous_stable_samples": sum(stable),
        "max_valid_ratio_quantiles": {
            str(quantile): float(np.quantile(array, quantile))
            for quantile in (0.0, 0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99, 1.0)
        },
        "thresholds": threshold_reports,
    }
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        Path(args.output).write_text(encoded, encoding="utf-8")
    print(encoded, end="")


if __name__ == "__main__":
    main()
