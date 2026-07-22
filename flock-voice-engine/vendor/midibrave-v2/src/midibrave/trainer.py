from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import shutil
import time
from contextlib import nullcontext
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.distributed as dist
from torch import Tensor, nn
from torch.nn.parallel import DistributedDataParallel as DDP
from torch.utils.data import DataLoader, DistributedSampler

from .config import Config
from .data import PairDataset
from .losses import (BraveMultiScaleDiscriminator, FrozenClapReconstructionObjective,
                     ReconstructionLoss, discriminator_hinge, feature_matching,
                     generator_adversarial)
from .model import ChannelRMSNorm, MidiBrave


def distributed_setup() -> tuple[int, int, int, torch.device]:
    world_size = int(os.environ.get("WORLD_SIZE", "1"))
    rank = int(os.environ.get("RANK", "0"))
    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    if not torch.cuda.is_available():
        raise RuntimeError("training requires CUDA; CPU is reserved for unit tests and preprocessing")
    torch.cuda.set_device(local_rank)
    if world_size > 1:
        dist.init_process_group("nccl")
    return rank, local_rank, world_size, torch.device("cuda", local_rank)


def unwrap(module: nn.Module) -> nn.Module:
    return module.module if isinstance(module, DDP) else module


def seed_everything(seed: int, rank: int) -> None:
    random.seed(seed + rank)
    np.random.seed(seed + rank)
    torch.manual_seed(seed + rank)
    torch.cuda.manual_seed_all(seed + rank)


def move_batch(batch: dict[str, Any], device: torch.device) -> dict[str, Any]:
    return {key: value.to(device, non_blocking=True) if isinstance(value, Tensor) else value
            for key, value in batch.items()}


def mask_audio(audio: Tensor, valid_samples: Tensor | None) -> Tensor:
    if valid_samples is None:
        return audio
    positions = torch.arange(audio.shape[-1], device=audio.device)
    mask = (positions[None, :] < valid_samples[:, None]).to(audio)[:, None]
    return audio * mask


def cosine_lr(step: int, total: int, warmup: int, high: float, low: float,
              hold_until: int | None = None) -> float:
    if step < warmup:
        return high * (step + 1) / max(1, warmup)
    hold_until = warmup if hold_until is None else max(warmup, hold_until)
    if step < hold_until:
        return high
    progress = min(1.0, (step - hold_until) / max(1, total - hold_until))
    return low + 0.5 * (high - low) * (1 + math.cos(math.pi * progress))


def _rng_state() -> dict[str, Any]:
    return {"torch": torch.get_rng_state(), "cuda": torch.cuda.get_rng_state_all(),
            "numpy": np.random.get_state(), "python": random.getstate()}


def _restore_rng(state: dict[str, Any]) -> None:
    torch.set_rng_state(state["torch"])
    torch.cuda.set_rng_state_all(state["cuda"])
    np.random.set_state(state["numpy"])
    random.setstate(state["python"])


def save_checkpoint(path: Path, phase: int, step: int, model: nn.Module,
                    optimizer: torch.optim.Optimizer, scaler: torch.amp.GradScaler,
                    epoch: int, microbatch_offset: int, manifest_hash: str,
                    discriminator: nn.Module | None = None,
                    discriminator_optimizer: torch.optim.Optimizer | None = None,
                    *, loop_step: int | None = None, generator_updates: int | None = None,
                    discriminator_updates: int = 0, config_hash: str | None = None,
                    manifest_metadata_hash: str | None = None,
                    scheduler_state: dict[str, Any] | None = None,
                    precision_state: dict[str, Any] | None = None,
                    sampler_state: dict[str, Any] | None = None) -> None:
    local_rng = _rng_state()
    if dist.is_available() and dist.is_initialized():
        rng_states: list[Any] = [None for _ in range(dist.get_world_size())]
        dist.all_gather_object(rng_states, local_rng)
        rank = dist.get_rank()
        world_size = dist.get_world_size()
    else:
        rng_states = [local_rng]
        rank = 0
        world_size = 1
    if rank != 0:
        return
    if generator_updates is None:
        generator_updates = step + 1
    if loop_step is None:
        loop_step = generator_updates
    payload = {
        "format": 4, "phase": phase, "step": step, "loop_step": loop_step,
        "generator_updates": generator_updates,
        "discriminator_updates": discriminator_updates,
        "world_size": world_size,
        "epoch": epoch, "microbatch_offset": microbatch_offset,
        "manifest_hash": manifest_hash, "manifest_metadata_hash": manifest_metadata_hash,
        "config_hash": config_hash,
        "model": unwrap(model).state_dict(), "optimizer": optimizer.state_dict(),
        "scaler": scaler.state_dict(), "rng_by_rank": rng_states,
        "scheduler_state": scheduler_state or {},
        "precision_state": precision_state or {},
        "sampler_state": sampler_state or {},
    }
    if discriminator is not None:
        payload["discriminator"] = unwrap(discriminator).state_dict()
        payload["discriminator_arch"] = getattr(
            unwrap(discriminator), "architecture_id", type(unwrap(discriminator)).__name__)
    if discriminator_optimizer is not None:
        payload["discriminator_optimizer"] = discriminator_optimizer.state_dict()
    temporary = path.with_suffix(".tmp")
    torch.save(payload, temporary)
    temporary.replace(path)


