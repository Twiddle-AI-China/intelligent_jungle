#!/usr/bin/env python3
"""Measure whether the current condition representation can predict velocity response.

The audit intentionally removes the audio decoder from the optimization problem.  It
freezes a trained checkpoint's timbre and MIDI encoders, then trains only the same
bounded output-gain head used by MidiBrave.  A train/validation gap therefore tests
cross-preset identifiability rather than waveform-loss weighting or decoder capacity.
"""
from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F
from torch import Tensor, nn

from midibrave.config import Config
from midibrave.data import PairDataset
from midibrave.model import ConditionalOutputGain, MidiBrave


@dataclass(frozen=True)
class VelocityPair:
    sample_id_a: str
    sample_id_b: str
    preset_id: str
    note: int
    velocity_a: int
    velocity_b: int
    target_delta_db: float


def complete_render_rms_db(path: Path) -> float:
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=False)
    if sample_rate != 44_100:
        raise ValueError(f"unexpected sample rate {sample_rate}: {path}")
    if audio.ndim == 2:
        if audio.shape[1] != 1:
            raise ValueError(f"expected mono audio: {path}")
        audio = audio[:, 0]
    if audio.ndim != 1 or not len(audio) or not np.isfinite(audio).all():
        raise ValueError(f"invalid audio: {path}")
    rms = math.sqrt(float(np.mean(audio.astype(np.float64) ** 2)) + 1e-8)
    return float(20.0 * math.log10(rms + 1e-7))


def pair_identity(dataset: PairDataset, index: int) -> tuple[Any, Any]:
    """Reproduce PairDataset's A/B selection without loading random crops."""
    mode = dataset.PAIR_SEQUENCE[index % len(dataset.PAIR_SEQUENCE)]
    if mode != "velocity":
        raise ValueError(f"index {index} is not a velocity-pair index")
    rng = random.Random(dataset.seed + dataset.epoch * 1_000_003 + index)
    anchors = dataset.mode_anchors[mode]
    a = anchors[rng.randrange(len(anchors))]
    candidates = dataset._candidates(a, mode)  # Audit mirrors the production sampler.
    b = candidates[rng.randrange(len(candidates))]
    if rng.random() < 0.5:
        a, b = b, a
    return a, b


def collect_pairs(config: Config, split: str, maximum: int | None,
                  required_active: int | None, rms_cache: dict[str, float]) -> list[VelocityPair]:
    data = config.data.__class__(**{
        **config.data.__dict__, "split": split, "repeats": max(4, config.data.repeats),
        "num_workers": 0,
    })
    dataset = PairDataset(data, config.seed + (991 if split == "validation" else 0))
    root = dataset.root
    output: list[VelocityPair] = []
    active = 0
    for index in range(2, len(dataset), len(PairDataset.PAIR_SEQUENCE)):
        a, b = pair_identity(dataset, index)
        for record in (a, b):
            if record.sample_id not in rms_cache:
                rms_cache[record.sample_id] = complete_render_rms_db(
                    (root / record.audio_path).resolve())
        delta = rms_cache[b.sample_id] - rms_cache[a.sample_id]
        output.append(VelocityPair(
            a.sample_id, b.sample_id, a.preset_id, a.midi_note,
            a.velocity, b.velocity, delta,
        ))
        active += int(abs(delta) >= config.loss.velocity_margin_db)
        if maximum is not None and len(output) >= maximum:
            break
        if required_active is not None and active >= required_active:
            break
    if required_active is not None and active < required_active:
        raise RuntimeError(
            f"{split} produced only {active} active pairs, expected {required_active}")
    return output


def load_clap(cache_root: Path, sample_ids: list[str]) -> Tensor:
    values = []
    for sample_id in sample_ids:
        path = cache_root / "clap" / f"{sample_id}.npy"
        value = np.load(path, allow_pickle=False).astype(np.float32)
        if value.shape != (512,) or not np.isfinite(value).all():
            raise ValueError(f"invalid CLAP cache: {path}")
        values.append(value)
    return torch.from_numpy(np.stack(values))


@torch.no_grad()
def condition_features(model: MidiBrave, pairs: list[VelocityPair], cache_root: Path,
                       device: torch.device, batch_size: int) -> tuple[Tensor, Tensor, Tensor]:
    left: list[Tensor] = []
    right: list[Tensor] = []
    targets: list[Tensor] = []
    for start in range(0, len(pairs), batch_size):
        current = pairs[start:start + batch_size]
        clap = load_clap(cache_root, [item.sample_id_a for item in current]).to(device)
        note = torch.tensor([item.note for item in current], device=device)
        velocity_a = torch.tensor(
            [item.velocity_a for item in current], device=device, dtype=torch.float32)
        velocity_b = torch.tensor(
            [item.velocity_b for item in current], device=device, dtype=torch.float32)
        z_timbre = model.timbre(clap)
        midi_a = model.midi(note, velocity_a, 1, static_condition=True)[..., 0]
        midi_b = model.midi(note, velocity_b, 1, static_condition=True)[..., 0]
        left.append(torch.cat((z_timbre, midi_a), dim=-1).float().cpu())
        right.append(torch.cat((z_timbre, midi_b), dim=-1).float().cpu())
        targets.append(torch.tensor(
            [item.target_delta_db for item in current], dtype=torch.float32))
    return torch.cat(left), torch.cat(right), torch.cat(targets)


