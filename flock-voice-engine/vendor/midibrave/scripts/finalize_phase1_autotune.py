#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from generate_phase1_autotune_config import generate_config


def _load(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", required=True)
    parser.add_argument("--selection", required=True)
    parser.add_argument("--baseline-gate", required=True)
    parser.add_argument("--candidate-gate", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--full-manifest", required=True)
    parser.add_argument("--full-metadata", required=True)
    parser.add_argument("--output-config", required=True)
    parser.add_argument("--output-decision", required=True)
    args = parser.parse_args()

    performance = _load(args.selection)
    baseline_gate = _load(args.baseline_gate)
    candidate_gate = _load(args.candidate_gate)
    if not bool(baseline_gate.get("pass")):
        raise SystemExit("q50 b10 baseline failed; refusing to start full Phase 1")
    performance_candidate = performance["selection_kind"] == "performance_candidate"
    if performance_candidate and bool(candidate_gate.get("pass")):
        chosen = performance["selected"]
        quality_choice = "performance_candidate"
        reason = "performance candidate passed q50 absolute and baseline-relative gates"
    else:
        chosen = performance["baseline"]
        quality_choice = "baseline_fallback"
        reason = (
            "performance candidate did not clear both the 3% performance threshold "
            "and q50 quality gate; using validated b10 fallback"
        )

    output_config = Path(args.output_config)
    config = generate_config(
        base=Path(args.base), manifest=Path(args.full_manifest),
        metadata=Path(args.full_metadata), output=output_config,
        run_name=f"midibrave_c9_full_p1_{args.campaign}",
        output_dir="/data/midibrave/runs",
        batch_per_gpu=int(chosen["batch_per_gpu"]),
        ddp_bucket_cap_mb=int(chosen["ddp_bucket_cap_mb"]),
        compile_decoder=bool(chosen["compile_decoder"]),
        log_every=int(chosen["log_every"]),
    )
    decision = {
        "schema": 1,
        "campaign": args.campaign,
        "quality_choice": quality_choice,
        "reason": reason,
        "selected_runtime": chosen,
        "full_config": config,
        "full_config_sha256": _sha256(output_config),
        "manifest_sha256": _sha256(Path(args.full_manifest)),
        "metadata_sha256": _sha256(Path(args.full_metadata)),
        "phase2_submitted": False,
    }
    output_decision = Path(args.output_decision)
    output_decision.parent.mkdir(parents=True, exist_ok=True)
    output_decision.write_text(
        json.dumps(decision, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(decision, sort_keys=True))


if __name__ == "__main__":
    main()