def load_checkpoint(path: str, model: nn.Module, optimizer: torch.optim.Optimizer,
                    scaler: torch.amp.GradScaler, phase: int,
                    discriminator: nn.Module | None = None,
                    discriminator_optimizer: torch.optim.Optimizer | None = None,
                    manifest_hash: str | None = None,
                    config_hash: str | None = None,
                    manifest_metadata_hash: str | None = None,
                    precision_state: dict[str, Any] | None = None,
                    ) -> tuple[int, int, int, int, int, dict[str, Any] | None]:
    payload = torch.load(path, map_location="cpu", weights_only=False)
    same_phase = int(payload["phase"]) == phase
    if same_phase and int(payload.get("format", 0)) != 4:
        raise ValueError("exact resume requires checkpoint format 4; use the old checkpoint only as a warm start")
    if same_phase:
        if phase == 2:
            if discriminator is None or discriminator_optimizer is None:
                raise ValueError("exact Phase 2 resume requires a discriminator and its optimizer")
            missing = {"discriminator", "discriminator_optimizer", "discriminator_arch"} - payload.keys()
            if missing:
                raise ValueError(
                    f"exact Phase 2 resume is missing checkpoint state: {sorted(missing)}"
                )
        unwrap(model).load_state_dict(payload["model"])
        world_size = dist.get_world_size() if dist.is_available() and dist.is_initialized() else 1
        if int(payload.get("world_size", 1)) != world_size:
            raise ValueError("exact resume requires the same DDP world size")
        if manifest_hash is not None and payload.get("manifest_hash") != manifest_hash:
            raise ValueError("checkpoint manifest hash does not match current data")
        if config_hash is not None and payload.get("config_hash") != config_hash:
            raise ValueError("checkpoint config hash does not match current config")
        if (manifest_metadata_hash is not None
                and payload.get("manifest_metadata_hash") != manifest_metadata_hash):
            raise ValueError("checkpoint manifest metadata hash does not match current data contract")
        if precision_state is not None and payload.get("precision_state") != precision_state:
            raise ValueError("checkpoint precision policy does not match current config")
        optimizer.load_state_dict(payload["optimizer"])
        scaler.load_state_dict(payload["scaler"])
        if discriminator is not None and "discriminator" in payload:
            expected_arch = getattr(unwrap(discriminator), "architecture_id", None)
            if payload.get("discriminator_arch") != expected_arch:
                raise ValueError(
                    f"discriminator architecture mismatch: {payload.get('discriminator_arch')} "
                    f"!= {expected_arch}"
                )
            unwrap(discriminator).load_state_dict(payload["discriminator"])
        if discriminator_optimizer is not None and "discriminator_optimizer" in payload:
            discriminator_optimizer.load_state_dict(payload["discriminator_optimizer"])
        rank = dist.get_rank() if dist.is_available() and dist.is_initialized() else 0
        rng_states = payload.get("rng_by_rank")
        rng = rng_states[rank] if rng_states else payload.get("rng")
        return (int(payload.get("loop_step", payload["step"] + 1)),
                int(payload.get("generator_updates", payload["step"] + 1)),
                int(payload.get("discriminator_updates", 0)),
                int(payload.get("epoch", 0)), int(payload.get("microbatch_offset", 0)), rng)

    if int(payload["phase"]) != 1 or phase != 2:
        raise ValueError("cross-phase warm start is supported only from Phase 1 into Phase 2")
    if manifest_hash is not None and payload.get("manifest_hash") not in {None, manifest_hash}:
        raise ValueError("warm-start manifest hash does not match current data")
    if config_hash is not None and payload.get("config_hash") not in {None, config_hash}:
        raise ValueError("warm-start config hash does not match current config")
    if (manifest_metadata_hash is not None
            and payload.get("manifest_metadata_hash") not in {None, manifest_metadata_hash}):
        raise ValueError("warm-start manifest metadata hash does not match current data contract")
    current = unwrap(model).state_dict()
    compatible = {name: value for name, value in payload["model"].items()
                  if name in current and current[name].shape == value.shape}
    incompatible = sorted(set(payload["model"]) - set(compatible))
    unwrap(model).load_state_dict(compatible, strict=False)
    if incompatible and set(incompatible) - {"pitch_adversary.net.2.weight",
                                              "pitch_adversary.net.2.bias"}:
        raise ValueError(f"warm start has incompatible generator tensors: {incompatible}")
    return 0, 0, 0, 0, 0, None


def make_generator_optimizer(model: MidiBrave, config: Config, phase: int) -> torch.optim.Optimizer:
    optimizer_kwargs: dict[str, Any] = {"betas": (0.8, 0.99)}
    if config.train.fused_adamw:
        optimizer_kwargs["fused"] = True
    if phase == 1:
        return torch.optim.AdamW(model.parameters(), lr=config.train.lr, **optimizer_kwargs)
    condition_parameters = list(model.timbre.parameters()) + list(model.midi.parameters())
    condition_ids = {id(parameter) for parameter in condition_parameters}
    synthesis_parameters = [parameter for parameter in model.parameters() if id(parameter) not in condition_ids]
    return torch.optim.AdamW([
        {"params": condition_parameters, "lr": config.train.phase2_condition_lr},
        {"params": synthesis_parameters, "lr": config.train.phase2_generator_lr},
    ], **optimizer_kwargs)


def _global_all_true(value: bool, device: torch.device) -> bool:
    flag = torch.tensor(1 if value else 0, device=device, dtype=torch.int32)
    if dist.is_available() and dist.is_initialized():
        dist.all_reduce(flag, op=dist.ReduceOp.MIN)
    return bool(flag.item())


def _tracked_tensor(module: nn.Module, preferred: str) -> Tensor:
    named = dict(unwrap(module).named_parameters())
    if preferred in named:
        return named[preferred]
    parameters = [parameter for parameter in unwrap(module).parameters() if parameter.requires_grad]
    if not parameters:
        raise ValueError("cannot track a module without trainable parameters")
    return min(parameters, key=lambda parameter: parameter.numel())


def _parameter_delta(parameter: Tensor, before: Tensor) -> float:
    return float((parameter.detach().float() - before).abs().max().item())


def _nan_audit_tensor(value: Tensor | None) -> dict[str, Any] | None:
    if value is None:
        return None
    item = value.detach().float()
    finite = torch.isfinite(item)
    valid = item[finite]
    return {
        "shape": list(item.shape),
        "finite": bool(finite.all().item()),
        "nonfinite": int((~finite).sum().item()),
        "minimum": float(valid.min().item()) if valid.numel() else None,
        "maximum": float(valid.max().item()) if valid.numel() else None,
        "maximum_absolute": float(valid.abs().max().item()) if valid.numel() else None,
    }


def _write_nan_audit_failure(
        directory: Path, error: BaseException, rank: int, local_rank: int,
        loop_step: int, generator_updates: int, include_self: bool, self_scale: float,
        scaler: torch.amp.GradScaler, batch: dict[str, Any], output: Any,
        losses: Any, model: nn.Module, optimizer: torch.optim.Optimizer) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    tensor_metadata = {}
    for name, value in batch.items():
        if isinstance(value, Tensor) and name not in {"audio_a", "audio_b", "clap_a", "clap_b"}:
            tensor_metadata[name] = value.detach().cpu().tolist()
        elif not isinstance(value, Tensor):
            tensor_metadata[name] = value
    parameter_nonfinite = []
    gradient_nonfinite = []
    for name, parameter in unwrap(model).named_parameters():
        if not bool(torch.isfinite(parameter.detach()).all().item()):
            parameter_nonfinite.append(name)
        if parameter.grad is not None and not bool(torch.isfinite(parameter.grad).all().item()):
            gradient_nonfinite.append(name)
    payload = {
        "schema": 1,
        "error_type": type(error).__name__,
        "error": str(error),
        "rank": rank,
        "local_rank": local_rank,
        "loop_step_before_increment": loop_step,
        "generator_updates": generator_updates,
        "include_self": include_self,
        "self_scale": self_scale,
        "scaler": float(scaler.get_scale()),
        "batch": tensor_metadata,
        "inputs": {
            "audio_a": _nan_audit_tensor(batch.get("audio_a")),
            "audio_b": _nan_audit_tensor(batch.get("audio_b")),
            "clap_a": _nan_audit_tensor(batch.get("clap_a")),
            "clap_b": _nan_audit_tensor(batch.get("clap_b")),
        },
        "outputs": ({
            "self_audio": _nan_audit_tensor(output.self_audio),
            "cross_audio": _nan_audit_tensor(output.cross_audio),
            "timbre": _nan_audit_tensor(output.timbre),
            "target_timbre": _nan_audit_tensor(output.target_timbre),
            "pitch_logits": _nan_audit_tensor(output.pitch_logits),
        } if output is not None else None),
        "losses": ({name: float(value.detach().float().item())
                    for name, value in losses.values.items()}
                   if losses is not None else None),
        "parameter_nonfinite": parameter_nonfinite,
        "gradient_nonfinite": gradient_nonfinite,
    }
    temporary_json = directory / f"failure-rank-{rank}.json.tmp"
    final_json = directory / f"failure-rank-{rank}.json"
    temporary_json.write_text(
        json.dumps(payload, indent=2, sort_keys=True, allow_nan=True) + "\n",
        encoding="utf-8",
    )
    temporary_json.replace(final_json)
    tensor_batch = {
        name: (value.detach().cpu() if isinstance(value, Tensor) else value)
        for name, value in batch.items()
    }
    temporary_batch = directory / f"failure-batch-rank-{rank}.pt.tmp"
    final_batch = directory / f"failure-batch-rank-{rank}.pt"
    torch.save(tensor_batch, temporary_batch)
    temporary_batch.replace(final_batch)
    # Every rank may be the first one on which anomaly mode raises. Save the
    # synchronized model plus that rank's exact batch without requiring rank 0
    # to reach the exception handler or any collective.
    temporary_state = directory / f"failure-state-rank-{rank}.pt.tmp"
    final_state = directory / f"failure-state-rank-{rank}.pt"
    torch.save({
        "model": unwrap(model).state_dict(),
        "scaler": scaler.state_dict(),
        "loop_step": loop_step,
        "generator_updates": generator_updates,
    }, temporary_state)
    temporary_state.replace(final_state)


