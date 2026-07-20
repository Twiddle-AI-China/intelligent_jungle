#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

from midibrave.config import Config
from midibrave.data import PairDataset
from midibrave.losses import FrozenClapReconstructionObjective


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    config = Config.load(args.config)
    device = torch.device("cuda")
    dataset = PairDataset(config.data, config.seed)
    sample = dataset[0]
    target = sample["audio_b"].unsqueeze(0).to(device)
    valid = sample["valid_samples_b"].view(1).to(device)
    generator = torch.Generator(device=device).manual_seed(config.seed)
    wrong = torch.randn(target.shape, device=device, generator=generator) * 0.05
    objective = FrozenClapReconstructionObjective(
        config.data.clap_checkpoint, config.data.sample_rate, device,
        config.loss.clap_gradient_norm,
    )
    identical = objective.waveform_gradients(target, target, valid)
    mismatched = objective.waveform_gradients(wrong, target, valid)
    report = {
        "schema": 1,
        "config": str(Path(args.config).resolve()),
        "same_window_loss": float(identical.losses.item()),
        "wrong_window_loss": float(mismatched.losses.item()),
        "raw_waveform_gradient_norm": float(mismatched.gradient_norms.item()),
        "clipped_waveform_gradient_norm": float(
            mismatched.clipped_gradient_norms.item()),
        "gradient_finite": bool(torch.isfinite(mismatched.gradients).all().item()),
        "gradient_nonzero": bool(mismatched.gradients.abs().sum().item() > 0),
        "clap_trainable_parameters": sum(
            parameter.numel() for parameter in objective.encoder.parameters()
            if parameter.requires_grad),
        "peak_cuda_gib": torch.cuda.max_memory_allocated() / 2**30,
    }
    report["passed"] = (
        report["same_window_loss"] <= 1e-4
        and report["wrong_window_loss"] > report["same_window_loss"] + 1e-4
        and report["gradient_finite"] and report["gradient_nonzero"]
        and report["clap_trainable_parameters"] == 0
        and report["clipped_waveform_gradient_norm"]
        <= config.loss.clap_gradient_norm * 1.001
    )
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["passed"]:
        raise SystemExit("CLAP objective gate failed")


if __name__ == "__main__":
    main()
