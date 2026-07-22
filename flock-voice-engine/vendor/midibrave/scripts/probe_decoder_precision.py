#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import types
from pathlib import Path
from typing import Any

import torch
from torch import Tensor
from torch.nn import functional as F

from audit_captured_nan import (build, gradient_stats, move,
                                per_sample_audio_stats, tensor_stats)
from midibrave.config import Config
from midibrave.losses import ReconstructionLoss


def fp32_block_forward(self: torch.nn.Module, x: Tensor, z_midi: Tensor,
                       excitation: Tensor, static_midi: bool = False) -> Tensor:
    with torch.autocast(device_type=x.device.type, enabled=False):
        x = x.float()
        y = F.silu(self.conv1(x))
        y = self.film(self.conv2(y), z_midi.float(), static_condition=static_midi)
        y = self.excitation_film(y, excitation.float())
        return (x + y) * (2.0 ** -0.5)


def fp32_tail_forward(self: torch.nn.Module, x: Tensor, z_midi: Tensor,
                      excitation: Tensor, static_midi: bool = False) -> Tensor:
    # Keep the 3-tap convolution on Tensor Cores, then protect the 1x1
    # convolution, both FiLM applications, and residual addition in FP32.
    y = F.silu(self.conv1(x))
    with torch.autocast(device_type=x.device.type, enabled=False):
        x = x.float()
        y = self.conv2(y.float())
        y = self.film(y, z_midi.float(), static_condition=static_midi)
        y = self.excitation_film(y, excitation.float())
        return (x + y) * (2.0 ** -0.5)


def configure_variant(model: torch.nn.Module, variant: str) -> None:
    if variant == "baseline" or variant == "full_fp32":
        return
    if variant == "fp32_tail_block02":
        blocks = [model.decoder.blocks[0][2]]
        implementation = fp32_tail_forward
    elif variant == "fp32_block02":
        blocks = [model.decoder.blocks[0][2]]
        implementation = fp32_block_forward
    elif variant == "fp32_tail_all":
        blocks = [block for stage in model.decoder.blocks for block in stage]
        implementation = fp32_tail_forward
    elif variant == "fp32_stage0":
        blocks = list(model.decoder.blocks[0])
        implementation = fp32_block_forward
    else:
        raise ValueError(f"unknown precision variant: {variant}")
    for block in blocks:
        block.forward = types.MethodType(implementation, block)


def audio_pair(output: Any) -> Tensor:
    items = [output.cross_audio.float()]
    if output.self_audio is not None:
        items.insert(0, output.self_audio.float())
    return torch.cat(items, dim=0)