def _split_discriminator_batch(output, first_batch: int):
    first = []
    second = []
    for score, features in output:
        first.append((score[:first_batch], [feature[:first_batch] for feature in features]))
        second.append((score[first_batch:], [feature[first_batch:] for feature in features]))
    return first, second


def _split_discriminator_segments(output, sizes: list[int]):
    segments = []
    offset = 0
    for size in sizes:
        current = []
        for score, features in output:
            current.append((score[offset:offset + size],
                            [feature[offset:offset + size] for feature in features]))
        segments.append(current)
        offset += size
    return segments


def _detach_discriminator_output(output):
    return [(score.detach(), [feature.detach() for feature in features])
            for score, features in output]


def _self_branch_schedule(config: Config, phase: int,
                          generator_updates: int) -> tuple[bool, float]:
    probability = config.train.self_probability
    if not 0.0 < probability <= 1.0:
        raise ValueError("train.self_probability must be in (0, 1]")
    if not 0.0 <= config.train.self_full_fraction <= 1.0:
        raise ValueError("train.self_full_fraction must be in [0, 1]")
    if phase == 1:
        full_updates = round(config.train.phase1_steps * config.train.self_full_fraction)
        if generator_updates < full_updates:
            return True, 1.0
        relative_step = generator_updates - full_updates
    else:
        relative_step = generator_updates
    if probability == 1.0:
        return True, 1.0
    include = (math.floor((relative_step + 1) * probability)
               > math.floor(relative_step * probability))
    return include, (1.0 / probability if include else 0.0)


def _pitch_adversary_scale(config: Config, phase: int, generator_updates: int) -> float:
    # Phase 2 is a warm start from a fully ramped Phase 1 model. Its local update
    # counter intentionally restarts at zero, so reusing the Phase 1 threshold
    # would silently disable the disentanglement constraint for most of Phase 2.
    if phase == 2:
        return 1.0
    if generator_updates < config.train.pitch_adversary_start:
        return 0.0
    return min(
        1.0,
        (generator_updates - config.train.pitch_adversary_start + 1)
        / max(1, config.train.pitch_adversary_ramp),
    )


def _scheduled_clap_weight(weight: float, generator_updates: int,
                           warmup_steps: int) -> float:
    if weight <= 0.0:
        return 0.0
    if warmup_steps <= 0:
        return float(weight)
    return float(weight) * min(1.0, (generator_updates + 1) / warmup_steps)


def _clap_due(config: Config, generator_updates: int) -> bool:
    enabled = config.loss.self_clap > 0.0 or config.loss.cross_clap > 0.0
    if not enabled:
        return False
    interval = config.loss.clap_every_updates
    if interval <= 0:
        raise ValueError("loss.clap_every_updates must be positive")
    if config.loss.clap_batch_size <= 0:
        raise ValueError("loss.clap_batch_size must be positive")
    return (generator_updates + 1) % interval == 0


@torch.no_grad()
def _clap_prepass(model: nn.Module, batch: dict[str, Any], include_self: bool,
                  indices: Tensor) -> dict[str, Tensor]:
    """Recompute the normal decoder output without retaining its activation graph."""
    value = unwrap(model)(
        batch["clap_a"], batch["note_a"], batch["velocity_a"],
        batch["note_b"], batch["velocity_b"], batch["clap_b"],
        grl_scale=0.0, include_self=include_self,
        source_excitation_seed=batch.get("excitation_seed_a"),
        target_excitation_seed=batch.get("excitation_seed_b"),
    )
    selected = {"cross": value.cross_audio.index_select(0, indices).detach()}
    if include_self:
        assert value.self_audio is not None
        selected["self"] = value.self_audio.index_select(0, indices).detach()
    return selected


def _prepare_clap_injections(
        model: nn.Module, objective: FrozenClapReconstructionObjective,
        batch: dict[str, Any], config: Config, include_self: bool, self_scale: float,
        generator_updates: int, rank: int) -> dict[str, dict[str, Tensor | float]]:
    batch_size = int(batch["audio_a"].shape[0])
    selected_count = min(config.loss.clap_batch_size, batch_size)
    event = (generator_updates + 1) // config.loss.clap_every_updates
    start = (event * selected_count + rank * selected_count) % batch_size
    indices = torch.tensor(
        [(start + offset) % batch_size for offset in range(selected_count)],
        device=batch["audio_a"].device, dtype=torch.long,
    )
    with torch.autocast("cuda", dtype=torch.float16):
        predictions = _clap_prepass(model, batch, include_self, indices)

    names = ["cross"]
    if include_self and config.loss.self_clap > 0.0:
        names.append("self")
    names = [name for name in names if getattr(config.loss, f"{name}_clap") > 0.0]
    if not names:
        return {}
    generated = torch.cat([predictions[name] for name in names], dim=0)
    targets = torch.cat([
        batch["audio_b" if name == "cross" else "audio_a"].index_select(0, indices)
        for name in names
    ], dim=0)
    valid = torch.cat([
        batch["valid_samples_b" if name == "cross" else "valid_samples_a"].index_select(
            0, indices)
        for name in names
    ], dim=0)
    result = objective.waveform_gradients(generated, targets, valid)
    injections: dict[str, dict[str, Tensor | float]] = {}
    offset = 0
    for name in names:
        stop = offset + selected_count
        raw_loss = result.losses[offset:stop].mean()
        branch_scale = self_scale if name == "self" else 1.0
        weight = _scheduled_clap_weight(
            getattr(config.loss, f"{name}_clap"), generator_updates,
            config.loss.clap_warmup_steps,
        )
        # The trainer divides each microbatch loss by grad_accum. CLAP is
        # evaluated on one microbatch every K updates, so G*K restores the
        # expectation of the full per-update objective. selected_count is the
        # Monte-Carlo batch mean; Self reuses its existing 1/p correction.
        gradient_scale = (
            weight * config.train.grad_accum * config.loss.clap_every_updates
            * branch_scale / selected_count
        )
        injections[name] = {
            "indices": indices,
            "reference": predictions[name],
            "gradient": result.gradients[offset:stop] * gradient_scale,
            "raw_loss": raw_loss,
            "raw_gradient_norm": result.gradient_norms[offset:stop].mean(),
            "clipped_gradient_norm": result.clipped_gradient_norms[offset:stop].mean(),
            "weight": weight,
            "branch_scale": branch_scale,
        }
        offset = stop
    return injections


