#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
import time
from typing import Callable

import torch
from torch import Tensor, nn
from torch.nn import functional as F

from midibrave.losses import (BraveMultiScaleDiscriminator, discriminator_hinge,
                              feature_matching, generator_adversarial)


class LegacyScaleDiscriminator(nn.Module):
    def __init__(self):
        super().__init__()
        channels = (1, 32, 128, 512, 1024)
        self.layers = nn.ModuleList([
            nn.Conv1d(channels[index], channels[index + 1], 15 if index == 0 else 41,
                      stride=1 if index == 0 else 4,
                      padding=7 if index == 0 else 20,
                      groups=1 if index < 2 else 4)
            for index in range(len(channels) - 1)
        ])
        self.output = nn.Conv1d(channels[-1], 1, 3, padding=1)

    def forward(self, value: Tensor):
        features = []
        for layer in self.layers:
            value = F.leaky_relu(layer(value), 0.2)
            features.append(value)
        return self.output(value), features


class LegacyPeriodDiscriminator(nn.Module):
    def __init__(self, period: int):
        super().__init__()
        self.period = period
        channels = (1, 32, 128, 512, 1024)
        self.layers = nn.ModuleList([
            nn.Conv2d(channels[index], channels[index + 1], (5, 1), (3, 1), padding=(2, 0))
            for index in range(len(channels) - 1)
        ])
        self.output = nn.Conv2d(channels[-1], 1, (3, 1), padding=(1, 0))

    def forward(self, value: Tensor):
        remainder = value.shape[-1] % self.period
        if remainder:
            value = F.pad(value, (0, self.period - remainder), mode="reflect")
        value = value.view(value.shape[0], 1, value.shape[-1] // self.period, self.period)
        features = []
        for layer in self.layers:
            value = F.leaky_relu(layer(value), 0.2)
            features.append(value)
        return self.output(value).flatten(1), features


class LegacyMultiScalePeriodDiscriminator(nn.Module):
    architecture_id = "legacy_scale_period_v1"

    def __init__(self):
        super().__init__()
        self.scales = nn.ModuleList([LegacyScaleDiscriminator() for _ in range(3)])
        self.periods = nn.ModuleList([
            LegacyPeriodDiscriminator(period) for period in (2, 3, 5, 7, 11)
        ])

    def forward(self, value: Tensor):
        outputs = []
        scaled = value
        for index, discriminator in enumerate(self.scales):
            if index:
                scaled = F.avg_pool1d(scaled, 4, 2, 1)
            outputs.append(discriminator(scaled))
        outputs.extend(discriminator(value) for discriminator in self.periods)
        return outputs


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * fraction))]


def benchmark(name: str, constructor: Callable[[], nn.Module], batch: int,
              samples: int, warmup: int, iterations: int) -> dict[str, float | int | str]:
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    discriminator = constructor().cuda().train()
    optimizer = torch.optim.AdamW(discriminator.parameters(), lr=2e-4, betas=(0.5, 0.9))
    real = torch.randn(batch, 1, samples, device="cuda").tanh()
    fake_source = torch.randn(batch, 1, samples, device="cuda")
    timings: list[float] = []
    for index in range(warmup + iterations):
        torch.cuda.synchronize()
        started = time.perf_counter()
        optimizer.zero_grad(set_to_none=True)
        fake = fake_source.detach().clone().requires_grad_(True).tanh()
        discriminator.requires_grad_(False)
        with torch.autocast("cuda", dtype=torch.float16):
            with torch.no_grad():
                real_for_generator = discriminator(real)
            fake_for_generator = discriminator(fake)
            generator_loss = (generator_adversarial(fake_for_generator)
                              + 2.0 * feature_matching(real_for_generator, fake_for_generator))
        generator_loss.backward()
        discriminator.requires_grad_(True)
        with torch.autocast("cuda", dtype=torch.float16):
            real_for_discriminator = discriminator(real)
            fake_for_discriminator = discriminator(fake.detach())
            discriminator_loss = discriminator_hinge(
                real_for_discriminator, fake_for_discriminator)
        discriminator_loss.backward()
        optimizer.step()
        torch.cuda.synchronize()
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        if index >= warmup:
            timings.append(elapsed_ms)
    result: dict[str, float | int | str] = {
        "architecture": name,
        "parameters": sum(parameter.numel() for parameter in discriminator.parameters()),
        "median_ms": statistics.median(timings),
        "p90_ms": percentile(timings, 0.9),
        "peak_cuda_gib": torch.cuda.max_memory_allocated() / 2**30,
        "batch": batch,
        "samples": samples,
        "iterations": iterations,
    }
    del discriminator, optimizer, real, fake_source
    torch.cuda.empty_cache()
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", type=int, default=2)
    parser.add_argument("--samples", type=int, default=65536)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--iterations", type=int, default=20)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required")
    results = [
        benchmark("legacy_scale_period_v1", LegacyMultiScalePeriodDiscriminator,
                  args.batch, args.samples, args.warmup, args.iterations),
        benchmark("brave_multiscale_v1", BraveMultiScaleDiscriminator,
                  args.batch, args.samples, args.warmup, args.iterations),
    ]
    print(json.dumps({"results": results}, sort_keys=True))


if __name__ == "__main__":
    main()