def raw_clap_features(pairs: list[VelocityPair], cache_root: Path,
                      batch_size: int) -> tuple[Tensor, Tensor, Tensor]:
    """A deliberately stronger upper bound that bypasses the 128D timbre adapter."""
    left: list[Tensor] = []
    right: list[Tensor] = []
    targets: list[Tensor] = []
    for start in range(0, len(pairs), batch_size):
        current = pairs[start:start + batch_size]
        clap = load_clap(cache_root, [item.sample_id_a for item in current])
        note = torch.tensor([item.note for item in current], dtype=torch.float32)
        phase = 2.0 * math.pi * note / 12.0
        note_features = torch.stack((note / 127.0, phase.sin(), phase.cos()), dim=-1)
        shared = torch.cat((clap, note_features), dim=-1)
        velocity_a = torch.tensor(
            [item.velocity_a for item in current], dtype=torch.float32).unsqueeze(-1) / 127.0
        velocity_b = torch.tensor(
            [item.velocity_b for item in current], dtype=torch.float32).unsqueeze(-1) / 127.0
        left.append(torch.cat((shared, velocity_a), dim=-1))
        right.append(torch.cat((shared, velocity_b), dim=-1))
        targets.append(torch.tensor(
            [item.target_delta_db for item in current], dtype=torch.float32))
    return torch.cat(left), torch.cat(right), torch.cat(targets)


class GainProbe(nn.Module):
    def __init__(self, input_dim: int, hidden: int, max_db: float):
        super().__init__()
        # Reuse the production module so parameter count and bounded output match.
        self.gain = ConditionalOutputGain(input_dim - 1, 1, hidden, max_db)

    def scalar_gain(self, condition: Tensor) -> Tensor:
        raw = self.gain.net(condition).squeeze(-1)
        return self.gain.max_db * torch.tanh(raw)

    def forward(self, left: Tensor, right: Tensor) -> Tensor:
        return self.scalar_gain(right) - self.scalar_gain(left)


def metrics(prediction: Tensor, target: Tensor, margin: float) -> dict[str, float | int | None]:
    prediction = prediction.detach().float().cpu()
    target = target.detach().float().cpu()
    active = target.abs().ge(margin)
    prediction = prediction[active]
    target = target[active]
    directed = target.sign() * prediction
    correlation = None
    if len(target) > 1 and target.std(unbiased=False) > 0 and prediction.std(unbiased=False) > 0:
        correlation = float(torch.corrcoef(torch.stack((target, prediction)))[0, 1].item())
    return {
        "active_pairs": int(len(target)),
        "direction_accuracy": float(directed.gt(0).float().mean().item()),
        "margin_accuracy": float(directed.ge(margin).float().mean().item()),
        "delta_error_median_db": float((prediction - target).abs().median().item()),
        "prediction_absolute_median_db": float(prediction.abs().median().item()),
        "pearson_target_delta": correlation,
    }