def difference(candidate: Tensor, reference: Tensor) -> dict[str, Any]:
    finite = torch.isfinite(candidate).flatten(1).all(dim=1)
    rows = []
    for index in range(candidate.shape[0]):
        if not bool(finite[index].item()):
            rows.append({"index": index, "finite": False})
            continue
        delta = candidate[index].float() - reference[index].float()
        denominator = reference[index].float().square().mean().sqrt().clamp_min(1e-8)
        rows.append({
            "index": index,
            "finite": True,
            "l1": float(delta.abs().mean().item()),
            "rms": float(delta.square().mean().sqrt().item()),
            "relative_rms": float((delta.square().mean().sqrt() / denominator).item()),
            "maximum_absolute": float(delta.abs().max().item()),
        })
    valid = candidate[finite].float() - reference[finite].float()
    return {
        "finite_samples": int(finite.sum().item()),
        "sample_count": int(finite.numel()),
        "rms": (float(valid.square().mean().sqrt().item()) if valid.numel() else None),
        "maximum_absolute": (float(valid.abs().max().item()) if valid.numel() else None),
        "by_sample": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--batch", required=True)
    parser.add_argument("--failure-json", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("decoder precision probe requires CUDA")

    device = torch.device("cuda")
    config = Config.load(args.config)
    state = torch.load(args.state, map_location="cpu", weights_only=False)
    batch = move(torch.load(args.batch, map_location="cpu", weights_only=False), device)
    failure = json.loads(Path(args.failure_json).read_text(encoding="utf-8"))
    include_self = bool(failure["include_self"])
    self_scale = float(failure["self_scale"])
    loss_scale = float(failure["scaler"])

    torch.manual_seed(20260719)
    torch.cuda.manual_seed_all(20260719)
    reference_model = build(config, state, device)
    reference_model.train()
    with torch.no_grad(), torch.autocast("cuda", enabled=False):
        reference_output = reference_model(
            batch["clap_a"].float(), batch["note_a"], batch["velocity_a"],
            batch["note_b"], batch["velocity_b"], batch["clap_b"].float(),
            grl_scale=1.0, include_self=include_self,
        )
        reference_audio = audio_pair(reference_output).detach()
    reference_report = {
        "audio": tensor_stats(reference_audio),
        "by_sample": per_sample_audio_stats(reference_audio),
    }
    del reference_model, reference_output
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    variants = {}
    for variant in ("baseline", "fp32_tail_block02", "fp32_block02",
                    "fp32_tail_all", "fp32_stage0"):
        torch.manual_seed(20260719)
        torch.cuda.manual_seed_all(20260719)
        model = build(config, state, device)
        model.train()
        configure_variant(model, variant)
        reconstruction = ReconstructionLoss(
            config.loss, config.data.sample_rate, config.model.pitch_backend,
            config.data.pitch_hop_length, config.model.pqmf_bands,
            config.model.pqmf_taps,
        ).to(device)
        output = None
        losses = None
        error_text = None
        try:
            with torch.autocast("cuda", dtype=torch.float16):
                output = model(
                    batch["clap_a"], batch["note_a"], batch["velocity_a"],
                    batch["note_b"], batch["velocity_b"], batch["clap_b"],
                    grl_scale=1.0, include_self=include_self,
                )
                losses = reconstruction(output, batch, output.target_timbre, True,
                                        self_scale=self_scale)
            if bool(torch.isfinite(losses.total).item()):
                (losses.total * loss_scale).backward()
        except RuntimeError as error:
            error_text = str(error)

        candidate = audio_pair(output).detach() if output is not None else None
        trainable = [(name, parameter) for name, parameter in model.named_parameters()
                     if parameter.requires_grad]
        variants[variant] = {
            "audio": tensor_stats(candidate),
            "self_audio_by_sample": (per_sample_audio_stats(output.self_audio)
                                     if output is not None else None),
            "cross_audio_by_sample": (per_sample_audio_stats(output.cross_audio)
                                      if output is not None else None),
            "difference_from_full_fp32": (difference(candidate, reference_audio)
                                           if candidate is not None else None),
            "total": (float(losses.total.detach().float().item())
                      if losses is not None else None),
            "total_finite": (bool(torch.isfinite(losses.total).item())
                             if losses is not None else False),
            "parameter_gradients": gradient_stats(trainable),
            "error": error_text,
            "peak_memory_gib": torch.cuda.max_memory_allocated() / (1024 ** 3),
        }
        del model, reconstruction, output, losses, candidate, trainable
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

    report = {
        "schema": 1,
        "rank": int(failure["rank"]),
        "captured_updates": int(state["generator_updates"]),
        "captured_loop": int(state["loop_step"]),
        "loss_scale": loss_scale,
        "reference_full_fp32": reference_report,
        "variants": variants,
    }
    Path(args.output).write_text(
        json.dumps(report, indent=2, sort_keys=True, allow_nan=True) + "\n",
        encoding="utf-8",
    )
    compact = {
        "rank": report["rank"],
        "reference_finite": reference_report["audio"]["finite"],
        "variants": {
            name: {
                "audio_finite": item["audio"]["finite"] if item["audio"] else False,
                "total_finite": item["total_finite"],
                "gradients_finite": item["parameter_gradients"]["finite"],
                "error": item["error"],
            }
            for name, item in variants.items()
        },
    }
    print(json.dumps(compact, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
