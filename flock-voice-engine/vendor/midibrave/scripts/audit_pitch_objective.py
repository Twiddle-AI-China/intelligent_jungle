#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import torch
from scipy.stats import spearmanr

from midibrave.config import Config
from midibrave.data import midi_to_hz
from midibrave.losses import DifferentiableCrepeObjective


def official_measurement(audio: torch.Tensor, note: int, sample_rate: int,
                         hop_length: int) -> dict[str, float]:
    import torchcrepe

    pitch, periodicity = torchcrepe.predict(
        audio.float().view(1, -1), sample_rate, hop_length,
        50.0, 2000.0, "tiny", batch_size=1024,
        device=audio.device, return_periodicity=True)
    target = midi_to_hz(torch.tensor([note], device=audio.device))[:, None]
    cents = 1200.0 * torch.log2((pitch + 1e-7) / (target + 1e-7))
    return {
        "f0_absolute_median": float(cents.abs().median().item()),
        "f0_absolute_p90": float(torch.quantile(cents.abs(), 0.9).item()),
        "periodicity_median": float(periodicity.median().item()),
        "quality_score": float((cents.abs() / 100.0 + 2.0 * (1.0 - periodicity)).median().item()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("pitch objective audit requires CUDA")

    config = Config.load(args.config)
    device = torch.device("cuda")
    objective = DifferentiableCrepeObjective(
        config.data.sample_rate, config.data.pitch_hop_length,
        config.loss.pitch_temperature, config.loss.pitch_target_sigma_cents,
        config.loss.pitch_kl, config.loss.pitch_activation,
        config.loss.pitch_hard_negative, config.loss.pitch_autocorrelation,
        config.loss.pitch_negative_margin_logits,
        config.loss.pitch_negative_exclusion_cents,
        config.loss.pitch_negative_temperature,
    ).to(device)
    sample_rate = config.data.sample_rate
    samples = config.data.window_samples
    note = 69
    time = torch.arange(samples, device=device, dtype=torch.float32) / sample_rate

    def harmonic(frequency: float) -> torch.Tensor:
        return sum((0.24 / index) * torch.sin(2 * torch.pi * frequency * index * time)
                   for index in range(1, 9)).tanh()

    target = harmonic(440.0)
    generator = torch.Generator(device=device).manual_seed(config.seed)
    noise = torch.randn(samples, generator=generator, device=device)
    noise = noise * (target.square().mean() / noise.square().mean()).sqrt()
    high_noise = torch.cat((noise[:1], noise[1:] - noise[:-1]))
    high_noise = high_noise * (target.square().mean() / high_noise.square().mean()).sqrt()
    signs = torch.randint(0, 2, (math.ceil(samples / 128),), generator=generator,
                          device=device, dtype=torch.int64).float().mul_(2).sub_(1)
    disrupted = target * signs.repeat_interleave(128)[:samples]
    signals = {
        "correct": target,
        "semitone": harmonic(440.0 * 2 ** (1 / 12)),
        "octave": harmonic(880.0),
        "rms_noise": noise,
        "high_noise": high_noise,
        "phase_disrupted": disrupted,
        "silence": torch.zeros_like(target),
    }
    names = list(signals)
    generated = torch.stack([signals[name] for name in names]).unsqueeze(1).requires_grad_()
    targets = target.expand(len(names), -1).unsqueeze(1)
    notes = torch.full((len(names),), note, device=device, dtype=torch.long)
    pitch_frames = samples // config.data.pitch_hop_length
    confidence = torch.full((len(names), pitch_frames), 0.9, device=device)
    valid = torch.ones(len(names), pitch_frames, device=device, dtype=torch.bool)
    components = objective.forward_group_components(
        [(generated, targets, notes, confidence, valid)])[0]
    components["total"].backward()
    if generated.grad is None or not torch.isfinite(generated.grad).all():
        raise RuntimeError("pitch objective produced missing or non-finite waveform gradients")

    rows = []
    # Re-evaluate each item independently so the report exposes per-signal loss.
    for index, name in enumerate(names):
        item_components = objective.forward_group_components([(
            generated[index:index + 1].detach(), targets[index:index + 1],
            notes[index:index + 1], confidence[index:index + 1], valid[index:index + 1],
        )])[0]
        official = official_measurement(signals[name], note, sample_rate,
                                        config.data.pitch_hop_length)
        rows.append({
            "signal": name,
            **{key: float(value.detach().item()) for key, value in item_components.items()},
            **official,
            "gradient_l1": float(generated.grad[index].abs().sum().item()),
        })

    by_name = {row["signal"]: row for row in rows}
    expected = []
    for wrong in ("semitone", "octave", "rms_noise", "high_noise",
                  "phase_disrupted", "silence"):
        expected.append({
            "comparison": f"correct<{wrong}",
            "pass": by_name["correct"]["total"] < by_name[wrong]["total"],
            "correct": by_name["correct"]["total"],
            "wrong": by_name[wrong]["total"],
        })

    # An offline F0 estimate is not meaningful once periodicity collapses: the
    # decoder still emits a numeric bin, but its small differences are random.
    # Rank voiced pitch errors and put every low-periodicity artifact in the
    # same worst-quality bucket instead of overfitting those invalid F0 values.
    for row in rows:
        if row["periodicity_median"] < 0.1:
            row["quality_bucket"] = 3
        elif row["f0_absolute_median"] > 600.0:
            row["quality_bucket"] = 2
        elif row["f0_absolute_median"] > 50.0:
            row["quality_bucket"] = 1
        else:
            row["quality_bucket"] = 0
    expected.extend({
        "comparison": f"octave<{wrong}",
        "pass": by_name["octave"]["total"] < by_name[wrong]["total"],
        "correct": by_name["octave"]["total"],
        "wrong": by_name[wrong]["total"],
    } for wrong in ("rms_noise", "high_noise", "phase_disrupted", "silence"))
    correlation = float(spearmanr(
        [row["total"] for row in rows],
        [row["quality_bucket"] for row in rows],
    ).statistic)
    passed = all(item["pass"] for item in expected) and correlation >= 0.90
    report = {
        "schema": 1,
        "config": str(Path(args.config).resolve()),
        "rows": rows,
        "comparisons": expected,
        "spearman": correlation,
        "spearman_gate": 0.90,
        "pass": passed,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))
    if not passed:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
