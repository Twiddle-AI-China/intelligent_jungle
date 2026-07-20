#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Callable

import torch
from torch import Tensor

from midibrave.config import Config
from midibrave.data import PairDataset
from midibrave.losses import (DifferentiableCrepeObjective, MultiBandSTFTLoss,
                              MultiResolutionSTFTLoss, MultiScaleEnvelopeLoss,
                              ReconstructionLoss, rms_db)
from midibrave.model import MidiBrave


def finite_stats(value: Tensor) -> dict[str, float | int | bool]:
    item = value.detach().float()
    finite_mask = torch.isfinite(item)
    finite_values = item[finite_mask]
    return {
        "finite": bool(finite_mask.all().item()),
        "nonfinite": int((~finite_mask).sum().item()),
        "elements": item.numel(),
        "minimum": float(finite_values.min().item()) if finite_values.numel() else None,
        "maximum": float(finite_values.max().item()) if finite_values.numel() else None,
        "maximum_absolute": float(finite_values.abs().max().item()) if finite_values.numel() else None,
        "rms": float(finite_values.square().mean().sqrt().item()) if finite_values.numel() else None,
    }


def gradient_stats(gradients: list[Tensor | None]) -> dict[str, float | int | bool]:
    finite = True
    tensors = elements = nonfinite = 0
    squared_norm = maximum = 0.0
    for gradient in gradients:
        if gradient is None:
            continue
        item = gradient.detach().float()
        tensors += 1
        elements += item.numel()
        mask = torch.isfinite(item)
        count = int((~mask).sum().item())
        nonfinite += count
        finite = finite and count == 0
        values = item[mask]
        if values.numel():
            squared_norm += float(values.square().sum().item())
            maximum = max(maximum, float(values.abs().max().item()))
    return {
        "finite": finite,
        "tensors": tensors,
        "elements": elements,
        "nonfinite": nonfinite,
        "finite_l2_norm": math.sqrt(squared_norm),
        "finite_maximum_absolute": maximum,
    }


def batch_for_rank(config: Config, epoch: int, offset: int, rank: int,
                   world_size: int) -> tuple[dict[str, Any], list[int]]:
    dataset = PairDataset(config.data, config.seed)
    dataset.set_epoch(epoch)
    generator = torch.Generator().manual_seed(config.seed + epoch)
    permutation = torch.randperm(len(dataset), generator=generator).tolist()
    remainder = len(permutation) % world_size
    if remainder:
        permutation = permutation[:-remainder]
    rank_indices = permutation[rank::world_size]
    first = offset * config.train.batch_per_gpu
    indices = rank_indices[first:first + config.train.batch_per_gpu]
    raw = [dataset[index] for index in indices]
    batch: dict[str, Any] = {}
    for key in raw[0]:
        values = [item[key] for item in raw]
        batch[key] = torch.stack(values) if isinstance(values[0], Tensor) else values
    return batch, indices


def move(batch: dict[str, Any], device: torch.device) -> dict[str, Any]:
    return {name: value.to(device) if isinstance(value, Tensor) else value
            for name, value in batch.items()}


def audio_gradient(name: str, prediction: Tensor, target: Tensor,
                   objective: Callable[[Tensor, Tensor], Tensor]) -> dict[str, Any]:
    value_input = prediction.detach().float().requires_grad_()
    value = objective(value_input, target.detach().float())
    gradient, = torch.autograd.grad(value, value_input, allow_unused=False)
    return {
        "name": name,
        "value": float(value.detach().float().item()),
        "value_finite": bool(torch.isfinite(value).item()),
        "gradient": gradient_stats([gradient]),
    }


def pitch_gradient(objective: DifferentiableCrepeObjective, name: str, audio: Tensor,
                   target: Tensor, note: Tensor, confidence: Tensor,
                   valid: Tensor) -> dict[str, Any]:
    generated = audio.detach().float().requires_grad_()
    components = objective.forward_group_components(
        [(generated, target.detach().float(), note, confidence.float(), valid)])[0]
    gradient, = torch.autograd.grad(components["total"], generated, allow_unused=False)
    return {
        "name": name,
        "audio": finite_stats(generated),
        "components": {key: float(value.detach().float().item())
                       for key, value in components.items()},
        "components_finite": all(bool(torch.isfinite(value).item())
                                 for value in components.values()),
        "gradient": gradient_stats([gradient]),
    }


