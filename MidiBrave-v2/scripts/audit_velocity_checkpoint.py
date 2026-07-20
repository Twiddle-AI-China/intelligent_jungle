#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import Tensor
from torch.utils.data import DataLoader, Subset

from midibrave.config import Config
from midibrave.data import PairDataset
from midibrave.losses import rms_db
from midibrave.model import MidiBrave


def move_batch(batch: dict[str, Any], device: torch.device) -> dict[str, Any]:
    return {
        name: value.to(device, non_blocking=True) if isinstance(value, Tensor) else value
        for name, value in batch.items()
    }


def fraction(values: list[bool]) -> float:
    return float(np.mean(np.asarray(values, dtype=np.float64))) if values else float("nan")


@torch.no_grad()
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Audit complete-render velocity targets and checkpoint responses.")
    parser.add_argument("--config", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--pairs", type=int, default=64)
    parser.add_argument("--batch-size", type=int, default=8)
    args = parser.parse_args()
    if args.pairs <= 0 or args.batch_size <= 0:
        raise ValueError("pairs and batch-size must be positive")
    if not torch.cuda.is_available():
        raise RuntimeError("checkpoint response audit requires CUDA")

    config = Config.load(args.config)
    data_config = replace(
        config.data,
        split="validation",
        repeats=max(4, config.data.repeats),
        num_workers=2,
    )
    dataset = PairDataset(data_config, config.seed + 991)
    velocity_indices = list(range(2, len(dataset), len(PairDataset.PAIR_SEQUENCE)))
    loader = DataLoader(
        Subset(dataset, velocity_indices),
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=2,
        pin_memory=True,
        persistent_workers=True,
    )

    device = torch.device("cuda")
    model = MidiBrave(
        config.model, config.data.window_samples, config.data.sample_rate).to(device)
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    model.load_state_dict(checkpoint["model"])
    model.eval()

    rows: list[dict[str, Any]] = []
    margin = float(config.loss.velocity_margin_db)
    for raw_batch in loader:
        batch = move_batch(raw_batch, device)
        with torch.autocast("cuda", dtype=torch.float16):
            result = model(
                batch["clap_a"], batch["note_a"], batch["velocity_a"],
                batch["note_b"], batch["velocity_b"], batch["clap_b"], grl_scale=0.0)
        target_delta = (
            batch["velocity_reference_rms_db_b"]
            - batch["velocity_reference_rms_db_a"]
        )
        prediction_delta = rms_db(result.cross_audio) - rms_db(result.self_audio)
        active = (
            batch["note_a"].eq(batch["note_b"])
            & batch["velocity_a"].ne(batch["velocity_b"])
            & target_delta.abs().ge(margin)
        )
        for index in torch.nonzero(active, as_tuple=False).flatten().tolist():
            target = float(target_delta[index].item())
            prediction = float(prediction_delta[index].item())
            velocity_a = int(batch["velocity_a"][index].item())
            velocity_b = int(batch["velocity_b"][index].item())
            velocity_order = 1.0 if velocity_b > velocity_a else -1.0
            target_ordered = velocity_order * target
            prediction_ordered = velocity_order * prediction
            rows.append({
                "sample_id_a": raw_batch["sample_id_a"][index],
                "sample_id_b": raw_batch["sample_id_b"][index],
                "preset_id": raw_batch["preset_id"][index],
                "note": int(batch["note_a"][index].item()),
                "velocity_a": velocity_a,
                "velocity_b": velocity_b,
                "target_delta_db": target,
                "prediction_delta_db": prediction,
                "absolute_error_db": abs(prediction - target),
                "target_higher_velocity_delta_db": target_ordered,
                "prediction_higher_velocity_delta_db": prediction_ordered,
                "target_higher_velocity_is_louder": target_ordered > 0.0,
                "prediction_higher_velocity_is_louder": prediction_ordered > 0.0,
                "target_direction_correct": target * prediction > 0.0,
                "target_margin_correct": target * prediction >= margin * abs(target),
            })
            if len(rows) == args.pairs:
                break
        if len(rows) == args.pairs:
            break
    if len(rows) != args.pairs:
        raise RuntimeError(f"only found {len(rows)} active velocity pairs")

    targets = np.asarray([row["target_delta_db"] for row in rows], dtype=np.float64)
    predictions = np.asarray(
        [row["prediction_delta_db"] for row in rows], dtype=np.float64)
    ordered_targets = np.asarray(
        [row["target_higher_velocity_delta_db"] for row in rows], dtype=np.float64)
    ordered_predictions = np.asarray(
        [row["prediction_higher_velocity_delta_db"] for row in rows], dtype=np.float64)
    report = {
        "schema": 1,
        "config": str(Path(args.config).resolve()),
        "checkpoint": str(Path(args.checkpoint).resolve()),
        "checkpoint_generator_updates": int(checkpoint["generator_updates"]),
        "pairs": len(rows),
        "velocity_margin_db": margin,
        "target": {
            "higher_velocity_louder_rate": float(np.mean(ordered_targets > 0.0)),
            "ordered_delta_median_db": float(np.median(ordered_targets)),
            "ordered_delta_p10_db": float(np.quantile(ordered_targets, 0.1)),
            "ordered_delta_p90_db": float(np.quantile(ordered_targets, 0.9)),
            "absolute_delta_median_db": float(np.median(np.abs(targets))),
        },
        "prediction": {
            "higher_velocity_louder_rate": float(np.mean(ordered_predictions > 0.0)),
            "ordered_delta_median_db": float(np.median(ordered_predictions)),
            "ordered_delta_p10_db": float(np.quantile(ordered_predictions, 0.1)),
            "ordered_delta_p90_db": float(np.quantile(ordered_predictions, 0.9)),
            "absolute_delta_median_db": float(np.median(np.abs(predictions))),
            "target_direction_accuracy": fraction(
                [bool(row["target_direction_correct"]) for row in rows]),
            "target_margin_accuracy": fraction(
                [bool(row["target_margin_correct"]) for row in rows]),
            "target_delta_error_median_db": float(np.median(np.abs(predictions - targets))),
            "pearson_target_delta": (
                float(np.corrcoef(targets, predictions)[0, 1])
                if np.std(targets) > 0.0 and np.std(predictions) > 0.0 else None
            ),
        },
        "rows": rows,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "target": report["target"],
        "prediction": report["prediction"],
        "pairs": report["pairs"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
