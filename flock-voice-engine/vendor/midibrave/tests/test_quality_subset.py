from __future__ import annotations

import json
from pathlib import Path

from midibrave.data import SampleRecord, write_manifest
from scripts.create_quality_subset import create_subset


def _records(category: str, preset_index: int) -> list[SampleRecord]:
    preset = f"{category}_preset_{preset_index:02d}"
    result = []
    for note in (60, 62):
        for velocity in (50, 127):
            sample_id = f"{preset}_n{note}_v{velocity}"
            result.append(SampleRecord(
                sample_id=sample_id,
                audio_path=f"audio/{sample_id}.wav",
                source_id="serum",
                preset_id=preset,
                articulation_id="steady",
                midi_note=note,
                midi_note_sent=note,
                transpose_semitones=0,
                velocity=velocity,
                sample_rate=44100,
                num_samples=220500,
                duration_seconds=5.0,
                a4_tuning_hz=440.0,
                render_or_recording="render",
                render_gain_db=0.0,
                split="train",
            ))
    return result


def test_quality_subset_is_balanced_nested_and_deterministic(tmp_path: Path) -> None:
    parent_records = []
    presets = []
    for category in ("bass", "lead"):
        for index in range(4):
            records = _records(category, index)
            parent_records.extend(records)
            presets.append({"preset_id": records[0].preset_id, "category": category})

    parent = tmp_path / "parent.jsonl"
    parent_meta = tmp_path / "parent.meta.json"
    preset_manifest = tmp_path / "presets.jsonl"
    cache_root = tmp_path / "cache"
    (cache_root / "clap").mkdir(parents=True)
    (cache_root / "pitch").mkdir(parents=True)
    write_manifest(parent, parent_records)
    preset_manifest.write_text(
        "".join(json.dumps(row) + "\n" for row in presets), encoding="utf-8")
    for record in parent_records:
        (cache_root / "clap" / f"{record.sample_id}.npy").write_bytes(b"clap")
        (cache_root / "pitch" / f"{record.sample_id}.npz").write_bytes(b"pitch")
    parent_meta.write_text(json.dumps({
        "cache_root": str(cache_root),
        "clap_contract": {"dimension": 512},
        "pitch_contract": {"window_samples": 49152, "window_valid_ratio_min": 0.75},
    }), encoding="utf-8")

    output = tmp_path / "quality6.jsonl"
    metadata = tmp_path / "quality6.meta.json"
    first = create_subset(
        parent, parent_meta, preset_manifest, output, metadata,
        presets_per_category=3, expected_categories=2, seed=20260716,
        name="quality6-test",
    )
    second = create_subset(
        parent, parent_meta, preset_manifest, tmp_path / "quality6-copy.jsonl",
        tmp_path / "quality6-copy.meta.json", presets_per_category=3,
        expected_categories=2, seed=20260716, name="quality6-test",
    )

    rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    chosen = {row["preset_id"] for row in rows}
    assert len(chosen) == 6
    assert chosen.issubset({row["preset_id"] for row in presets})
    split_presets = {
        split: {row["preset_id"] for row in rows if row["split"] == split}
        for split in ("train", "validation", "test")
    }
    assert {key: len(value) for key, value in split_presets.items()} == {
        "train": 2, "validation": 2, "test": 2,
    }
    assert first["retained_samples"] == 24
    assert first["retained_presets"] == 6
    assert first["eligible_manifest_sha256"] == second["eligible_manifest_sha256"]
    assert first["retained_sample_ids_sha256"] == second["retained_sample_ids_sha256"]


def test_quality_subset_supports_exact_total_across_categories(tmp_path: Path) -> None:
    parent_records = []
    presets = []
    for category in ("bass", "lead"):
        for index in range(4):
            records = _records(category, index)
            parent_records.extend(records)
            presets.append({"preset_id": records[0].preset_id, "category": category})
    parent = tmp_path / "parent.jsonl"
    parent_meta = tmp_path / "parent.meta.json"
    preset_manifest = tmp_path / "presets.jsonl"
    cache_root = tmp_path / "cache"
    (cache_root / "clap").mkdir(parents=True)
    (cache_root / "pitch").mkdir(parents=True)
    write_manifest(parent, parent_records)
    preset_manifest.write_text(
        "".join(json.dumps(row) + "\n" for row in presets), encoding="utf-8")
    for record in parent_records:
        (cache_root / "clap" / f"{record.sample_id}.npy").write_bytes(b"clap")
        (cache_root / "pitch" / f"{record.sample_id}.npz").write_bytes(b"pitch")
    parent_meta.write_text(json.dumps({
        "cache_root": str(cache_root),
        "clap_contract": {"dimension": 512},
        "pitch_contract": {"window_samples": 49152, "window_valid_ratio_min": 0.75},
    }), encoding="utf-8")

    output = tmp_path / "quality7.jsonl"
    result = create_subset(
        parent, parent_meta, preset_manifest, output, tmp_path / "quality7.meta.json",
        presets_per_category=None, total_presets=7, expected_categories=2,
        seed=20260716, name="quality7-test",
    )
    rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert result["retained_presets"] == 7
    assert result["requested_total_presets"] == 7
    assert sorted(item["total"] for item in result["category_selection"].values()) == [3, 4]
    split_presets = {
        split: {row["preset_id"] for row in rows if row["split"] == split}
        for split in ("train", "validation", "test")
    }
    assert {key: len(value) for key, value in split_presets.items()} == {
        "train": 3, "validation": 2, "test": 2,
    }