def parameter_finiteness(model: MidiBrave) -> dict[str, Any]:
    bad = []
    maximum = 0.0
    for name, parameter in model.named_parameters():
        item = parameter.detach().float()
        if not torch.isfinite(item).all():
            bad.append(name)
        else:
            maximum = max(maximum, float(item.abs().max().item()))
    return {"finite": not bad, "nonfinite_parameters": bad, "maximum_absolute": maximum}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--failure-loop", type=int, default=85128)
    parser.add_argument("--checkpoint-loop", type=int, default=75400)
    parser.add_argument("--checkpoint-offset", type=int, default=40)
    parser.add_argument("--epoch", type=int, default=5)
    parser.add_argument("--rank", type=int, default=0)
    parser.add_argument("--world-size", type=int, default=8)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("numeric audit requires CUDA")

    config = Config.load(args.config)
    consumed = args.failure_loop - args.checkpoint_loop
    batch_offset = args.checkpoint_offset + consumed - 1
    raw_batch, indices = batch_for_rank(
        config, args.epoch, batch_offset, args.rank, args.world_size)
    device = torch.device("cuda")
    batch = move(raw_batch, device)
    model = MidiBrave(config.model, config.data.window_samples,
                      config.data.sample_rate).to(device)
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    model.load_state_dict(checkpoint["model"])
    model.train()
    model.prepare_runtime_caches()

    with torch.autocast("cuda", dtype=torch.float16):
        result = model(
            batch["clap_a"], batch["note_a"], batch["velocity_a"],
            batch["note_b"], batch["velocity_b"], batch["clap_b"],
            grl_scale=1.0, include_self=True,
        )
    assert result.self_audio is not None
    model_outputs = {
        "self_audio": finite_stats(result.self_audio),
        "cross_audio": finite_stats(result.cross_audio),
    }

    stft = MultiResolutionSTFTLoss().to(device)
    multiband = MultiBandSTFTLoss(config.model.pqmf_bands,
                                  config.model.pqmf_taps).to(device)
    envelope = MultiScaleEnvelopeLoss().to(device)
    loss_side = []
    for branch, prediction, target in (
        ("self", result.self_audio, batch["audio_a"]),
        ("cross", result.cross_audio, batch["audio_b"]),
    ):
        loss_side.extend((
            audio_gradient(f"{branch}_stft_fullband", prediction, target,
                           lambda p, t: stft(p, t)),
            audio_gradient(f"{branch}_stft_multiband", prediction, target,
                           lambda p, t: multiband(p, t)),
            audio_gradient(f"{branch}_envelope", prediction, target,
                           lambda p, t: envelope(p, t)),
            audio_gradient(f"{branch}_rms", prediction, target,
                           lambda p, t: (rms_db(p) - rms_db(t)).square().mean()),
            audio_gradient(f"{branch}_stft_identity", target, target,
                           lambda p, t: stft(p, t)),
        ))

    pitch = DifferentiableCrepeObjective(
        config.data.sample_rate, config.data.pitch_hop_length,
        config.loss.pitch_temperature, config.loss.pitch_target_sigma_cents,
        config.loss.pitch_kl, config.loss.pitch_activation,
        config.loss.pitch_hard_negative, config.loss.pitch_autocorrelation,
        config.loss.pitch_negative_margin_logits,
        config.loss.pitch_negative_exclusion_cents,
        config.loss.pitch_negative_temperature,
    ).to(device)
    pitch_checks = [
        pitch_gradient(pitch, "target_a", batch["audio_a"], batch["audio_a"],
                       batch["note_a"], batch["pitch_confidence_a"],
                       batch["pitch_valid_mask_a"]),
        pitch_gradient(pitch, "target_b", batch["audio_b"], batch["audio_b"],
                       batch["note_b"], batch["pitch_confidence_b"],
                       batch["pitch_valid_mask_b"]),
        pitch_gradient(pitch, "checkpoint_self", result.self_audio, batch["audio_a"],
                       batch["note_a"], batch["pitch_confidence_a"],
                       batch["pitch_valid_mask_a"]),
        pitch_gradient(pitch, "checkpoint_cross", result.cross_audio, batch["audio_b"],
                       batch["note_b"], batch["pitch_confidence_b"],
                       batch["pitch_valid_mask_b"]),
    ]
    base = batch["audio_b"][:1]
    target = batch["audio_b"][:1]
    note = batch["note_b"][:1]
    confidence = batch["pitch_confidence_b"][:1]
    valid = batch["pitch_valid_mask_b"][:1]
    for scale in (0.0, 1e-4, 1e-2, 1.0, 4.0, 16.0, 32.0):
        pitch_checks.append(pitch_gradient(
            pitch, f"target_b_scale_{scale:g}", base * scale, target,
            note, confidence, valid,
        ))

    reconstruction = ReconstructionLoss(
        config.loss, config.data.sample_rate, config.model.pitch_backend,
        config.data.pitch_hop_length, config.model.pqmf_bands,
        config.model.pqmf_taps,
    ).to(device)
    model.zero_grad(set_to_none=True)
    with torch.autocast("cuda", dtype=torch.float16):
        replay = model(
            batch["clap_a"], batch["note_a"], batch["velocity_a"],
            batch["note_b"], batch["velocity_b"], batch["clap_b"],
            grl_scale=1.0, include_self=True,
        )
        reconstruction_result = reconstruction(
            replay, batch, replay.target_timbre, True, self_scale=2.0)
    reconstruction_result.total.backward()
    full_gradients = gradient_stats([
        parameter.grad for parameter in model.parameters() if parameter.requires_grad
    ])
    full_reconstruction = {
        "total": float(reconstruction_result.total.detach().float().item()),
        "total_finite": bool(torch.isfinite(reconstruction_result.total).item()),
        "terms": {name: float(value.detach().float().item())
                  for name, value in reconstruction_result.values.items()},
        "parameter_gradients": full_gradients,
    }

    # A simple finite waveform objective bypasses CREPE/STFT and tests whether
    # the checkpoint decoder's own mixed-precision backward is finite.
    model.zero_grad(set_to_none=True)
    with torch.autocast("cuda", dtype=torch.float16):
        proxy_result = model(
            batch["clap_a"], batch["note_a"], batch["velocity_a"],
            batch["note_b"], batch["velocity_b"], batch["clap_b"],
            grl_scale=1.0, include_self=True,
        )
        assert proxy_result.self_audio is not None
        proxy = (proxy_result.self_audio.float().square().mean()
                 + proxy_result.cross_audio.float().square().mean())
    proxy.backward()
    proxy_gradients = gradient_stats([
        parameter.grad for parameter in model.parameters() if parameter.requires_grad
    ])

    report = {
        "schema": 1,
        "config": str(Path(args.config).resolve()),
        "checkpoint": str(Path(args.checkpoint).resolve()),
        "checkpoint_generator_updates": int(checkpoint["generator_updates"]),
        "reconstructed_batch": {
            "rank": args.rank,
            "failure_loop": args.failure_loop,
            "batch_offset": batch_offset,
            "dataset_indices": indices,
            "sample_id_a": raw_batch["sample_id_a"],
            "sample_id_b": raw_batch["sample_id_b"],
            "pair_mode": raw_batch["pair_mode"],
        },
        "parameters": parameter_finiteness(model),
        "checkpoint_model_outputs": model_outputs,
        "stft_envelope_rms": loss_side,
        "crepe": pitch_checks,
        "full_reconstruction": full_reconstruction,
        "decoder_proxy_backward": {
            "value": float(proxy.detach().float().item()),
            "parameter_gradients": proxy_gradients,
        },
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    gates = {
        "parameters_finite": report["parameters"]["finite"],
        "model_outputs_finite": all(item["finite"] for item in model_outputs.values()),
        "stft_gradients_finite": all(item["gradient"]["finite"] for item in loss_side),
        "crepe_gradients_finite": all(item["gradient"]["finite"] for item in pitch_checks),
        "full_reconstruction_gradients_finite": full_gradients["finite"],
        "decoder_proxy_gradients_finite": proxy_gradients["finite"],
    }
    print(json.dumps(gates, sort_keys=True))
    if not all(gates.values()):
        raise SystemExit(3)


if __name__ == "__main__":
    main()
