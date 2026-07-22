#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import torch
from torch import Tensor

from midibrave.config import Config
from midibrave.data import PairDataset
from midibrave.losses import (BraveMultiScaleDiscriminator, ReconstructionLoss,
                              discriminator_hinge, feature_matching,
                              generator_adversarial)
from midibrave.model import MidiBrave


def gradient_report(value: Tensor, parameters: list[Tensor], retain_graph: bool) -> dict[str, float | int]:
    gradients = torch.autograd.grad(
        value, parameters, retain_graph=retain_graph, allow_unused=True)
    finite = True
    squared_norm = 0.0
    maximum = 0.0
    tensors = 0
    elements = 0
    for gradient in gradients:
        if gradient is None:
            continue
        tensors += 1
        elements += gradient.numel()
        finite = finite and bool(torch.isfinite(gradient).all().item())
        squared_norm += float(gradient.float().square().sum().item())
        maximum = max(maximum, float(gradient.float().abs().max().item()))
    return {
        "finite": int(finite),
        "l2_norm": math.sqrt(squared_norm),
        "max_abs": maximum,
        "gradient_tensors": tensors,
        "gradient_elements": elements,
        "value": float(value.detach().float().item()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="configs/pipeline.yaml")
    parser.add_argument("--output")
    args = parser.parse_args()
    config = Config.load(args.config)
    torch.manual_seed(config.seed)
    torch.cuda.manual_seed_all(config.seed)
    device = torch.device("cuda")
    dataset = PairDataset(config.data, config.seed)
    raw = None
    selected_index = None
    for index in range(2, len(dataset), len(PairDataset.PAIR_SEQUENCE)):
        candidate = dataset[index]
        target_delta = (candidate["velocity_reference_rms_db_b"]
                        - candidate["velocity_reference_rms_db_a"])
        active = (candidate["note_a"].eq(candidate["note_b"])
                  & candidate["velocity_a"].ne(candidate["velocity_b"])
                  & target_delta.abs().ge(config.loss.velocity_margin_db))
        if bool(active.item()):
            raw = candidate
            selected_index = index
            break
    if raw is None:
        raise RuntimeError("no active complete-render velocity pair found for gradient audit")
    batch = {name: (value.unsqueeze(0).to(device) if isinstance(value, Tensor) else [value])
             for name, value in raw.items()}
    model = MidiBrave(config.model, config.data.window_samples, config.data.sample_rate).to(device)
    reconstruction = ReconstructionLoss(
        config.loss, config.data.sample_rate, config.model.pitch_backend,
        config.data.pitch_hop_length, config.model.pqmf_bands, config.model.pqmf_taps,
    ).to(device)
    with torch.autocast("cuda", dtype=torch.float16):
        output = model(
            batch["clap_a"], batch["note_a"], batch["velocity_a"],
            batch["note_b"], batch["velocity_b"], batch["clap_b"], grl_scale=1.0)
        losses = reconstruction(output, batch, output.target_timbre, True)
    parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
    weights = {
        "self_stft": config.loss.self_stft,
        "self_envelope": config.loss.self_envelope,
        "self_pitch": config.loss.self_pitch,
        "self_rms": config.loss.self_rms,
        "cross_stft": config.loss.cross_stft,
        "cross_envelope": config.loss.cross_envelope,
        "cross_pitch": config.loss.cross_pitch,
        "cross_rms": config.loss.cross_rms,
        "velocity_rank": config.loss.velocity_rank,
        "velocity_delta": config.loss.velocity_delta,
        "timbre_pair": config.loss.timbre_pair,
        "distribution": config.loss.distribution,
        "pitch_adversary": config.loss.pitch_adversary,
    }
    pitch_component_weights = {
        "cents": 1.0,
        "distribution": config.loss.pitch_kl,
        "activation": config.loss.pitch_activation,
        "hard_negative": config.loss.pitch_hard_negative,
        "autocorrelation": config.loss.pitch_autocorrelation,
    }
    for branch in ("self", "cross"):
        branch_weight = getattr(config.loss, f"{branch}_pitch")
        for component, internal_weight in pitch_component_weights.items():
            weights[f"{branch}_pitch_{component}"] = branch_weight * internal_weight
    report = {}
    for name, value in losses.values.items():
        weight = weights.get(name, 1.0)
        report[name] = gradient_report(value * weight, parameters, True)
        report[name]["weight"] = weight
    report["reconstruction_total"] = gradient_report(losses.total, parameters, True)
    if config.loss.velocity_delta > 0 and report["velocity_delta"]["l2_norm"] <= 0:
        raise RuntimeError("velocity delta gradient is zero on an active reference pair")
    condition_gain_report = None
    if model.condition_gain is not None:
        condition_gain_parameters = [
            parameter for parameter in model.condition_gain.parameters()
            if parameter.requires_grad
        ]
        condition_gain_report = {}
        for name in ("velocity_rank", "velocity_delta"):
            value = losses.values[name] * weights[name]
            condition_gain_report[name] = gradient_report(
                value, condition_gain_parameters, True)
            if condition_gain_report[name]["l2_norm"] <= 0:
                raise RuntimeError(f"{name} gradient does not reach conditional output gain")

    discriminator = BraveMultiScaleDiscriminator().to(device)
    discriminator.requires_grad_(False)
    with torch.autocast("cuda", dtype=torch.float16):
        with torch.no_grad():
            real = discriminator(torch.cat((batch["audio_a"], batch["audio_b"]), dim=0))
        fake = discriminator(torch.cat((output.self_audio, output.cross_audio), dim=0))
        adversarial = generator_adversarial(fake) * config.loss.adversarial
        matching = feature_matching(real, fake) * config.loss.feature_matching
    report["generator_adversarial"] = gradient_report(adversarial, parameters, True)
    report["feature_matching"] = gradient_report(matching, parameters, False)

    discriminator.requires_grad_(True)
    with torch.autocast("cuda", dtype=torch.float16):
        real = discriminator(torch.cat((batch["audio_a"], batch["audio_b"]), dim=0))
        fake = discriminator(torch.cat((output.self_audio.detach(), output.cross_audio.detach()), dim=0))
        discriminator_loss = discriminator_hinge(real, fake)
    discriminator_parameters = [parameter for parameter in discriminator.parameters()
                                if parameter.requires_grad]
    report["discriminator_hinge"] = gradient_report(
        discriminator_loss, discriminator_parameters, False)
    payload = {
        "model_parameters": sum(parameter.numel() for parameter in model.parameters()),
        "condition_gain_parameters": (
            sum(parameter.numel() for parameter in model.condition_gain.parameters())
            if model.condition_gain is not None else 0
        ),
        "selected_pair": {
            "dataset_index": selected_index,
            "sample_id_a": raw["sample_id_a"],
            "sample_id_b": raw["sample_id_b"],
            "target_delta_db": float((raw["velocity_reference_rms_db_b"]
                                      - raw["velocity_reference_rms_db_a"]).item()),
        },
        "loss_gradient_audit": report,
        "condition_gain_gradient_audit": condition_gain_report,
    }
    encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(encoded, encoding="utf-8")
    print(json.dumps(payload, sort_keys=True))


if __name__ == "__main__":
    main()
