#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import yaml


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--run-name", required=True)
    parser.add_argument("--phase1-epochs", type=float)
    parser.add_argument("--phase2-epochs", type=float)
    args = parser.parse_args()
    if (args.phase1_epochs is None) != (args.phase2_epochs is None):
        raise ValueError("phase1-epochs and phase2-epochs must be supplied together")
    if args.phase1_epochs is not None and (
            args.phase1_epochs <= 0 or args.phase2_epochs <= 0):
        raise ValueError("epoch counts must be positive")

    raw = yaml.safe_load(Path(args.base).read_text(encoding="utf-8"))
    metadata = json.loads(Path(args.metadata).read_text(encoding="utf-8"))
    pitch_contract = metadata.get("pitch_contract", {})
    expected_window = int(raw["data"]["window_samples"])
    actual_window = int(pitch_contract.get("window_samples", -1))
    if actual_window != expected_window:
        raise ValueError(
            f"manifest pitch window {actual_window} does not match config {expected_window}"
        )
    expected_ratio = float(raw["data"]["pitch_window_valid_ratio_min"])
    actual_ratio = float(pitch_contract.get("window_valid_ratio_min", -1.0))
    if not math.isclose(actual_ratio, expected_ratio, rel_tol=0.0, abs_tol=1e-9):
        raise ValueError(
            f"manifest valid-ratio {actual_ratio} does not match config {expected_ratio}"
        )
    train_samples = int(metadata["split_samples"]["train"])
    global_pairs = (8 * int(raw["train"]["batch_per_gpu"])
                    * int(raw["train"]["grad_accum"]))
    if global_pairs != 80:
        raise ValueError(f"optimized formal training expects global pair batch 80, got {global_pairs}")
    updates_per_epoch = train_samples * int(raw["data"]["repeats"]) / global_pairs

    raw["data"]["manifest"] = str(Path(args.manifest).resolve())
    raw["data"]["manifest_metadata"] = str(Path(args.metadata).resolve())
    raw["train"]["run_name"] = args.run_name
    if args.phase1_epochs is not None:
        phase1_steps = math.ceil(updates_per_epoch * args.phase1_epochs)
        phase2_steps = math.ceil(updates_per_epoch * args.phase2_epochs)
        raw["train"].update({
            "phase1_steps": phase1_steps,
            "phase2_steps": phase2_steps,
            "pitch_adversary_start": max(1, round(phase1_steps * 0.10)),
            "pitch_adversary_ramp": max(1, round(phase1_steps * 0.02)),
            "checkpoint_every": max(1, math.ceil(updates_per_epoch)),
        })

    output = Path(args.output)
    output.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    phase1_steps = int(raw["train"]["phase1_steps"])
    phase2_steps = int(raw["train"]["phase2_steps"])
    print(json.dumps({
        "output": str(output),
        "train_samples": train_samples,
        "global_pairs": global_pairs,
        "updates_per_epoch": updates_per_epoch,
        "phase1_steps": phase1_steps,
        "phase2_steps": phase2_steps,
        "phase1_epochs": phase1_steps / updates_per_epoch,
        "phase2_epochs": phase2_steps / updates_per_epoch,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
