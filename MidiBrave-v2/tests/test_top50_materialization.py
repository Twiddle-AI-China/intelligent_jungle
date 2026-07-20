from __future__ import annotations

import importlib.util
import json
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "v2" / "materialize_top50.py"
SPEC = importlib.util.spec_from_file_location("materialize_top50", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_materialize_top50_is_serum_only_ranked_and_exactly_split(tmp_path):
    source = tmp_path / "source.jsonl"
    rows = []
    for index in range(55):
        for note in (48, 52, 55, 60):
            rows.append({
                "dataset_id": "serum", "class_name": "lead",
                "timbre_id": f"serum-{index:03d}", "preset_id": f"serum-{index:03d}",
                "sample_id": f"serum-{index:03d}-{note}", "midi_note": note,
                "velocity": 50, "selection_score": 1.0 - index / 100.0,
                "split": "train",
            })
    for index in range(10):
        rows.append({
            "dataset_id": "dexed", "class_name": "lead", "timbre_id": f"dexed-{index}",
            "preset_id": f"dexed-{index}", "sample_id": f"dexed-{index}-60",
            "midi_note": 60, "velocity": 50, "selection_score": 2.0,
            "split": "train",
        })
    source.write_text(
        "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    destination = tmp_path / "lead.jsonl"
    metadata = MODULE.materialize(source, destination, "lead", 50, 7, True)
    output = [json.loads(line) for line in destination.read_text().splitlines()]
    assert {row["dataset_id"] for row in output} == {"serum"}
    assert len({row["timbre_id"] for row in output}) == 50
    assert metadata["split_timbres"] == {"train": 45, "validation": 2, "test": 3}
    assert "serum-049" in {row["timbre_id"] for row in output}
    assert "serum-050" not in {row["timbre_id"] for row in output}