def train_probe(train_left: Tensor, train_right: Tensor, train_target: Tensor,
                validation_left: Tensor, validation_right: Tensor,
                validation_target: Tensor, margin: float, hidden: int, max_db: float,
                steps: int, batch_size: int, seed: int, device: torch.device) -> dict[str, Any]:
    torch.manual_seed(seed)
    active = train_target.abs().ge(margin)
    train_left = train_left[active]
    train_right = train_right[active]
    train_target = train_target[active]
    combined = torch.cat((train_left, train_right), dim=0)
    mean = combined.mean(dim=0, keepdim=True)
    scale = combined.std(dim=0, unbiased=False, keepdim=True).clamp_min(1e-3)
    train_left = ((train_left - mean) / scale).to(device)
    train_right = ((train_right - mean) / scale).to(device)
    train_target = train_target.to(device)
    validation_left = ((validation_left - mean) / scale).to(device)
    validation_right = ((validation_right - mean) / scale).to(device)
    validation_target = validation_target.to(device)

    probe = GainProbe(train_left.shape[-1], hidden, max_db).to(device)
    optimizer = torch.optim.AdamW(probe.parameters(), lr=1e-3, betas=(0.8, 0.99))
    generator = torch.Generator(device="cpu").manual_seed(seed + 17)
    for step in range(steps):
        indices = torch.randint(
            len(train_target), (batch_size,), generator=generator).to(device)
        target = train_target.index_select(0, indices)
        prediction = probe(
            train_left.index_select(0, indices), train_right.index_select(0, indices))
        direction = target.sign()
        rank = F.relu(margin - direction * prediction).mean()
        delta = F.smooth_l1_loss(prediction / 6.0, target / 6.0)
        loss = rank + 2.0 * delta
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
    with torch.no_grad():
        train_prediction = probe(train_left, train_right)
        validation_prediction = probe(validation_left, validation_right)
    return {
        "seed": seed,
        "steps": steps,
        "parameters": sum(parameter.numel() for parameter in probe.parameters()),
        "train": metrics(train_prediction, train_target, margin),
        "validation": metrics(validation_prediction, validation_target, margin),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--train-pairs", type=int, default=16_384)
    parser.add_argument("--validation-active-pairs", type=int, default=64)
    parser.add_argument("--steps", type=int, default=5_000)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--seeds", type=int, default=3)
    parser.add_argument("--raw-hidden", type=int, default=256)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("velocity learnability audit requires CUDA")

    config = Config.load(args.config)
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    device = torch.device("cuda")
    model = MidiBrave(config.model, config.data.window_samples, config.data.sample_rate).to(device)
    model.load_state_dict(checkpoint["model"])
    model.eval()

    rms_cache: dict[str, float] = {}
    train_pairs = collect_pairs(config, "train", args.train_pairs, None, rms_cache)
    validation_pairs = collect_pairs(
        config, "validation", None, args.validation_active_pairs, rms_cache)
    cache_root = Path(config.data.cache_root)
    train_left, train_right, train_target = condition_features(
        model, train_pairs, cache_root, device, args.batch_size)
    validation_left, validation_right, validation_target = condition_features(
        model, validation_pairs, cache_root, device, args.batch_size)
    validation_active = validation_target.abs().ge(config.loss.velocity_margin_db)
    validation_left = validation_left[validation_active][:args.validation_active_pairs]
    validation_right = validation_right[validation_active][:args.validation_active_pairs]
    validation_target = validation_target[validation_active][:args.validation_active_pairs]

    raw_train_left, raw_train_right, raw_train_target = raw_clap_features(
        train_pairs, cache_root, args.batch_size)
    raw_validation_left, raw_validation_right, raw_validation_target = raw_clap_features(
        validation_pairs, cache_root, args.batch_size)
    raw_validation_active = raw_validation_target.abs().ge(config.loss.velocity_margin_db)
    raw_validation_left = raw_validation_left[raw_validation_active][:args.validation_active_pairs]
    raw_validation_right = raw_validation_right[raw_validation_active][:args.validation_active_pairs]
    raw_validation_target = raw_validation_target[raw_validation_active][
        :args.validation_active_pairs]

    runs = [
        train_probe(
            train_left, train_right, train_target,
            validation_left, validation_right, validation_target,
            config.loss.velocity_margin_db, config.model.condition_gain_hidden,
            config.model.condition_gain_max_db, args.steps, args.batch_size,
            config.seed + 10_000 + seed, device,
        )
        for seed in range(args.seeds)
    ]
    raw_clap_runs = [
        train_probe(
            raw_train_left, raw_train_right, raw_train_target,
            raw_validation_left, raw_validation_right, raw_validation_target,
            config.loss.velocity_margin_db, args.raw_hidden,
            config.model.condition_gain_max_db, args.steps, args.batch_size,
            config.seed + 20_000 + seed, device,
        )
        for seed in range(args.seeds)
    ]
    target_order = torch.tensor([
        (1.0 if pair.velocity_b > pair.velocity_a else -1.0) * pair.target_delta_db
        for pair in validation_pairs
        if abs(pair.target_delta_db) >= config.loss.velocity_margin_db
    ])[:args.validation_active_pairs]
    report = {
        "schema": 1,
        "purpose": "frozen-representation upper bound for cross-preset velocity response",
        "config": str(Path(args.config).resolve()),
        "checkpoint": str(Path(args.checkpoint).resolve()),
        "checkpoint_generator_updates": int(checkpoint["generator_updates"]),
        "train_pairs_collected": len(train_pairs),
        "train_active_pairs": int(train_target.abs().ge(config.loss.velocity_margin_db).sum()),
        "validation_active_pairs": len(validation_target),
        "validation_presets": len({
            pair.preset_id for pair in validation_pairs
            if abs(pair.target_delta_db) >= config.loss.velocity_margin_db
        }),
        "target_higher_velocity_louder_rate": float(target_order.gt(0).float().mean()),
        "probe_contract": {
            "inputs": "frozen checkpoint z_timbre(source CLAP) + z_midi(note, velocity)",
            "head": "same bounded 160->32->1 ConditionalOutputGain as production",
            "normalization": "train-feature mean/std",
            "loss": "ranking margin + 2 * SmoothL1(delta/6dB)",
            "decoder": "excluded",
        },
        "runs": runs,
        "raw_clap_probe_contract": {
            "inputs": "raw 512D source CLAP + normalized/cyclic note + velocity",
            "head": f"bounded 516->{args.raw_hidden}->1 gain head",
            "normalization": "train-feature mean/std",
            "loss": "ranking margin + 2 * SmoothL1(delta/6dB)",
            "decoder_and_timbre_adapter": "excluded",
        },
        "raw_clap_runs": raw_clap_runs,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