def _inject_clap_gradients(output: Any, injections: dict[str, dict[str, Tensor | float]],
                           grad_accum: int) -> tuple[Tensor, dict[str, Tensor]]:
    addition = output.cross_audio.new_zeros(())
    diagnostics: dict[str, Tensor] = {}
    for name, injection in injections.items():
        prediction = output.cross_audio if name == "cross" else output.self_audio
        if prediction is None:
            raise RuntimeError(f"missing {name} output required by CLAP injection")
        indices = injection["indices"]
        assert isinstance(indices, Tensor)
        selected = prediction.index_select(0, indices)
        gradient = injection["gradient"]
        reference = injection["reference"]
        raw_loss = injection["raw_loss"]
        assert isinstance(gradient, Tensor) and isinstance(reference, Tensor)
        assert isinstance(raw_loss, Tensor)
        surrogate = (selected.float() * gradient.float()).sum()
        weight = float(injection["weight"])
        branch_scale = float(injection["branch_scale"])
        # The detached value keeps logged totals on the ordinary objective
        # scale. Only the surrogate carries the sparse, probability-corrected
        # waveform gradient.
        displayed = raw_loss * weight * branch_scale * grad_accum
        addition = addition + surrogate - surrogate.detach() + displayed.detach()
        diagnostics[f"{name}_clap"] = raw_loss
        diagnostics[f"{name}_clap_waveform_grad_norm"] = injection["raw_gradient_norm"]
        diagnostics[f"{name}_clap_waveform_grad_norm_clipped"] = (
            injection["clipped_gradient_norm"])
        diagnostics[f"{name}_clap_recompute_max_abs_error"] = (
            selected.detach().float() - reference.float()).abs().amax()
        diagnostics[f"{name}_clap_effective_weight"] = raw_loss.new_tensor(weight)
    return addition, diagnostics


def _run_clap_decoder_step(
        model: nn.Module, optimizer: torch.optim.Optimizer,
        scaler: torch.amp.GradScaler, objective: FrozenClapReconstructionObjective,
        batch: dict[str, Any], config: Config, include_self: bool, self_scale: float,
        generator_updates_before_step: int, rank: int,
        device: torch.device) -> tuple[bool, Tensor, dict[str, Tensor]]:
    """Apply a CLAP-only substep to Decoder parameters.

    CLAP waveform gradients are still evaluated through the frozen encoder and
    clipped there.  They are then back-propagated through a fresh model forward,
    separately from reconstruction gradients, so the ordinary global gradient
    clip cannot erase their direction.  The dedicated optimizer owns Decoder
    parameters only; gradients reaching the conditioning stack are discarded.
    """
    optimizer.zero_grad(set_to_none=True)
    unwrap(model).zero_grad(set_to_none=True)
    injections = _prepare_clap_injections(
        model, objective, batch, config, include_self, self_scale,
        generator_updates_before_step, rank,
    )
    if not injections:
        zero = batch["audio_a"].new_zeros(())
        return False, zero, {}
    # Bypass the DDP wrapper for this Decoder-only objective.  The pitch
    # adversary and conditioning heads are intentionally absent from the CLAP
    # graph, which would otherwise leave DDP reductions unfinished.  Decoder
    # gradients are averaged explicitly below.
    with torch.autocast("cuda", dtype=torch.float16):
        output = unwrap(model)(
            batch["clap_a"], batch["note_a"], batch["velocity_a"],
            batch["note_b"], batch["velocity_b"], batch["clap_b"],
            grl_scale=0.0, include_self=include_self,
            source_excitation_seed=batch.get("excitation_seed_a"),
            target_excitation_seed=batch.get("excitation_seed_b"),
        )
    addition, diagnostics = _inject_clap_gradients(
        output, injections, config.train.grad_accum)
    # _prepare_clap_injections compensates for the main trainer's G-way
    # accumulation.  This is a single standalone substep, so divide that
    # correction back out before backward.
    objective_surrogate = addition / config.train.grad_accum
    scaler.scale(objective_surrogate).backward()
    scaler.unscale_(optimizer)
    decoder_parameters = list(unwrap(model).decoder.parameters())
    if dist.is_available() and dist.is_initialized():
        world_size = dist.get_world_size()
        for parameter in decoder_parameters:
            if parameter.grad is not None:
                dist.all_reduce(parameter.grad, op=dist.ReduceOp.SUM)
                parameter.grad.div_(world_size)
    grad_norm = torch.nn.utils.clip_grad_norm_(
        decoder_parameters, config.train.grad_clip)
    finite = _global_all_true(bool(torch.isfinite(grad_norm).item()), device)
    if finite:
        scaler.step(optimizer)
        scaler.update()
    else:
        scaler.update(new_scale=max(1.0, float(scaler.get_scale()) * 0.5))
    unwrap(model).zero_grad(set_to_none=True)
    diagnostics = {f"separate_{name}": value for name, value in diagnostics.items()}
    diagnostics["separate_clap_decoder_grad_norm"] = grad_norm.detach()
    diagnostics["separate_clap_step_applied"] = grad_norm.new_tensor(float(finite))
    diagnostics["separate_clap_scale"] = grad_norm.new_tensor(float(scaler.get_scale()))
    return finite, grad_norm.detach(), diagnostics


