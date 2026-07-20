#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

from midibrave.config import Config
from midibrave.losses import BraveMultiScaleDiscriminator
from midibrave.model import MidiBrave


def snr(reference: torch.Tensor, value: torch.Tensor) -> float:
    noise = (reference - value).float().square().mean().sqrt()
    signal = reference.float().square().mean().sqrt()
    return float((20.0 * torch.log10(signal / noise.clamp_min(1e-12))).item())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--safe", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("precision probe requires CUDA")
    torch.manual_seed(20260720)
    safe_cfg = Config.load(args.safe)
    candidate_cfg = Config.load(args.candidate)
    safe = MidiBrave(safe_cfg.model, safe_cfg.data.window_samples,
                     safe_cfg.data.sample_rate).cuda().eval()
    candidate = MidiBrave(candidate_cfg.model, candidate_cfg.data.window_samples,
                          candidate_cfg.data.sample_rate).cuda().eval()
    candidate.load_state_dict(safe.state_dict())
    samples = safe_cfg.data.window_samples
    audio = torch.randn(4, 1, samples, device="cuda") * 0.1
    with torch.autocast("cuda", enabled=False):
        safe_bands = safe.decoder.pqmf.analysis(audio.float())
        safe_wave = safe.decoder.pqmf.synthesis(safe_bands, samples)
    with torch.autocast("cuda", dtype=torch.float16):
        candidate_bands = candidate.decoder.pqmf.analysis(audio)
        candidate_wave = candidate.decoder.pqmf.synthesis(candidate_bands, samples)
    safe_energy = safe_bands.float().square().mean(dim=(0, 2)).clamp_min(1e-12)
    candidate_energy = candidate_bands.float().square().mean(dim=(0, 2)).clamp_min(1e-12)
    band_error = float((10.0 * torch.log10(candidate_energy / safe_energy)).abs().max().item())
    clap = torch.randn(2, safe_cfg.model.clap_dim, device="cuda")
    notes = torch.tensor([21, 109], device="cuda")
    velocities = torch.tensor([50.0, 127.0], device="cuda")
    seeds = torch.tensor([1, 2], device="cuda")
    forward = {}
    for name, model in (("safe_fallback", safe), ("fp16_candidate", candidate)):
        with torch.autocast("cuda", dtype=torch.float16):
            value = model(clap, notes, velocities, notes.flip(0), velocities.flip(0), clap,
                          source_excitation_seed=seeds,
                          target_excitation_seed=seeds.flip(0))
        tensors = [value.self_audio, value.cross_audio, value.timbre, value.pitch_logits]
        forward[name] = {"finite": all(torch.isfinite(item).all().item() for item in tensors),
                         "peak": max(float(item.float().abs().max().item()) for item in tensors)}
    report = {
        "schema": 1,
        "generator_parameters": sum(item.numel() for item in safe.parameters()),
        "discriminator_parameters": sum(item.numel() for item in BraveMultiScaleDiscriminator().parameters()),
        "pqmf_snr_db": snr(safe_wave, candidate_wave.float()),
        "pqmf_band_energy_error_db": band_error,
        "forward_extremes": forward,
    }
    report["safe_runtime_passed"] = bool(forward["safe_fallback"]["finite"])
    report["candidate_precision_passed"] = bool(
        forward["fp16_candidate"]["finite"]
        and report["pqmf_snr_db"] >= 60.0
        and report["pqmf_band_energy_error_db"] < 0.1
    )
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    # A failed candidate is evidence for selecting safe_fallback, not a reason to
    # block the safe run.  Only failure of the safe policy itself is fatal here;
    # candidate precision/finite status remains an explicit qualification input.
    if not report["safe_runtime_passed"]:
        raise SystemExit("safe_fallback runtime probe failed")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
