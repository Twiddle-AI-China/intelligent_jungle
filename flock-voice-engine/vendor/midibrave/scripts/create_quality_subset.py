#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from midibrave.data import (SampleRecord, _supports_all_pair_modes, load_manifest,
                            sha256_file, write_manifest)


def _retained_ids_hash(records: list[SampleRecord]) -> str:
    return hashlib.sha256(
        ("\n".join(sorted(record.sample_id for record in records)) + "\n").encode()
    ).hexdigest()


def _collection_hash(cache_root: Path, records: list[SampleRecord],
                     directory: str, suffix: str) -> str:
    digest = hashlib.sha256()
    for record in sorted(records, key=lambda item: item.sample_id):
        path = cache_root / directory / f"{record.sample_id}{suffix}"
        if not path.is_file():
            raise FileNotFoundError(f"missing cache file: {path}")
        digest.update(record.sample_id.encode())
        digest.update(b"\0")
        digest.update(sha256_file(path).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def _summarize(records: list[SampleRecord]) -> tuple[dict[str, int], dict[str, int]]:
    split_samples: dict[str, int] = {}
    split_presets: dict[str, set[str]] = {}
    for record in records:
        split = record.split or "unset"
        split_samples[split] = split_samples.get(split, 0) + 1
        split_presets.setdefault(split, set()).add(record.preset_id)
    return split_samples, {key: len(value) for key, value in split_presets.items()}


def _category_targets(categories: list[str], *, presets_per_category: int | None,
                      total_presets: int | None, seed: int) -> dict[str, int]:
    if (presets_per_category is None) == (total_presets is None):
        raise ValueError(
            "exactly one of presets_per_category or total_presets must be supplied"
        )
    if presets_per_category is not None:
        if presets_per_category < 3:
            raise ValueError("presets_per_category must be at least 3 for train/validation/test")
        return {category: presets_per_category for category in categories}
    assert total_presets is not None
    minimum = 3 * len(categories)
    if total_presets < minimum:
        raise ValueError(
            f"total_presets must be at least {minimum} for train/validation/test coverage"
        )
    base, remainder = divmod(total_presets, len(categories))
    # Rotate the remainder deterministically instead of always favoring the
    # alphabetically first categories.  The allocation is part of the frozen
    # q50 data contract and therefore depends only on seed + category name.
    remainder_order = sorted(
        categories,
        key=lambda category: hashlib.sha256(
            f"{seed}:quality-total-allocation:{category}".encode()
        ).digest(),
    )
    extra = set(remainder_order[:remainder])
    return {category: base + int(category in extra) for category in categories}


def create_subset(parent_manifest: Path, parent_metadata: Path,
                  preset_manifest: Path, output_manifest: Path,
                  output_metadata: Path, *, presets_per_category: int | None,
                  expected_categories: int, seed: int, name: str,
                  total_presets: int | None = None) -> dict[str, Any]:
    parent_records = load_manifest(parent_manifest)
    parent_meta = json.loads(parent_metadata.read_text(encoding="utf-8"))
    preset_rows = [json.loads(line) for line in preset_manifest.read_text(
        encoding="utf-8").splitlines() if line.strip()]
    categories = {row["preset_id"]: row.get("category") for row in preset_rows}

    by_preset: dict[str, list[SampleRecord]] = {}
    for record in parent_records:
        by_preset.setdefault(record.preset_id, []).append(record)
    pools: dict[str, list[str]] = {}
    for preset_id, members in by_preset.items():
        category = categories.get(preset_id)
        if not category:
            raise ValueError(f"missing category for preset {preset_id}")
        if not _supports_all_pair_modes(members):
            raise ValueError(f"parent eligible preset lacks pair modes: {preset_id}")
        pools.setdefault(str(category), []).append(preset_id)
    if len(pools) != expected_categories:
        raise ValueError(f"expected {expected_categories} categories, got {len(pools)}")

    targets = _category_targets(
        sorted(pools),
        presets_per_category=(None if total_presets is not None else presets_per_category),
        total_presets=total_presets,
        seed=seed,
    )

    chosen_splits: dict[str, str] = {}
    category_selection: dict[str, dict[str, int]] = {}
    for category in sorted(pools):
        category_target = targets[category]
        validation_count = max(1, round(category_target * 0.04))
        test_count = max(1, round(category_target * 0.06))
        train_count = category_target - validation_count - test_count
        if train_count < 1:
            raise ValueError(f"selection leaves no training presets for {category}")
        ordered = sorted(
            pools[category],
            key=lambda preset_id: hashlib.sha256(
                f"{seed}:quality300:{preset_id}".encode()).digest(),
        )
        if len(ordered) < category_target:
            raise ValueError(
                f"category {category} has only {len(ordered)} eligible presets; "
                f"need {category_target}"
            )
        for index, preset_id in enumerate(ordered[:category_target]):
            if index < train_count:
                split = "train"
            elif index < train_count + validation_count:
                split = "validation"
            else:
                split = "test"
            chosen_splits[preset_id] = split
        category_selection[category] = {
            "total": category_target,
            "train": train_count,
            "validation": validation_count,
            "test": test_count,
        }

    selected = [
        SampleRecord(**{**asdict(record), "split": chosen_splits[record.preset_id]})
        for record in parent_records if record.preset_id in chosen_splits
    ]
    expected_presets = sum(targets.values())
    actual_presets = len({record.preset_id for record in selected})
    if actual_presets != expected_presets:
        raise ValueError(f"expected {expected_presets} presets, got {actual_presets}")
    for preset_id in chosen_splits:
        members = [record for record in selected if record.preset_id == preset_id]
        if not _supports_all_pair_modes(members):
            raise ValueError(f"selected preset lacks pair modes: {preset_id}")

    output_manifest.parent.mkdir(parents=True, exist_ok=True)
    temporary_manifest = output_manifest.with_suffix(output_manifest.suffix + ".tmp")
    write_manifest(temporary_manifest, selected)
    temporary_manifest.replace(output_manifest)

    cache_root = Path(parent_meta["cache_root"])
    split_samples, split_presets = _summarize(selected)
    metadata = {
        "schema": 1,
        "profile": name,
        "seed": seed,
        "parent_eligible_manifest": str(parent_manifest.resolve()),
        "parent_eligible_manifest_sha256": sha256_file(parent_manifest),
        "parent_metadata": str(parent_metadata.resolve()),
        "parent_metadata_sha256": sha256_file(parent_metadata),
        "preset_manifest": str(preset_manifest.resolve()),
        "preset_manifest_sha256": sha256_file(preset_manifest),
        "cache_root": str(cache_root.resolve()),
        "clap_contract": parent_meta["clap_contract"],
        "pitch_contract": parent_meta["pitch_contract"],
        "source_samples": len(parent_records),
        "retained_samples": len(selected),
        "retained_presets": actual_presets,
        "requested_total_presets": expected_presets,
        "split_samples": split_samples,
        "split_presets": split_presets,
        "category_selection": category_selection,
        "retained_sample_ids_sha256": _retained_ids_hash(selected),
        "eligible_manifest_sha256": sha256_file(output_manifest),
        "clap_cache_collection_sha256": _collection_hash(
            cache_root, selected, "clap", ".npy"),
        "pitch_cache_collection_sha256": _collection_hash(
            cache_root, selected, "pitch", ".npz"),
    }
    output_metadata.parent.mkdir(parents=True, exist_ok=True)
    temporary_metadata = output_metadata.with_suffix(output_metadata.suffix + ".tmp")
    temporary_metadata.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary_metadata.replace(output_metadata)
    return {"manifest": str(output_manifest), "metadata": str(output_metadata), **metadata}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--preset-manifest", required=True)
    parser.add_argument("--output-manifest", required=True)
    parser.add_argument("--output-metadata", required=True)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--presets-per-category", type=int)
    selection.add_argument("--total-presets", type=int)
    parser.add_argument("--expected-categories", type=int, default=6)
    parser.add_argument("--seed", type=int, default=20260716)
    parser.add_argument("--name", default="quality150-from-q300-eligible")
    args = parser.parse_args()
    presets_per_category = args.presets_per_category
    if presets_per_category is None and args.total_presets is None:
        presets_per_category = 25
    result = create_subset(
        Path(args.manifest), Path(args.metadata), Path(args.preset_manifest),
        Path(args.output_manifest), Path(args.output_metadata),
        presets_per_category=presets_per_category,
        expected_categories=args.expected_categories, seed=args.seed, name=args.name,
        total_presets=args.total_presets,
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
