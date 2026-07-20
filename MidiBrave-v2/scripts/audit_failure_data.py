#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import torch

from midibrave.config import Config
from midibrave.data import PairDataset, load_audio


def tensor_stats(value: torch.Tensor) -> dict[str, float | int | bool]:
    floating = value.detach().float()
    return {
        "finite": bool(torch.isfinite(floating).all().item()),
        "minimum": float(floating.min().item()),
        "maximum": float(floating.max().item()),
        "maximum_absolute": float(floating.abs().max().item()),
        "rms": float(floating.square().mean().sqrt().item()),
        "elements": floating.numel(),
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def record_audit(dataset: PairDataset, sample_id: str,
                 records_by_id: dict[str, Any]) -> dict[str, Any]:
    record = records_by_id[sample_id]
    audio_path = (dataset.root / record.audio_path).resolve()
    pitch_path = dataset.cache_root / "pitch" / f"{sample_id}.npz"
    clap_path = dataset.cache_root / "clap" / f"{sample_id}.npy"
    info = sf.info(audio_path)
    audio = load_audio(audio_path, dataset.cfg.sample_rate)
    with np.load(pitch_path, allow_pickle=False) as values:
        pitch = {name: values[name] for name in values.files}
        pitch_finite = {
            name: bool(np.isfinite(value).all())
            for name, value in pitch.items()
            if np.issubdtype(value.dtype, np.number)
        }
        pitch_shapes = {name: list(value.shape) for name, value in pitch.items()}
        stable_intervals = int(len(pitch.get("stable_intervals", [])))
        valid_ratio = float(np.asarray(pitch["valid"], dtype=np.float64).mean())
    clap = np.load(clap_path, allow_pickle=False).astype(np.float32)
    return {
        "sample_id": sample_id,
        "preset_id": record.preset_id,
        "group_id": record.group_id,
        "audio_path": str(audio_path),
        "audio_sha256": sha256(audio_path),
        "audio_format": {
            "sample_rate": info.samplerate,
            "channels": info.channels,
            "frames": info.frames,
            "subtype": info.subtype,
        },
        "audio": {
            "finite": bool(np.isfinite(audio).all()),
            "minimum": float(audio.min()),
            "maximum": float(audio.max()),
            "maximum_absolute": float(np.max(np.abs(audio))),
            "rms": float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))),
            "clipped_samples": int(np.count_nonzero(np.abs(audio) >= 0.99999)),
        },
        "pitch_cache": {
            "exists": pitch_path.is_file(),
            "finite_by_array": pitch_finite,
            "shapes": pitch_shapes,
            "stable_intervals": stable_intervals,
            "valid_ratio": valid_ratio,
        },
        "clap_cache": {
            "exists": clap_path.is_file(),
            "finite": bool(np.isfinite(clap).all()),
            "shape": list(clap.shape),
            "norm": float(np.linalg.norm(clap.astype(np.float64))),
            "maximum_absolute": float(np.max(np.abs(clap))),
        },
        "midi_note": record.midi_note,
        "midi_note_sent": record.midi_note_sent,
        "velocity": record.velocity,
        "transpose_semitones": record.transpose_semitones,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--checkpoint-loop", type=int, default=75400)
    parser.add_argument("--checkpoint-offset", type=int, default=40)
    parser.add_argument("--checkpoint-epoch", type=int, default=5)
    parser.add_argument("--world-size", type=int, default=8)
    parser.add_argument("--failure-loops", type=int, nargs="+", default=(85127, 85128, 85132))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    config = Config.load(args.config)
    dataset = PairDataset(config.data, config.seed)
    # Persistent workers are created after the resume epoch is restored and do
    # not observe later set_epoch calls. The failure occurs before the resumed
    # loader reaches its end, so checkpoint_epoch is the worker-visible epoch.
    dataset.set_epoch(args.checkpoint_epoch)
    length = len(dataset)
    generator = torch.Generator().manual_seed(config.seed + args.checkpoint_epoch)
    permutation = torch.randperm(length, generator=generator).tolist()
    remainder = len(permutation) % args.world_size
    if remainder:
        permutation = permutation[:-remainder]
    samples_per_rank = len(permutation) // args.world_size
    batches_per_rank = samples_per_rank // config.train.batch_per_gpu
    records_by_id = {record.sample_id: record for record in dataset.records}

    batch_reports: list[dict[str, Any]] = []
    unique_ids: set[str] = set()
    for loop in args.failure_loops:
        consumed_since_resume = loop - args.checkpoint_loop
        if consumed_since_resume <= 0:
            raise ValueError("failure loop must be after the checkpoint loop")
        batch_offset = args.checkpoint_offset + consumed_since_resume - 1
        if batch_offset >= batches_per_rank:
            raise ValueError("requested loop crosses the resumed data epoch")
        for rank in range(args.world_size):
            rank_indices = permutation[rank::args.world_size]
            first = batch_offset * config.train.batch_per_gpu
            indices = rank_indices[first:first + config.train.batch_per_gpu]
            items = []
            for dataset_index in indices:
                item = dataset[dataset_index]
                unique_ids.update((item["sample_id_a"], item["sample_id_b"]))
                items.append({
                    "dataset_index": dataset_index,
                    "sample_id_a": item["sample_id_a"],
                    "sample_id_b": item["sample_id_b"],
                    "preset_id": item["preset_id"],
                    "pair_mode": item["pair_mode"],
                    "note_a": int(item["note_a"].item()),
                    "note_b": int(item["note_b"].item()),
                    "velocity_a": float(item["velocity_a"].item()),
                    "velocity_b": float(item["velocity_b"].item()),
                    "crop_offset_a": int(item["crop_offset_a"].item()),
                    "crop_offset_b": int(item["crop_offset_b"].item()),
                    "audio_a": tensor_stats(item["audio_a"]),
                    "audio_b": tensor_stats(item["audio_b"]),
                    "clap_a": tensor_stats(item["clap_a"]),
                    "clap_b": tensor_stats(item["clap_b"]),
                    "pitch_f0_a": tensor_stats(item["pitch_f0_a"]),
                    "pitch_f0_b": tensor_stats(item["pitch_f0_b"]),
                    "pitch_confidence_a": tensor_stats(item["pitch_confidence_a"]),
                    "pitch_confidence_b": tensor_stats(item["pitch_confidence_b"]),
                    "pitch_valid_ratio_a": float(item["pitch_valid_mask_a"].float().mean().item()),
                    "pitch_valid_ratio_b": float(item["pitch_valid_mask_b"].float().mean().item()),
                    "velocity_reference_rms_db_a": float(
                        item["velocity_reference_rms_db_a"].item()),
                    "velocity_reference_rms_db_b": float(
                        item["velocity_reference_rms_db_b"].item()),
                })
            batch_reports.append({
                "loop_step_after_batch": loop,
                "batch_offset": batch_offset,
                "rank": rank,
                "dataset_indices": indices,
                "items": items,
            })

    raw_records = [record_audit(dataset, sample_id, records_by_id)
                   for sample_id in sorted(unique_ids)]
    items = [item for batch in batch_reports for item in batch["items"]]
    tensor_keys = (
        "audio_a", "audio_b", "clap_a", "clap_b", "pitch_f0_a", "pitch_f0_b",
        "pitch_confidence_a", "pitch_confidence_b",
    )
    all_batch_tensors_finite = all(
        item[key]["finite"] for item in items for key in tensor_keys
    )
    all_raw_audio_finite = all(record["audio"]["finite"] for record in raw_records)
    all_pitch_cache_finite = all(
        all(record["pitch_cache"]["finite_by_array"].values()) for record in raw_records
    )
    all_clap_finite = all(record["clap_cache"]["finite"] for record in raw_records)
    report = {
        "schema": 1,
        "config": str(Path(args.config).resolve()),
        "reconstruction": {
            "checkpoint_loop": args.checkpoint_loop,
            "checkpoint_epoch": args.checkpoint_epoch,
            "checkpoint_offset": args.checkpoint_offset,
            "world_size": args.world_size,
            "dataset_length": length,
            "samples_per_rank": samples_per_rank,
            "batches_per_rank": batches_per_rank,
            "failure_loops": args.failure_loops,
            "worker_epoch_note": (
                "persistent workers are spawned after resume at epoch 5; the requested loops "
                "remain in the same loader epoch"
            ),
        },
        "summary": {
            "batch_rows": len(batch_reports),
            "pairs": len(items),
            "unique_sample_ids": len(unique_ids),
            "pair_modes": dict(Counter(item["pair_mode"] for item in items)),
            "notes": sorted({item["note_a"] for item in items}
                            | {item["note_b"] for item in items}),
            "velocities": sorted({item["velocity_a"] for item in items}
                                  | {item["velocity_b"] for item in items}),
            "all_batch_tensors_finite": all_batch_tensors_finite,
            "all_raw_audio_finite": all_raw_audio_finite,
            "all_pitch_cache_arrays_finite": all_pitch_cache_finite,
            "all_clap_embeddings_finite": all_clap_finite,
            "maximum_batch_audio_absolute": max(
                item[key]["maximum_absolute"] for item in items for key in ("audio_a", "audio_b")
            ),
            "maximum_raw_audio_absolute": max(
                record["audio"]["maximum_absolute"] for record in raw_records
            ),
            "raw_clipped_samples": sum(
                record["audio"]["clipped_samples"] for record in raw_records
            ),
        },
        "batches": batch_reports,
        "raw_records": raw_records,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"], sort_keys=True))
    if not all((all_batch_tensors_finite, all_raw_audio_finite,
                all_pitch_cache_finite, all_clap_finite)):
        raise SystemExit(3)


if __name__ == "__main__":
    main()