def train(config_path: str, phase: int, max_steps: int | None = None,
          resume: str | None = None) -> None:
    config = Config.load(config_path)
    if config.train.precision != "amp_fp16":
        raise ValueError("Octopus V100 training supports precision=amp_fp16 only")
    if config.train.ddp_static_graph and config.train.self_probability < 1.0:
        raise ValueError(
            "DDP static_graph is incompatible with conditional Self-branch sampling"
        )
    if config.loss.clap_warmup_steps < 0:
        raise ValueError("loss.clap_warmup_steps must be non-negative")
    if config.loss.clap_gradient_norm < 0:
        raise ValueError("loss.clap_gradient_norm must be non-negative")
    if config.train.clap_decoder_step_lr < 0:
        raise ValueError("train.clap_decoder_step_lr must be non-negative")
    if phase != 1 and config.train.clap_decoder_step_lr > 0:
        raise ValueError("the experimental CLAP Decoder substep supports Phase 1 only")
    clap_enabled = config.loss.self_clap > 0.0 or config.loss.cross_clap > 0.0
    if clap_enabled and not config.data.clap_checkpoint:
        raise ValueError("CLAP reconstruction requires data.clap_checkpoint")
    rank, local_rank, world_size, device = distributed_setup()
    seed_everything(config.seed, rank)
    deterministic = os.environ.get("MIDIBRAVE_DETERMINISTIC", "0") == "1"
    torch.backends.cudnn.benchmark = not deterministic
    torch.backends.cudnn.deterministic = deterministic
    torch.use_deterministic_algorithms(deterministic)
    dataset = PairDataset(config.data, config.seed)
    sampler = DistributedSampler(dataset, num_replicas=world_size, rank=rank, shuffle=True,
                                 seed=config.seed, drop_last=True)
    loader_kwargs: dict[str, Any] = {
        "batch_size": config.train.batch_per_gpu,
        "sampler": sampler,
        "shuffle": False,
        "num_workers": config.data.num_workers,
        "pin_memory": True,
        "persistent_workers": config.data.num_workers > 0,
        "drop_last": True,
    }
    if config.data.num_workers > 0:
        loader_kwargs["prefetch_factor"] = config.data.prefetch_factor
    loader = DataLoader(dataset, **loader_kwargs)
    if not len(loader):
        raise ValueError("dataset is too small for the configured DDP world size and batch")

    model: nn.Module = MidiBrave(
        config.model, config.data.window_samples, config.data.sample_rate).to(device)
    unwrap(model).prepare_runtime_caches()
    activation_run_max = torch.zeros((), device=device)
    activation_hooks = []
    if os.environ.get("MIDIBRAVE_TRACK_ACTIVATIONS", "0") == "1":
        def track_activation(_module, inputs):
            nonlocal activation_run_max
            value = inputs[0].detach().float().abs().amax()
            activation_run_max = torch.maximum(activation_run_max, value)
        for module in unwrap(model).modules():
            if isinstance(module, ChannelRMSNorm):
                activation_hooks.append(module.register_forward_pre_hook(track_activation))
    if config.train.compile_decoder:
        decoder = unwrap(model).decoder
        if not hasattr(decoder, "compile"):
            raise RuntimeError("this PyTorch build does not support nn.Module.compile")
        decoder.compile(mode=config.train.compile_mode)
    if world_size > 1:
        model = DDP(
            model, device_ids=[local_rank], broadcast_buffers=False,
            gradient_as_bucket_view=config.train.ddp_gradient_as_bucket_view,
            static_graph=config.train.ddp_static_graph,
            bucket_cap_mb=config.train.ddp_bucket_cap_mb,
        )
    generator_optimizer = make_generator_optimizer(unwrap(model), config, phase)
    clap_decoder_optimizer: torch.optim.Optimizer | None = None
    clap_decoder_scaler: torch.amp.GradScaler | None = None
    if config.train.clap_decoder_step_lr > 0:
        clap_optimizer_kwargs: dict[str, Any] = {"betas": (0.8, 0.99)}
        if config.train.fused_adamw:
            clap_optimizer_kwargs["fused"] = True
        clap_decoder_optimizer = torch.optim.AdamW(
            unwrap(model).decoder.parameters(),
            lr=config.train.clap_decoder_step_lr,
            **clap_optimizer_kwargs,
        )
        clap_decoder_scaler = torch.amp.GradScaler(
            "cuda", init_scale=config.train.grad_scaler_init_scale,
            growth_interval=config.train.grad_scaler_growth_interval,
        )
    discriminator: nn.Module | None = None
    discriminator_optimizer: torch.optim.Optimizer | None = None
    if phase == 2:
        discriminator = BraveMultiScaleDiscriminator().to(device)
        if config.train.compile_discriminator:
            if not hasattr(discriminator, "compile"):
                raise RuntimeError("this PyTorch build does not support nn.Module.compile")
            discriminator.compile(mode=config.train.compile_mode)
        if world_size > 1:
            discriminator = DDP(
                discriminator, device_ids=[local_rank], broadcast_buffers=False,
                gradient_as_bucket_view=config.train.ddp_gradient_as_bucket_view,
                static_graph=config.train.ddp_static_graph,
                bucket_cap_mb=config.train.ddp_bucket_cap_mb,
            )
        discriminator_kwargs: dict[str, Any] = {"betas": (0.5, 0.9)}
        if config.train.fused_adamw:
            discriminator_kwargs["fused"] = True
        discriminator_optimizer = torch.optim.AdamW(
            discriminator.parameters(), lr=config.train.discriminator_lr,
            **discriminator_kwargs)
    reconstruction = ReconstructionLoss(
        config.loss, config.data.sample_rate, config.model.pitch_backend,
        config.data.pitch_hop_length, config.model.pqmf_bands, config.model.pqmf_taps,
    ).to(device)
    clap_objective = (
        FrozenClapReconstructionObjective(
            config.data.clap_checkpoint, config.data.sample_rate, device,
            config.loss.clap_gradient_norm,
        )
        if clap_enabled else None
    )
    scaler = torch.amp.GradScaler(
        "cuda", init_scale=config.train.grad_scaler_init_scale,
        growth_interval=config.train.grad_scaler_growth_interval,
    )

    manifest_hash = hashlib.sha256(Path(config.data.manifest).read_bytes()).hexdigest()
    config_hash = hashlib.sha256(Path(config.source_path).read_bytes()).hexdigest()
    metadata_hash = None
    if config.data.manifest_metadata:
        metadata_hash = hashlib.sha256(Path(config.data.manifest_metadata).read_bytes()).hexdigest()
    loop_step = generator_updates = discriminator_updates = epoch = microbatch_offset = 0
    precision_state = {
        "precision": config.train.precision,
        "decoder_fp32_tail": config.model.decoder_fp32_tail,
        "pqmf_dtype": config.model.pqmf_dtype,
        "norm_reduction_dtype": config.model.norm_reduction_dtype,
        "phase_accumulation_dtype": config.model.phase_accumulation_dtype,
    }
    resume_rng = None
    if resume:
        (loop_step, generator_updates, discriminator_updates, epoch,
         microbatch_offset, resume_rng) = load_checkpoint(
            resume, model, generator_optimizer, scaler, phase, discriminator,
            discriminator_optimizer, manifest_hash, config_hash, metadata_hash,
            precision_state,
        )
        resume_payload = torch.load(resume, map_location="cpu", weights_only=False)
        dataset.load_sampler_state_dict(resume_payload.get("sampler_state", {}))
    configured_updates = config.train.phase1_steps if phase == 1 else config.train.phase2_steps
    total_updates = min(configured_updates, max_steps) if max_steps is not None else configured_updates
    if generator_updates > total_updates:
        raise ValueError("checkpoint already exceeds the requested effective update limit")

    run_dir = Path(config.train.output_dir) / config.train.run_name / f"phase{phase}"
    if rank == 0:
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "config.yaml").write_text(
            Path(config.source_path).read_text(encoding="utf-8"), encoding="utf-8")
    if world_size > 1:
        dist.barrier()
    if rank == 0:
        from torch.utils.tensorboard import SummaryWriter
        writer = SummaryWriter(run_dir)
    else:
        writer = None
    metrics_path = run_dir / "metrics.jsonl"

    dataset.set_epoch(epoch)
    sampler.set_epoch(epoch)
    iterator = iter(loader)
    for _ in range(microbatch_offset):
        try:
            next(iterator)
        except StopIteration as error:
            raise ValueError("checkpoint microbatch offset exceeds epoch length") from error
    if resume_rng is not None:
        _restore_rng(resume_rng)
    generator_optimizer.zero_grad(set_to_none=True)
    if discriminator_optimizer is not None:
        discriminator_optimizer.zero_grad(set_to_none=True)

    started = time.time()
    updates_at_start = generator_updates
    global_pairs_per_update = world_size * config.train.batch_per_gpu * config.train.grad_accum
    executed_audio_windows = 0
    maximum_loops = loop_step + max(1000, (total_updates - generator_updates) * 10)
    nan_audit_directory_text = os.environ.get("MIDIBRAVE_NAN_AUDIT_DIR", "")
    nan_audit_directory = (Path(nan_audit_directory_text)
                           if nan_audit_directory_text else None)
    nan_audit_start = int(os.environ.get("MIDIBRAVE_NAN_AUDIT_START_UPDATE", "0"))
    nan_audit_capture_scale_max = float(
        os.environ.get("MIDIBRAVE_NAN_AUDIT_CAPTURE_SCALE_MAX", "4.0")
    )
    max_consecutive_nonfinite = int(
        os.environ.get("MIDIBRAVE_MAX_CONSECUTIVE_NONFINITE", "16")
    )
    if max_consecutive_nonfinite <= 0:
        raise ValueError("MIDIBRAVE_MAX_CONSECUTIVE_NONFINITE must be positive")
    reconstruction_weights = {
        "self_stft": config.loss.self_stft,
        "self_envelope": config.loss.self_envelope,
        "self_pitch": config.loss.self_pitch,
        "self_rms": config.loss.self_rms,
        "self_spectral_flux": config.loss.self_spectral_flux,
        "self_band_statistics": config.loss.self_band_statistics,
        "cross_stft": config.loss.cross_stft,
        "cross_envelope": config.loss.cross_envelope,
        "cross_pitch": config.loss.cross_pitch,
        "cross_rms": config.loss.cross_rms,
        "cross_spectral_flux": config.loss.cross_spectral_flux,
        "cross_band_statistics": config.loss.cross_band_statistics,
        "velocity_rank": config.loss.velocity_rank,
        "velocity_delta": config.loss.velocity_delta,
        "self_clap": config.loss.self_clap,
        "cross_clap": config.loss.cross_clap,
        "timbre_pair": config.loss.timbre_pair,
        "distribution": config.loss.distribution,
        "pitch_adversary": config.loss.pitch_adversary,
        "adversarial": config.loss.adversarial,
        "feature_matching": config.loss.feature_matching,
    }
    # A log row now summarizes every observation since the previous row.  This
    # prevents log_every=20 from aliasing with Self every 2 updates and CLAP
    # every 4 updates, which previously made entire resumed segments appear to
    # have no Self/CLAP measurements.
    log_metric_sums: dict[str, Tensor] = {}
    log_metric_counts: dict[str, int] = {}
    log_window_updates = 0
    consecutive_nonfinite = 0
    anomaly_enabled = False
    while generator_updates < total_updates:
        if loop_step >= maximum_loops:
            raise RuntimeError("too many skipped updates; refusing to count overflow loops as training")
        if (nan_audit_directory is not None and generator_updates >= nan_audit_start
                and not anomaly_enabled):
            # Global anomaly mode records the forward traceback for the exact
            # backward operator that first returns NaN. It is intentionally
            # enabled only near the known failure region because it is slow.
            torch.autograd.set_detect_anomaly(True, check_nan=True)
            anomaly_enabled = True
        loop_started = time.perf_counter()
        if phase == 1:
            lr = cosine_lr(generator_updates, configured_updates, config.train.warmup_steps,
                           config.train.lr, config.train.min_lr,
                           config.train.lr_hold_until)
            for group in generator_optimizer.param_groups:
                group["lr"] = lr
        aggregate: dict[str, Tensor] = {}
        data_wait_seconds = 0.0
        include_self, self_scale = _self_branch_schedule(config, phase, generator_updates)

        for microstep in range(config.train.grad_accum):
            data_started = time.perf_counter()
            try:
                batch = next(iterator)
            except StopIteration:
                epoch += 1
                dataset.set_epoch(epoch)
                sampler.set_epoch(epoch)
                iterator = iter(loader)
                microbatch_offset = 0
                batch = next(iterator)
            data_wait_seconds += time.perf_counter() - data_started
            microbatch_offset += 1
            batch = move_batch(batch, device)
            sync = microstep == config.train.grad_accum - 1
            sync_context = nullcontext() if sync or world_size == 1 else model.no_sync()
            grl_scale = _pitch_adversary_scale(config, phase, generator_updates)
            clap_injections = {}
            if (sync and clap_objective is not None
                    and clap_decoder_optimizer is None
                    and _clap_due(config, generator_updates)):
                clap_injections = _prepare_clap_injections(
                    model, clap_objective, batch, config, include_self, self_scale,
                    generator_updates, rank,
                )

            with sync_context:
                with torch.autocast("cuda", dtype=torch.float16):
                    output = model(batch["clap_a"], batch["note_a"], batch["velocity_a"],
                                   batch["note_b"], batch["velocity_b"], batch["clap_b"],
                                   grl_scale=grl_scale, include_self=include_self,
                                   source_excitation_seed=batch.get("excitation_seed_a"),
                                   target_excitation_seed=batch.get("excitation_seed_b"))
                    losses = reconstruction(
                        output, batch, output.target_timbre, grl_scale > 0,
                        self_scale=self_scale, generator_update=generator_updates,
                    )
                    generator_loss = losses.total

                if clap_injections:
                    clap_addition, clap_diagnostics = _inject_clap_gradients(
                        output, clap_injections, config.train.grad_accum)
                    generator_loss = generator_loss + clap_addition
                    losses.total = generator_loss
                    losses.values.update(clap_diagnostics)

                discriminator_loss: Tensor | None = None
                if discriminator is not None and discriminator_optimizer is not None:
                    discriminator.requires_grad_(True)
                    discriminator_sync = (nullcontext() if sync or world_size == 1
                                          else discriminator.no_sync())
                    pair_batch = batch["audio_a"].shape[0]
                    with discriminator_sync:
                        with torch.autocast("cuda", dtype=torch.float16):
                            discriminator_inputs = [mask_audio(
                                batch["audio_b"], batch.get("valid_samples_b"))]
                            segment_names = ["real_cross"]
                            if include_self:
                                discriminator_inputs.append(mask_audio(
                                    batch["audio_a"], batch.get("valid_samples_a")))
                                segment_names.append("real_self")
                            discriminator_inputs.append(mask_audio(
                                output.cross_audio.detach(), batch.get("valid_samples_b")))
                            segment_names.append("fake_cross")
                            if include_self:
                                assert output.self_audio is not None
                                discriminator_inputs.append(mask_audio(
                                    output.self_audio.detach(), batch.get("valid_samples_a")))
                                segment_names.append("fake_self")
                            discriminator_train_output = discriminator(
                                torch.cat(discriminator_inputs, dim=0))
                            split = _split_discriminator_segments(
                                discriminator_train_output,
                                [pair_batch for _ in discriminator_inputs],
                            )
                            segments = dict(zip(segment_names, split))
                            discriminator_loss = 0.5 * discriminator_hinge(
                                segments["real_cross"], segments["fake_cross"])
                            if include_self:
                                discriminator_loss = (
                                    discriminator_loss
                                    + 0.5 * self_scale * discriminator_hinge(
                                        segments["real_self"], segments["fake_self"])
                                )
                            real_cross = _detach_discriminator_output(segments["real_cross"])
                            real_self = (_detach_discriminator_output(segments["real_self"])
                                         if include_self else None)
                        scaler.scale(
                            discriminator_loss / config.train.grad_accum).backward()
                    del discriminator_train_output, segments, split
                    discriminator.requires_grad_(False)
                    with torch.autocast("cuda", dtype=torch.float16):
                        if include_self:
                            assert output.self_audio is not None and real_self is not None
                            fake_combined = discriminator(torch.cat((
                                mask_audio(output.self_audio, batch.get("valid_samples_a")),
                                mask_audio(output.cross_audio, batch.get("valid_samples_b")),
                            ), dim=0))
                            fake_self, fake_cross = _split_discriminator_batch(
                                fake_combined, pair_batch)
                            adversarial = (self_scale * generator_adversarial(fake_self)
                                           + 0.25 * generator_adversarial(fake_cross))
                            matching = (self_scale * feature_matching(real_self, fake_self)
                                        + 0.25 * feature_matching(real_cross, fake_cross))
                        else:
                            fake_cross = discriminator(mask_audio(
                                output.cross_audio, batch.get("valid_samples_b")))
                            adversarial = 0.25 * generator_adversarial(fake_cross)
                            matching = 0.25 * feature_matching(real_cross, fake_cross)
                        generator_loss = (generator_loss
                                          + config.loss.adversarial * adversarial
                                          + config.loss.feature_matching * matching)
                        losses.values["adversarial"] = adversarial
                        losses.values["feature_matching"] = matching
                    discriminator.requires_grad_(True)

                try:
                    scaler.scale(generator_loss / config.train.grad_accum).backward()
                except RuntimeError as error:
                    if nan_audit_directory is not None:
                        _write_nan_audit_failure(
                            nan_audit_directory, error, rank, local_rank,
                            loop_step, generator_updates, include_self, self_scale,
                            scaler, batch, output, losses, model, generator_optimizer,
                        )
                    raise

            if discriminator_loss is not None:
                aggregate["discriminator"] = (
                    aggregate.get("discriminator", discriminator_loss.new_zeros(()))
                    + discriminator_loss.detach() / config.train.grad_accum)
            for name, value in losses.values.items():
                # Sparse CLAP metrics occur only on the final accumulation
                # microbatch. Undo the ordinary 1/G metric averaging; the
                # gradient itself was already corrected when prepared.
                metric_scale = (config.train.grad_accum if "_clap" in name else 1.0)
                aggregate[name] = (aggregate.get(name, value.new_zeros(()))
                                   + value.detach() * metric_scale / config.train.grad_accum)
            aggregate["total"] = (aggregate.get("total", generator_loss.new_zeros(()))
                                  + generator_loss.detach() / config.train.grad_accum)

            if microbatch_offset == len(loader):
                epoch += 1
                dataset.set_epoch(epoch)
                sampler.set_epoch(epoch)
                iterator = iter(loader)
                microbatch_offset = 0

        scale_before = float(scaler.get_scale())
        generator_tracked = _tracked_tensor(model, "decoder.output.weight")
        generator_before = generator_tracked.detach().clone()
        scaler.unscale_(generator_optimizer)
        generator_grad_norm = torch.nn.utils.clip_grad_norm_(
            model.parameters(), config.train.grad_clip)
        local_finite = bool(torch.isfinite(generator_grad_norm).item())
        discriminator_grad_norm: Tensor | None = None
        discriminator_tracked: Tensor | None = None
        discriminator_before: Tensor | None = None
        if discriminator is not None and discriminator_optimizer is not None:
            discriminator_tracked = _tracked_tensor(discriminator, "scales.0.output.weight")
            discriminator_before = discriminator_tracked.detach().clone()
            scaler.unscale_(discriminator_optimizer)
            discriminator_grad_norm = torch.nn.utils.clip_grad_norm_(
                discriminator.parameters(), config.train.grad_clip)
            local_finite = local_finite and bool(torch.isfinite(discriminator_grad_norm).item())

        # Autograd anomaly mode raises on NaN-producing backward operators, but
        # it does not reliably raise for every Inf gradient. Capture the first
        # low-scale overflow after unscale as a second diagnostic route. At
        # scale <= 4 this is no longer merely an aggressive GradScaler growth
        # probe; the underlying unscaled graph is near or beyond FP16 range.
        if (nan_audit_directory is not None and not local_finite
                and scale_before <= nan_audit_capture_scale_max):
            error = RuntimeError(
                "non-finite gradient after unscale at low AMP scale "
                f"{scale_before:g}"
            )
            _write_nan_audit_failure(
                nan_audit_directory, error, rank, local_rank,
                loop_step, generator_updates, include_self, self_scale,
                scaler, batch, output, losses, model, generator_optimizer,
            )
            raise error

        step_applied = _global_all_true(local_finite, device)
        separate_clap_diagnostics: dict[str, Tensor] = {}
        update_before_step = generator_updates
        if step_applied:
            consecutive_nonfinite = 0
            scaler.step(generator_optimizer)
            if discriminator_optimizer is not None:
                scaler.step(discriminator_optimizer)
            scaler.update()
            generator_updates += 1
            executed_audio_windows += global_pairs_per_update * (1 + int(include_self))
            if discriminator_optimizer is not None:
                discriminator_updates += 1
            # Clear the normal reconstruction gradients before the independent
            # perceptual update.  This guarantees that neither optimizer sees a
            # mixture of the two directions.
            generator_optimizer.zero_grad(set_to_none=True)
            if (clap_decoder_optimizer is not None
                    and clap_decoder_scaler is not None
                    and clap_objective is not None
                    and _clap_due(config, update_before_step)):
                _, _, separate_clap_diagnostics = _run_clap_decoder_step(
                    model, clap_decoder_optimizer, clap_decoder_scaler,
                    clap_objective, batch, config, include_self, self_scale,
                    update_before_step, rank, device,
                )
        else:
            consecutive_nonfinite += 1
            scaler.update(new_scale=max(1.0, scale_before * 0.5))
        generator_optimizer.zero_grad(set_to_none=True)
        if discriminator_optimizer is not None:
            discriminator_optimizer.zero_grad(set_to_none=True)
        loop_step += 1

        if rank == 0:
            for name, value in separate_clap_diagnostics.items():
                aggregate[name] = value.detach()
            current_metrics = dict(aggregate)
            for name, weight in reconstruction_weights.items():
                if name in aggregate:
                    sampling_scale = (self_scale if name.startswith("self_")
                                      or name in ("velocity_rank", "velocity_delta")
                                      else 1.0)
                    current_metrics[f"weighted_{name}"] = (
                        aggregate[name].detach() * weight * sampling_scale)
            for name, value in current_metrics.items():
                detached = value.detach()
                log_metric_sums[name] = (
                    log_metric_sums.get(name, detached.new_zeros(())) + detached)
                log_metric_counts[name] = log_metric_counts.get(name, 0) + 1
            log_window_updates += 1

        generator_delta = _parameter_delta(generator_tracked, generator_before)
        discriminator_delta = 0.0
        if discriminator_tracked is not None and discriminator_before is not None:
            discriminator_delta = _parameter_delta(discriminator_tracked, discriminator_before)
        scale_after = float(scaler.get_scale())
        should_log = (loop_step % config.train.log_every == 0
                      or not step_applied or generator_updates == total_updates)
        reported_activation: Tensor | None = None
        if should_log and activation_hooks:
            reported_activation = activation_run_max.detach().clone()
            if dist.is_available() and dist.is_initialized():
                dist.all_reduce(reported_activation, op=dist.ReduceOp.MAX)
        if should_log:
            torch.cuda.synchronize(device)
        if rank == 0 and should_log:
            values = {
                name: float((value / log_metric_counts[name]).float().item())
                for name, value in log_metric_sums.items()
            }
            for name, count in log_metric_counts.items():
                values[f"{name}_observations"] = count
            elapsed = time.time() - started
            effective_pairs = (generator_updates - updates_at_start) * global_pairs_per_update
            values.update({
                "loop_step": loop_step,
                "generator_updates": generator_updates,
                "discriminator_updates": discriminator_updates,
                "metrics_schema": 2,
                "metrics_aggregation": "rolling_observation_mean",
                "metric_window_updates": log_window_updates,
                "generator_step_applied": int(step_applied),
                "discriminator_step_applied": int(step_applied and discriminator is not None),
                "gradients_finite": int(step_applied),
                "rank0_gradients_finite": int(local_finite),
                "consecutive_nonfinite_updates": consecutive_nonfinite,
                "generator_grad_norm": float(generator_grad_norm.float().item()),
                "discriminator_grad_norm": (float(discriminator_grad_norm.float().item())
                                                if discriminator_grad_norm is not None else 0.0),
                "generator_parameter_delta": generator_delta,
                "discriminator_parameter_delta": discriminator_delta,
                "self_branch_executed": int(include_self),
                "self_sampling_scale": self_scale,
                "scale_before": scale_before,
                "scale_after": scale_after,
                "data_wait_ms": data_wait_seconds * 1000.0,
                "step_wall_ms": (time.perf_counter() - loop_started) * 1000.0,
                "seconds": elapsed,
                "effective_updates_per_second": generator_updates / max(1e-9, elapsed),
                "effective_pairs_per_second": effective_pairs / max(1e-9, elapsed),
                "generated_audio_seconds_per_second": (
                    executed_audio_windows * config.data.window_samples / config.data.sample_rate
                    / max(1e-9, elapsed)),
                "peak_cuda_gib": torch.cuda.max_memory_allocated(device) / 2**30,
                "peak_cuda_reserved_gib": torch.cuda.max_memory_reserved(device) / 2**30,
                "generator_lr_min": min(group["lr"] for group in generator_optimizer.param_groups),
                "generator_lr_max": max(group["lr"] for group in generator_optimizer.param_groups),
                "discriminator_lr": (discriminator_optimizer.param_groups[0]["lr"]
                                     if discriminator_optimizer is not None else 0.0),
            })
            if reported_activation is not None:
                values["residual_activation_absmax"] = float(reported_activation.item())
            with metrics_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(values, sort_keys=True) + "\n")
            assert writer is not None
            for name, value in values.items():
                if (name not in {"loop_step", "generator_updates", "discriminator_updates", "seconds"}
                        and isinstance(value, (int, float))):
                    writer.add_scalar(name, value, generator_updates)
            print(json.dumps(values, sort_keys=True), flush=True)
            log_metric_sums.clear()
            log_metric_counts.clear()
            log_window_updates = 0

        if not step_applied and consecutive_nonfinite >= max_consecutive_nonfinite:
            raise RuntimeError(
                "refusing to continue after "
                f"{consecutive_nonfinite} consecutive non-finite updates"
            )

        checkpoint_updates = set(config.train.checkpoint_updates or [])
        should_archive_checkpoint = (
            generator_updates in checkpoint_updates
            or (config.train.checkpoint_every > 0
                and generator_updates % config.train.checkpoint_every == 0)
            or generator_updates == total_updates
        )
        should_roll_checkpoint = (
            config.train.rolling_checkpoint_every > 0
            and generator_updates % config.train.rolling_checkpoint_every == 0
        )
        if step_applied and (should_archive_checkpoint or should_roll_checkpoint):
            checkpoint_path = (
                run_dir / f"step-{generator_updates:09d}.pt"
                if should_archive_checkpoint else run_dir / "latest.pt"
            )
            save_checkpoint(
                checkpoint_path, phase,
                generator_updates - 1, model, generator_optimizer, scaler, epoch,
                microbatch_offset, manifest_hash, discriminator, discriminator_optimizer,
                loop_step=loop_step, generator_updates=generator_updates,
                discriminator_updates=discriminator_updates, config_hash=config_hash,
                manifest_metadata_hash=metadata_hash,
                scheduler_state={"generator_updates": generator_updates,
                                 "lr": [group["lr"] for group in generator_optimizer.param_groups]},
                precision_state=precision_state,
                sampler_state=dataset.sampler_state_dict(),
            )
            if rank == 0 and should_archive_checkpoint and should_roll_checkpoint:
                temporary_latest = run_dir / "latest.tmp"
                shutil.copyfile(checkpoint_path, temporary_latest)
                temporary_latest.replace(run_dir / "latest.pt")

    if writer is not None:
        writer.close()
    for hook in activation_hooks:
        hook.remove()
    if world_size > 1:
        dist.barrier()
        dist.destroy_process_group()


def main() -> None:
    parser = argparse.ArgumentParser(description="MidiBrave two-phase DDP trainer")
    parser.add_argument("--config", required=True)
    parser.add_argument("--phase", type=int, choices=(1, 2), required=True)
    parser.add_argument("--max-steps", type=int)
    parser.add_argument("--max-effective-updates", type=int)
    parser.add_argument("--resume")
    args = parser.parse_args()
    if args.max_steps is not None and args.max_effective_updates is not None:
        parser.error("use only one of --max-steps and --max-effective-updates")
    limit = (args.max_effective_updates
             if args.max_effective_updates is not None else args.max_steps)
    train(args.config, args.phase, limit, args.resume)


if __name__ == "__main__":
    main()
