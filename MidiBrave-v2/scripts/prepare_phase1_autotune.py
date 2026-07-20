#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from create_quality_subset import create_subset
from generate_phase1_autotune_config import generate_config


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", required=True)
    parser.add_argument("--campaign-root", required=True)
    parser.add_argument("--selection", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--full-manifest", required=True)
    parser.add_argument("--full-metadata", required=True)
    parser.add_argument("--preset-manifest", required=True)
    args = parser.parse_args()

    root = Path(args.campaign_root)
    root.mkdir(parents=True, exist_ok=True)
    selection = json.loads(Path(args.selection).read_text(encoding="utf-8"))
    selected = selection["selected"]
    manifest = root / "manifests" / "serum_quality50_eligible.jsonl"
    metadata = root / "manifests" / "serum_quality50_eligible.meta.json"
    subset = create_subset(
        Path(args.full_manifest), Path(args.full_metadata),
        Path(args.preset_manifest), manifest, metadata,
        presets_per_category=None, total_presets=50,
        expected_categories=6, seed=20260716,
        name=f"quality50-phase1-autotune-{args.campaign}",
    )
    configs = root / "configs"
    runs = str(root / "runs")
    baseline = generate_config(
        base=Path(args.base), manifest=manifest, metadata=metadata,
        output=configs / "q50_baseline.yaml",
        run_name=f"q50_baseline_{args.campaign}", output_dir=runs,
        batch_per_gpu=10, ddp_bucket_cap_mb=16,
        compile_decoder=False, log_every=100,
    )
    candidate = generate_config(
        base=Path(args.base), manifest=manifest, metadata=metadata,
        output=configs / "q50_candidate.yaml",
        run_name=f"q50_candidate_{args.campaign}", output_dir=runs,
        batch_per_gpu=int(selected["batch_per_gpu"]),
        ddp_bucket_cap_mb=int(selected["ddp_bucket_cap_mb"]),
        compile_decoder=bool(selected["compile_decoder"]),
        log_every=int(selected["log_every"]),
    )
    result = {
        "schema": 1,
        "campaign": args.campaign,
        "campaign_root": str(root.resolve()),
        "subset": subset,
        "performance_selection": str(Path(args.selection).resolve()),
        "baseline": baseline,
        "candidate": candidate,
    }
    output = root / "prepare.json"
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
