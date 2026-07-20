#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


CLASSES = ("pad", "lead", "base", "pluck", "texture")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _timbre_id(row: dict[str, Any]) -> str:
    value = row.get("timbre_id") or row.get("preset_id")
    if not value:
        raise ValueError("manifest row is missing timbre_id/preset_id")
    return str(value)


def _rank_serum_timbres(rows: list[dict[str, Any]]) -> list[str]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get("dataset_id") == "serum":
            grouped[_timbre_id(row)].append(row)
    scores = {
        timbre: max(float(row.get("selection_score", 0.0)) for row in values)
        for timbre, values in grouped.items()
    }
    return sorted(grouped, key=lambda timbre: (-scores[timbre], timbre))


def _split_map(class_name: str, timbres: list[str], seed: int) -> dict[str, str]:
    if len(timbres) != 50:
        raise ValueError("the formal split requires exactly 50 timbres")
    shuffled = sorted(
        timbres,
        key=lambda value: hashlib.sha256(
            f"{seed}:{class_name}:{value}".encode("utf-8")).digest(),
    )
    validation = set(shuffled[:2])
    test = set(shuffled[2:5])
    return {
        timbre: ("validation" if timbre in validation else
                 "test" if timbre in test else "train")
        for timbre in timbres
    }


def materialize(source: Path, destination: Path, class_name: str,
                count: int, seed: int, formal: bool) -> dict[str, Any]:
    rows = _read_jsonl(source)
    ranked = _rank_serum_timbres(rows)
    if len(ranked) < count:
        raise ValueError(
            f"{class_name}: only {len(ranked)} eligible Serum timbres; need {count}")
    selected = ranked[:count]
    selected_set = set(selected)
    splits = _split_map(class_name, selected, seed) if formal else {
        timbre: "train" for timbre in selected
    }
    output = []
    notes: dict[str, set[int]] = defaultdict(set)
    velocities: dict[str, set[int]] = defaultdict(set)
    for row in rows:
        timbre = _timbre_id(row)
        if timbre not in selected_set:
            continue
        value = dict(row)
        value["class_name"] = class_name
        value["split"] = splits[timbre]
        output.append(value)
        notes[timbre].add(int(value["midi_note"]))
        velocities[timbre].add(int(value["velocity"]))
    missing_notes = sorted(timbre for timbre in selected if len(notes[timbre]) < 4)
    if missing_notes:
        raise ValueError(f"{class_name}: timbres with fewer than four MIDI notes: {missing_notes}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in output),
        encoding="utf-8",
    )
    split_timbres = {
        name: sum(splits[timbre] == name for timbre in selected)
        for name in ("train", "validation", "test")
    }
    split_samples = {
        name: sum(row["split"] == name for row in output)
        for name in ("train", "validation", "test")
    }
    metadata = {
        "schema": 1,
        "class_name": class_name,
        "selection": "Serum-only by descending frozen Top400 selection_score",
        "formal_top50": formal,
        "selected_timbres": len(selected),
        "selected_samples": len(output),
        "split_timbres": split_timbres,
        "split_samples": split_samples,
        "minimum_notes_per_timbre": min(len(notes[timbre]) for timbre in selected),
        "velocity_sets": sorted({tuple(sorted(velocities[timbre])) for timbre in selected}),
        "source_manifest": str(source),
        "source_manifest_sha256": _sha256(source),
        "output_manifest_sha256": _sha256(destination),
        "seed": seed,
        "ranked_timbres": selected,
    }
    metadata_path = destination.with_suffix(".meta.json")
    metadata_path.write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--count", type=int, default=50)
    parser.add_argument("--seed", type=int, default=20260720)
    parser.add_argument("--formal", action="store_true")
    parser.add_argument("--class-name", choices=CLASSES)
    args = parser.parse_args()
    classes = (args.class_name,) if args.class_name else CLASSES
    report = {}
    for class_name in classes:
        report[class_name] = materialize(
            Path(args.source_dir) / f"{class_name}.jsonl",
            Path(args.output_dir) / f"{class_name}.jsonl",
            class_name, args.count, args.seed, args.formal,
        )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
