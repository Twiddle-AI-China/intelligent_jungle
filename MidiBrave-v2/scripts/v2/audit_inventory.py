#!/usr/bin/env python3
"""Dry-run the mutually exclusive quotas using label evidence only.

This intentionally ignores CLAP ordering.  It proves whether the candidate
graph and per-family caps can fill all five quotas before expensive embedding.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

from midibrave.selection import CLASSES, _tier_assignment


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", required=True)
    parser.add_argument("--quota", type=int, default=400)
    parser.add_argument("--family-cap", type=int, default=20)
    parser.add_argument("--output")
    args = parser.parse_args()
    rows = [json.loads(line) for line in Path(args.candidates).read_text(
        encoding="utf-8").splitlines() if line.strip()]
    remaining = {name: args.quota for name in CLASSES}
    assignments: list[tuple[str, str, str]] = []
    for priority in sorted({int(row["priority"]) for row in rows}):
        tier: list[dict[str, Any]] = []
        id_map: dict[str, dict[str, Any]] = {}
        for row in rows:
            if int(row["priority"]) != priority:
                continue
            item = dict(row)
            key = f"{row['dataset_id']}::{row['timbre_id']}"
            item["timbre_id"] = key
            id_map[key] = row
            tier.append(item)
        for key, class_name in _tier_assignment(tier, remaining, args.family_cap):
            remaining[class_name] -= 1
            assignments.append((id_map[key]["dataset_id"], key, class_name))
    counts = Counter(class_name for _, _, class_name in assignments)
    source_counts = Counter((dataset_id, class_name)
                            for dataset_id, _, class_name in assignments)
    report = {
        "schema": 1,
        "candidate_count": len(rows),
        "quota_per_class": args.quota,
        "family_cap_per_class": args.family_cap,
        "counts": {name: counts[name] for name in CLASSES},
        "shortfall": remaining,
        "source_counts": {
            dataset_id: {name: source_counts[(dataset_id, name)] for name in CLASSES}
            for dataset_id in sorted({row["dataset_id"] for row in rows})
        },
        "feasible": not any(remaining.values()),
    }
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    if not report["feasible"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
