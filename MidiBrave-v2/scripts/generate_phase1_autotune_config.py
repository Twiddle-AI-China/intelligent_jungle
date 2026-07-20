#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import yaml


def generate_config(*, base: Path, manifest: Path, metadata: Path, output: Path,
                    run_name: str, output_dir: str, batch_per_gpu: int,
                    world_size: int = 8, phase1_epochs: float = 16.0,
                    ddp_bucket_cap_mb: int = 16, compile_decoder: bool = False,
                    log_every: int = 100,
                    self_full_fraction: float | None = None) -> dict[str, Any]:
    if batch_per_gpu <= 0 or world_size <= 0 or phase1_epochs <= 0:
        raise ValueError("batch, world size, and epochs must be positive")
    if ddp_bucket_cap_mb <= 0 or log_every <= 0:
        raise ValueError("DDP bucket and log cadence must be positive")
    raw = yaml.safe_load(base.read_text(encoding="utf-8"))
    meta = json.loads(metadata.read_text(encoding="utf-8"))
    pitch_contract = meta.get("pitch_contract", {})
    expected_window = int(raw["data"]["window_samples"])
    if int(pitch_contract.get("window_samples", -1)) != expected_window:
        raise ValueError("manifest pitch window does not match config")
    expected_ratio = float(raw["data"]["pitch_window_valid_ratio_min"])
    actual_ratio = float(pitch_contract.get("window_valid_ratio_min", -1.0))
    if not math.isclose(actual_ratio, expected_ratio, rel_tol=0.0, abs_tol=1e-9):
        raise ValueError("manifest pitch valid-ratio does not match config")

    train_samples = int(meta["split_samples"]["train"])
    repeats = int(raw["data"]["repeats"])
    base_global_pairs = 8 * int(raw["train"]["batch_per_gpu"]) * int(
        raw["train"]["grad_accum"])
    if base_global_pairs != 80:
        raise ValueError(
            f"C9 reference must use global pair batch 80, got {base_global_pairs}"
        )
    global_pairs = world_size * batch_per_gpu
    pair_exposures = train_samples * repeats * phase1_epochs
    phase1_steps = math.ceil(pair_exposures / global_pairs)
    updates_per_epoch = train_samples * repeats / global_pairs
    # Preserve the already validated warmup in pair-exposure units when the
    # micro-batch changes.  LR itself deliberately remains unchanged.
    warmup_steps = max(
        1, round(int(raw["train"]["warmup_steps"]) * base_global_pairs / global_pairs)
    )

    raw["data"]["manifest"] = str(manifest.resolve())
    raw["data"]["manifest_metadata"] = str(metadata.resolve())
    raw["train"].update({
        "phase1_steps": phase1_steps,
        "batch_per_gpu": batch_per_gpu,
        "grad_accum": 1,
        "warmup_steps": warmup_steps,
        "pitch_adversary_start": max(1, round(phase1_steps * 0.10)),
        "pitch_adversary_ramp": max(1, round(phase1_steps * 0.02)),
        "checkpoint_every": max(1, math.ceil(updates_per_epoch)),
        "log_every": log_every,
        "output_dir": output_dir,
        "run_name": run_name,
        "ddp_bucket_cap_mb": ddp_bucket_cap_mb,
        "compile_decoder": compile_decoder,
        "compile_discriminator": False,
        "ddp_static_graph": False,
    })
    if self_full_fraction is not None:
        if not 0.0 <= self_full_fraction <= 1.0:
            raise ValueError("self_full_fraction must be in [0, 1]")
        raw["train"]["self_full_fraction"] = self_full_fraction
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    return {
        "schema": 1,
        "config": str(output.resolve()),
        "manifest": str(manifest.resolve()),
        "metadata": str(metadata.resolve()),
        "train_samples": train_samples,
        "repeats": repeats,
        "phase1_epochs": phase1_epochs,
        "pair_exposures": pair_exposures,
        "world_size": world_size,
        "batch_per_gpu": batch_per_gpu,
        "global_pairs": global_pairs,
        "phase1_steps": phase1_steps,
        "updates_per_epoch": updates_per_epoch,
        "checkpoint_every": raw["train"]["checkpoint_every"],
        "warmup_steps": warmup_steps,
        "lr": float(raw["train"]["lr"]),
        "ddp_bucket_cap_mb": ddp_bucket_cap_mb,
        "compile_decoder": compile_decoder,
        "log_every": log_every,
        "self_full_fraction": float(raw["train"]["self_full_fraction"]),
        "run_name": run_name,
        "output_dir": output_dir,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--run-name", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--batch-per-gpu", type=int, required=True)
    parser.add_argument("--world-size", type=int, default=8)
    parser.add_argument("--phase1-epochs", type=float, default=16.0)
    parser.add_argument("--ddp-bucket-cap-mb", type=int, default=16)
    parser.add_argument("--compile-decoder", action="store_true")
    parser.add_argument("--log-every", type=int, default=100)
    parser.add_argument("--self-full-fraction", type=float)
    args = parser.parse_args()
    result = generate_config(
        base=Path(args.base), manifest=Path(args.manifest),
        metadata=Path(args.metadata), output=Path(args.output),
        run_name=args.run_name, output_dir=args.output_dir,
        batch_per_gpu=args.batch_per_gpu, world_size=args.world_size,
        phase1_epochs=args.phase1_epochs,
        ddp_bucket_cap_mb=args.ddp_bucket_cap_mb,
        compile_decoder=args.compile_decoder, log_every=args.log_every,
        self_full_fraction=args.self_full_fraction,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
