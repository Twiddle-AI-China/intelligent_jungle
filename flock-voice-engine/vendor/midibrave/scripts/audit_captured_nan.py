#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Iterable

import torch
from torch import Tensor
from torch.nn import functional as F

from midibrave.config import Config
from midibrave.losses import (MultiBandSTFTLoss, MultiResolutionSTFTLoss,
                              ReconstructionLoss)
from midibrave.model import MidiBrave


def move(batch: dict[str, Any], device: torch.device) -> dict[str, Any]:
    return {name: value.to(device) if isinstance(value, Tensor) else value
            for name, value in batch.items()}


def tensor_stats(value: Tensor | None) -> dict[str, Any] | None:
    if value is None:
        return None
    item = value.detach().float()
    mask = torch.isfinite(item)
    valid = item[mask]
    return {
        "shape": list(item.shape),
        "finite": bool(mask.all().item()),
        "nonfinite": int((~mask).sum().item()),
        "maximum_absolute": float(valid.abs().max().item()) if valid.numel() else None,
        "rms": float(valid.square().mean().sqrt().item()) if valid.numel() else None,
    }


def per_sample_audio_stats(value: Tensor | None) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    audio = value.detach().float().flatten(1)
    rows = []
    for index, item in enumerate(audio):
        finite = torch.isfinite(item)
        valid = item[finite]
        rows.append({
            "index": index,
            "finite": bool(finite.all().item()),
            "nonfinite": int((~finite).sum().item()),
            "maximum_absolute": float(valid.abs().max().item()) if valid.numel() else None,
            "rms": float(valid.square().mean().sqrt().item()) if valid.numel() else None,
        })
    return rows


def gradient_stats(parameters: Iterable[tuple[str, Tensor]]) -> dict[str, Any]:
    bad = []
    finite_norms = []
    squared = maximum = 0.0
    tensors = elements = 0
    for name, parameter in parameters:
        gradient = parameter.grad
        if gradient is None:
            continue
        item = gradient.detach().float()
        tensors += 1
        elements += item.numel()
        if not torch.isfinite(item).all():
            bad.append(name)
            continue
        l2 = float(item.square().sum().item())
        item_maximum = float(item.abs().max().item())
        squared += l2
        maximum = max(maximum, item_maximum)
        finite_norms.append({"name": name, "l2": math.sqrt(l2),
                             "maximum_absolute": item_maximum})
    return {
        "finite": not bad,
        "bad_parameters": bad,
        "gradient_tensors": tensors,
        "gradient_elements": elements,
        "finite_l2_norm": math.sqrt(squared),
        "finite_maximum_absolute": maximum,
        "largest_finite_parameter_gradients": sorted(
            finite_norms, key=lambda item: item["l2"], reverse=True)[:20],
    }


def parameter_stats(model: MidiBrave) -> dict[str, Any]:
    rows = []
    nonfinite = []
    for name, parameter in model.named_parameters():
        item = parameter.detach().float()
        if not bool(torch.isfinite(item).all().item()):
            nonfinite.append(name)
            continue
        rows.append({
            "name": name,
            "l2": float(item.square().sum().sqrt().item()),
            "maximum_absolute": float(item.abs().max().item()),
        })
    return {
        "finite": not nonfinite,
        "nonfinite": nonfinite,
        "largest_l2": sorted(rows, key=lambda item: item["l2"], reverse=True)[:30],
        "largest_absolute": sorted(
            rows, key=lambda item: item["maximum_absolute"], reverse=True)[:30],
        "film_affines": [item for item in rows if ".film.affine." in item["name"]],
    }


