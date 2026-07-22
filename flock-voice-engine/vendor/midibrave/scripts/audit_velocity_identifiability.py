#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import replace
from pathlib import Path

import numpy as np

from midibrave.config import Config
from midibrave.data import (PairDataset, _eligible_pitch_offset_frames,
                            _pitch_valid_mask, load_audio)


def rms_db_for_eligible_windows(
        dataset: PairDataset, sample_id: str) -> tuple[np.ndarray, np.ndarray]:
    record = next(item for item in dataset.records if item.sample_id == sample_id)
    pitch_path = dataset.cache_root / "pitch" / f"{sample_id}.npz"
    with np.load(pitch_path, allow_pickle=False) as cached:
        pitch = {name: cached[name].copy() for name in cached.files}
    if int(pitch["hop_length"]) != dataset.cfg.pitch_hop_length:
        raise ValueError(f"pitch hop mismatch: {sample_id}")
    valid = _pitch_valid_mask(
        pitch["f0"], pitch["periodicity"], pitch["frame_rms"], record, dataset.cfg)
    offset_frames = _eligible_pitch_offset_frames(valid, dataset.cfg)
    if not len(offset_frames):
        raise RuntimeError(f"no eligible pitch-supported window: {sample_id}")

    audio = load_audio((dataset.root / record.audio_path).resolve(), dataset.cfg.sample_rate)
    squared = audio.astype(np.float64) ** 2
    prefix = np.concatenate((np.zeros(1, dtype=np.float64), np.cumsum(squared)))
    starts = offset_frames.astype(np.int64) * dataset.cfg.pitch_hop_length
    stops = starts + dataset.cfg.window_samples
    means = (prefix[stops] - prefix[starts]) / dataset.cfg.window_samples
    rms = np.sqrt(means + 1e-8)
    return offset_frames.astype(np.int64), 20.0 * np.log10(rms + 1e-7)