def output_tensors(value: Any) -> Iterable[Tensor]:
    if isinstance(value, Tensor):
        yield value
    elif isinstance(value, (tuple, list)):
        for item in value:
            yield from output_tensors(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from output_tensors(item)


def install_activation_audit(model: MidiBrave) -> tuple[list[Any], dict[str, Any]]:
    records: dict[str, Any] = {}
    handles = []

    def hook(name: str):
        def record(_module: torch.nn.Module, _inputs: tuple[Any, ...], output: Any) -> None:
            tensors = list(output_tensors(output))
            if not tensors:
                return
            call = {"tensors": [tensor_stats(item) for item in tensors]}
            records.setdefault(name, []).append(call)
        return record

    for name, module in model.named_modules():
        if name:
            handles.append(module.register_forward_hook(hook(name)))
    return handles, records


def build(config: Config, state: dict[str, Any], device: torch.device) -> MidiBrave:
    model = MidiBrave(config.model, config.data.window_samples,
                      config.data.sample_rate).to(device)
    model.load_state_dict(state["model"])
    model.train()
    model.prepare_runtime_caches()
    return model


def weighted_subset(losses: Any, weights: dict[str, float], names: set[str],
                    self_scale: float) -> Tensor:
    total = losses.total.new_zeros(())
    for name in names:
        if name not in losses.values:
            continue
        sampling = (self_scale if name.startswith("self_")
                    or name in {"velocity_rank", "velocity_delta"} else 1.0)
        total = total + losses.values[name] * weights[name] * sampling
    return total


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--batch", required=True)
    parser.add_argument("--failure-json", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("captured NaN audit requires CUDA")

    device = torch.device("cuda")
    config = Config.load(args.config)
    state = torch.load(args.state, map_location="cpu", weights_only=False)
    batch = move(torch.load(args.batch, map_location="cpu", weights_only=False), device)
    failure = json.loads(Path(args.failure_json).read_text(encoding="utf-8"))
    include_self = bool(failure["include_self"])
    self_scale = float(failure["self_scale"])
    loss_scale = float(failure["scaler"])
    reconstruction = ReconstructionLoss(
        config.loss, config.data.sample_rate, config.model.pitch_backend,
        config.data.pitch_hop_length, config.model.pqmf_bands,
        config.model.pqmf_taps,
    ).to(device)

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
    model = build(config, state, device)
    activation_handles, activations = install_activation_audit(model)
    with torch.autocast("cuda", dtype=torch.float16):
        output = model(
            batch["clap_a"], batch["note_a"], batch["velocity_a"],
            batch["note_b"], batch["velocity_b"], batch["clap_b"],
            grl_scale=1.0, include_self=include_self,
        )
        losses = reconstruction(output, batch, output.target_timbre, True,
                                self_scale=self_scale)
    for handle in activation_handles:
        handle.remove()
    first_nonfinite_activation = None
    for module_name, calls in activations.items():
        if any(not tensor["finite"] for call in calls for tensor in call["tensors"]):
            first_nonfinite_activation = module_name
            break
    forward = {
        "total": float(losses.total.detach().float().item()),
        "total_finite": bool(torch.isfinite(losses.total).item()),
        "self_audio": tensor_stats(output.self_audio),
        "cross_audio": tensor_stats(output.cross_audio),
        "self_audio_by_sample": per_sample_audio_stats(output.self_audio),
        "cross_audio_by_sample": per_sample_audio_stats(output.cross_audio),
        "terms": {name: float(value.detach().float().item())
                  for name, value in losses.values.items()},
        "first_nonfinite_activation": first_nonfinite_activation,
        "activations": activations,
    }
    captured_self_audio = (output.self_audio.detach()
                           if output.self_audio is not None else None)
    captured_cross_audio = output.cross_audio.detach()
    captured_parameter_stats = parameter_stats(model)
    # The first forward graph is only needed for diagnostics above. Keeping it
    # alive while creating one fresh model per loss term causes avoidable V100
    # memory pressure and can hide the original numerical failure behind OOM.
    del losses, output, model
    torch.cuda.empty_cache()

    # Repeat each weighted base term on a fresh graph. This separates a bad
    # loss backward from a bad decoder backward and avoids one term poisoning
    # gradient buffers used by the next term.
    per_term: dict[str, Any] = {}
    torch.autograd.set_detect_anomaly(True, check_nan=True)
    for name, weight in weights.items():
        if name.startswith("self_") and not include_self:
            continue
        term_model = build(config, state, device)
        term_parameters = [(name, parameter) for name, parameter in term_model.named_parameters()
                           if parameter.requires_grad]
        term_reconstruction = ReconstructionLoss(
            config.loss, config.data.sample_rate, config.model.pitch_backend,
            config.data.pitch_hop_length, config.model.pqmf_bands,
            config.model.pqmf_taps,
        ).to(device)
        value = None
        try:
            with torch.autocast("cuda", dtype=torch.float16):
                term_output = term_model(
                    batch["clap_a"], batch["note_a"], batch["velocity_a"],
                    batch["note_b"], batch["velocity_b"], batch["clap_b"],
                    grl_scale=1.0, include_self=include_self,
                )
                term_losses = term_reconstruction(
                    term_output, batch, term_output.target_timbre, True,
                    self_scale=self_scale,
                )
                sampling = (self_scale if name.startswith("self_")
                            or name in {"velocity_rank", "velocity_delta"} else 1.0)
                value = term_losses.values[name] * weight * sampling
            (value * loss_scale).backward()
            per_term[name] = {
                "value": float(value.detach().float().item()),
                "scaled_value": float((value.detach().float() * loss_scale).item()),
                "parameter_gradients": gradient_stats(term_parameters),
                "error": None,
            }
        except RuntimeError as error:
            per_term[name] = {
                "value": (float(value.detach().float().item()) if value is not None else None),
                "parameter_gradients": gradient_stats(term_parameters),
                "error": str(error),
            }
        finally:
            del term_model, term_reconstruction, term_parameters
            if "term_output" in locals():
                del term_output
            if "term_losses" in locals():
                del term_losses
            if value is not None:
                del value
            torch.cuda.empty_cache()

    base_names = set(weights)
    combination_names = {
        "full": base_names,
        "without_pitch": base_names - {"self_pitch", "cross_pitch"},
        "without_stft": base_names - {"self_stft", "cross_stft"},
        "pitch_only": {"self_pitch", "cross_pitch"},
        "stft_only": {"self_stft", "cross_stft"},
        "spectral_time": {
            "self_stft", "self_envelope", "self_rms",
            "cross_stft", "cross_envelope", "cross_rms",
        },
        "self_objectives": {
            "self_stft", "self_envelope", "self_pitch", "self_rms",
            "velocity_rank", "velocity_delta",
        },
        "cross_and_latent_objectives": {
            "cross_stft", "cross_envelope", "cross_pitch", "cross_rms",
            "timbre_pair", "distribution", "pitch_adversary",
        },
    }
    combinations: dict[str, Any] = {}
    for combination_name, selected_names in combination_names.items():
        combination_model = build(config, state, device)
        combination_parameters = [
            (name, parameter) for name, parameter in combination_model.named_parameters()
            if parameter.requires_grad
        ]
        combination_reconstruction = ReconstructionLoss(
            config.loss, config.data.sample_rate, config.model.pitch_backend,
            config.data.pitch_hop_length, config.model.pqmf_bands,
            config.model.pqmf_taps,
        ).to(device)
        value = None
        error_text = None
        try:
            with torch.autocast("cuda", dtype=torch.float16):
                combination_output = combination_model(
                    batch["clap_a"], batch["note_a"], batch["velocity_a"],
                    batch["note_b"], batch["velocity_b"], batch["clap_b"],
                    grl_scale=1.0, include_self=include_self,
                )
                combination_losses = combination_reconstruction(
                    combination_output, batch, combination_output.target_timbre, True,
                    self_scale=self_scale,
                )
                value = (combination_losses.total if combination_name == "full"
                         else weighted_subset(
                             combination_losses, weights, selected_names, self_scale))
            (value * loss_scale).backward()
        except RuntimeError as error:
            error_text = str(error)
        combinations[combination_name] = {
            "terms": sorted(selected_names),
            "value": (float(value.detach().float().item()) if value is not None else None),
            "scaled_value": (float((value.detach().float() * loss_scale).item())
                             if value is not None else None),
            "parameter_gradients": gradient_stats(combination_parameters),
            "error": error_text,
        }
        del combination_model, combination_parameters, combination_reconstruction
        if "combination_output" in locals():
            del combination_output
        if "combination_losses" in locals():
            del combination_losses
        if value is not None:
            del value
        torch.cuda.empty_cache()

    # Direct finite waveform gradients bypass every reconstruction objective.
    proxy_model = build(config, state, device)
    proxy_parameters = [(name, parameter) for name, parameter in proxy_model.named_parameters()
                        if parameter.requires_grad]
    proxy_error = None
    proxy = None
    try:
        with torch.autocast("cuda", dtype=torch.float16):
            proxy_output = proxy_model(
                batch["clap_a"], batch["note_a"], batch["velocity_a"],
                batch["note_b"], batch["velocity_b"], batch["clap_b"],
                grl_scale=1.0, include_self=include_self,
            )
            proxy = proxy_output.cross_audio.float().square().mean()
            if proxy_output.self_audio is not None:
                proxy = proxy + proxy_output.self_audio.float().square().mean()
        (proxy * loss_scale).backward()
    except RuntimeError as error:
        proxy_error = str(error)
    proxy_report = {
        "value": (float(proxy.detach().float().item()) if proxy is not None else None),
        "parameter_gradients": gradient_stats(proxy_parameters),
        "error": proxy_error,
    }
    del proxy_model, proxy_parameters
    if "proxy_output" in locals():
        del proxy_output
    if proxy is not None:
        del proxy
    torch.cuda.empty_cache()

    # Separate full-band and multiband STFT at the waveform boundary on the
    # captured model output, independent of decoder parameter gradients.
    stft = MultiResolutionSTFTLoss().to(device)
    multiband = MultiBandSTFTLoss(config.model.pqmf_bands,
                                  config.model.pqmf_taps).to(device)
    waveform_stft = {}
    branches = [("cross", captured_cross_audio, batch["audio_b"])]
    if captured_self_audio is not None:
        branches.insert(0, ("self", captured_self_audio, batch["audio_a"]))
    for branch, prediction, target in branches:
        for objective_name, objective in (("fullband", stft), ("multiband", multiband)):
            candidate = prediction.detach().float().requires_grad_()
            value = None
            gradient = None
            error_text = None
            try:
                value = objective(candidate, target.float())
                gradient, = torch.autograd.grad(value, candidate)
            except RuntimeError as error:
                error_text = str(error)
            waveform_stft[f"{branch}_{objective_name}"] = {
                "value": (float(value.detach().item()) if value is not None else None),
                "gradient": (tensor_stats(gradient) if gradient is not None else None),
                "error": error_text,
            }

    # Resolve a full-band aggregate failure to FFT size and component.  Each
    # probe rebuilds its graph so a failing backward cannot contaminate the
    # following probes.
    waveform_stft_resolution = {}
    for branch, prediction, target in branches:
        for fft_size in stft.fft_sizes:
            for component in ("convergence", "log_l1", "combined"):
                candidate = prediction.detach().float().requires_grad_()
                value = None
                gradient = None
                error_text = None
                try:
                    joined = torch.cat((candidate, target.float()), dim=0)
                    magnitude = stft.magnitude(joined, fft_size)
                    count = candidate.shape[0]
                    p = magnitude[:count]
                    t = magnitude[count:]
                    convergence = (torch.linalg.vector_norm(p - t)
                                   / torch.linalg.vector_norm(t).clamp_min(1e-7))
                    log_l1 = F.l1_loss(p.log(), t.log())
                    if component == "convergence":
                        value = convergence
                    elif component == "log_l1":
                        value = log_l1
                    else:
                        value = convergence + log_l1
                    gradient, = torch.autograd.grad(value, candidate)
                except RuntimeError as error:
                    error_text = str(error)
                waveform_stft_resolution[f"{branch}_{fft_size}_{component}"] = {
                    "value": (float(value.detach().item()) if value is not None else None),
                    "gradient": (tensor_stats(gradient) if gradient is not None else None),
                    "error": error_text,
                }

    report = {
        "schema": 1,
        "state": str(Path(args.state).resolve()),
        "batch": str(Path(args.batch).resolve()),
        "failure": failure,
        "captured_updates": int(state["generator_updates"]),
        "captured_loop": int(state["loop_step"]),
        "batch_tensors": {name: tensor_stats(value) for name, value in batch.items()
                          if isinstance(value, Tensor)},
        "parameters": captured_parameter_stats,
        "forward": forward,
        "per_weighted_term": per_term,
        "combinations": combinations,
        "decoder_proxy": proxy_report,
        "waveform_stft": waveform_stft,
        "waveform_stft_resolution": waveform_stft_resolution,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=True) + "\n",
                           encoding="utf-8")
    compact = {
        "forward_finite": forward["total_finite"],
        "bad_terms": [name for name, item in per_term.items()
                      if item["error"] or not item["parameter_gradients"]["finite"]],
        "bad_combinations": [name for name, item in combinations.items()
                             if item["error"] or not item["parameter_gradients"]["finite"]],
        "decoder_proxy_finite": proxy_report["parameter_gradients"]["finite"],
        "decoder_proxy_error": proxy_error,
        "stft_waveform_gradients_finite": all(
            item["error"] is None and item["gradient"] is not None
            and item["gradient"]["finite"] for item in waveform_stft.values()),
        "bad_stft_resolutions": [name for name, item in waveform_stft_resolution.items()
                                 if item["error"] is not None or item["gradient"] is None
                                 or not item["gradient"]["finite"]],
    }
    print(json.dumps(compact, sort_keys=True))


if __name__ == "__main__":
    main()