def stable_rng(*values: str | int) -> np.random.Generator:
    payload = ":".join(str(value) for value in values).encode()
    seed = int.from_bytes(hashlib.sha256(payload).digest()[:8], "little")
    return np.random.default_rng(seed)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Estimate the crop-blind upper bound of the velocity gate.")
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--pairs", type=int, default=64)
    parser.add_argument("--draws-per-pair", type=int, default=4096)
    args = parser.parse_args()
    if args.pairs <= 0 or args.draws_per_pair <= 0:
        raise ValueError("pairs and draws-per-pair must be positive")

    config = Config.load(args.config)
    data_config = replace(
        config.data, split="validation", repeats=max(4, config.data.repeats), num_workers=0)
    dataset = PairDataset(data_config, config.seed + 991)
    margin = float(config.loss.velocity_margin_db)

    selected: list[dict[str, object]] = []
    for index in range(2, len(dataset), len(PairDataset.PAIR_SEQUENCE)):
        item = dataset[index]
        audio_a = item["audio_a"].numpy().astype(np.float64)
        audio_b = item["audio_b"].numpy().astype(np.float64)
        rms_a = 20.0 * np.log10(np.sqrt(np.mean(audio_a ** 2) + 1e-8) + 1e-7)
        rms_b = 20.0 * np.log10(np.sqrt(np.mean(audio_b ** 2) + 1e-8) + 1e-7)
        delta = float(rms_b - rms_a)
        if abs(delta) < margin:
            continue
        selected.append({
            "sample_id_a": item["sample_id_a"],
            "sample_id_b": item["sample_id_b"],
            "preset_id": item["preset_id"],
            "note": int(item["note_a"].item()),
            "velocity_a": int(item["velocity_a"].item()),
            "velocity_b": int(item["velocity_b"].item()),
            "observed_delta_db": delta,
        })
        if len(selected) == args.pairs:
            break
    if len(selected) != args.pairs:
        raise RuntimeError(f"only found {len(selected)} active velocity pairs")

    rms_cache: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    direction_hits: list[np.ndarray] = []
    margin_hits: list[np.ndarray] = []
    delta_errors: list[np.ndarray] = []
    aligned_direction_hits: list[np.ndarray] = []
    aligned_margin_hits: list[np.ndarray] = []
    aligned_delta_errors: list[np.ndarray] = []
    pair_rows: list[dict[str, object]] = []
    for occurrence, pair in enumerate(selected):
        sample_a = str(pair["sample_id_a"])
        sample_b = str(pair["sample_id_b"])
        if sample_a not in rms_cache:
            rms_cache[sample_a] = rms_db_for_eligible_windows(dataset, sample_a)
        if sample_b not in rms_cache:
            rms_cache[sample_b] = rms_db_for_eligible_windows(dataset, sample_b)
        offsets_a, values_a = rms_cache[sample_a]
        offsets_b, values_b = rms_cache[sample_b]
        rng = stable_rng(config.seed, occurrence, sample_a, sample_b)
        deltas = (values_b[rng.integers(0, len(values_b), args.draws_per_pair)]
                  - values_a[rng.integers(0, len(values_a), args.draws_per_pair)])
        active = np.abs(deltas) >= margin
        active_deltas = deltas[active]
        if not len(active_deltas):
            continue

        # The model does not receive crop offsets.  The strongest possible
        # fixed per-condition amplitude prediction is therefore the median
        # target delta for that exact pair of rendered conditions.
        oracle_delta = float(np.median(active_deltas))
        direction = np.sign(active_deltas)
        directed = direction * oracle_delta
        current_direction = directed > 0.0
        current_margin = directed >= margin
        current_errors = np.abs(active_deltas - oracle_delta)
        direction_hits.append(current_direction)
        margin_hits.append(current_margin)
        delta_errors.append(current_errors)
        positive = float(np.mean(active_deltas > 0.0))
        consistency = max(positive, 1.0 - positive)
        pair_rows.append({
            **pair,
            "eligible_offsets_a": int(len(values_a)),
            "eligible_offsets_b": int(len(values_b)),
            "active_draws": int(len(active_deltas)),
            "positive_target_rate": positive,
            "direction_consistency": consistency,
            "oracle_fixed_delta_db": oracle_delta,
            "oracle_direction_accuracy": float(np.mean(current_direction)),
            "oracle_margin_accuracy": float(np.mean(current_margin)),
            "oracle_delta_error_median_db": float(np.median(current_errors)),
        })

        common, index_a, index_b = np.intersect1d(
            offsets_a, offsets_b, assume_unique=True, return_indices=True)
        aligned_deltas = values_b[index_b] - values_a[index_a]
        aligned_active = np.abs(aligned_deltas) >= margin
        aligned_active_deltas = aligned_deltas[aligned_active]
        if len(aligned_active_deltas):
            aligned_oracle_delta = float(np.median(aligned_active_deltas))
            aligned_direction = np.sign(aligned_active_deltas)
            aligned_directed = aligned_direction * aligned_oracle_delta
            aligned_current_direction = aligned_directed > 0.0
            aligned_current_margin = aligned_directed >= margin
            aligned_current_errors = np.abs(
                aligned_active_deltas - aligned_oracle_delta)
            aligned_direction_hits.append(aligned_current_direction)
            aligned_margin_hits.append(aligned_current_margin)
            aligned_delta_errors.append(aligned_current_errors)
            pair_rows[-1].update({
                "aligned_common_offsets": int(len(common)),
                "aligned_active_offsets": int(len(aligned_active_deltas)),
                "aligned_oracle_fixed_delta_db": aligned_oracle_delta,
                "aligned_oracle_direction_accuracy": float(
                    np.mean(aligned_current_direction)),
                "aligned_oracle_margin_accuracy": float(np.mean(aligned_current_margin)),
                "aligned_oracle_delta_error_median_db": float(
                    np.median(aligned_current_errors)),
            })

    all_direction = np.concatenate(direction_hits)
    all_margin = np.concatenate(margin_hits)
    all_errors = np.concatenate(delta_errors)
    consistencies = np.asarray(
        [float(row["direction_consistency"]) for row in pair_rows], dtype=np.float64)
    observed = np.asarray(
        [float(row["observed_delta_db"]) for row in selected], dtype=np.float64)
    aligned_summary: dict[str, float | int] | None = None
    if aligned_direction_hits:
        all_aligned_direction = np.concatenate(aligned_direction_hits)
        all_aligned_margin = np.concatenate(aligned_margin_hits)
        all_aligned_errors = np.concatenate(aligned_delta_errors)
        aligned_summary = {
            "pairs_analyzed": len(aligned_direction_hits),
            "direction_accuracy": float(np.mean(all_aligned_direction)),
            "margin_accuracy": float(np.mean(all_aligned_margin)),
            "delta_error_median_db": float(np.median(all_aligned_errors)),
        }
    report = {
        "schema": 1,
        "config": str(Path(args.config).resolve()),
        "pairs_requested": args.pairs,
        "pairs_analyzed": len(pair_rows),
        "draws_per_pair": args.draws_per_pair,
        "velocity_margin_db": margin,
        "gate_observed_positive_target_rate": float(np.mean(observed > 0.0)),
        "crop_blind_oracle": {
            "direction_accuracy": float(np.mean(all_direction)),
            "margin_accuracy": float(np.mean(all_margin)),
            "delta_error_median_db": float(np.median(all_errors)),
            "pair_direction_consistency_median": float(np.median(consistencies)),
            "pair_direction_consistency_p10": float(np.quantile(consistencies, 0.1)),
            "pairs_with_sign_flips_rate": float(np.mean(consistencies < 1.0)),
        },
        "aligned_crop_oracle": aligned_summary,
        "interpretation": (
            "Upper bound for any deterministic decoder that knows the exact rendered "
            "condition pair but does not receive independent crop offsets."),
        "pairs": pair_rows,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "independent_crop": report["crop_blind_oracle"],
        "aligned_crop": report["aligned_crop_oracle"],
        "pairs_analyzed": report["pairs_analyzed"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
