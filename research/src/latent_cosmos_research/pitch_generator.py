from __future__ import annotations

from functools import reduce
from operator import mul
from typing import List, Sequence

import cached_conv as cc
import torch
from rave import blocks
from torch import nn

from .pitch_model import FiLMConditioner


class AlignedFiLMConditioner(nn.Module):
    """Align a zero-delay control path with a cached-conv generator stage.

    Composes FiLMConditioner instead of inheriting so the module stays
    TorchScript-compatible (scripted methods cannot call super().forward).
    """

    def __init__(self, condition_channels: int, feature_channels: int, feature_delay: int) -> None:
        super().__init__()
        self.film = FiLMConditioner(condition_channels, feature_channels)
        self.alignment = cc.CachedPadding1d(feature_delay, crop=True) if feature_delay else nn.Identity()
        self.feature_delay = feature_delay

    def forward(self, features: torch.Tensor, condition: torch.Tensor) -> torch.Tensor:
        return self.film(features, self.alignment(condition))


class ConditionedGeneratorStage(nn.Module):
    """One upsample stage with its FiLM site, iterable as a single ModuleList."""

    def __init__(self, upsample: nn.Module, film: AlignedFiLMConditioner, residual: nn.Module) -> None:
        super().__init__()
        self.upsample = upsample
        self.film = film
        self.residual = residual

    def forward(self, features: torch.Tensor, condition: torch.Tensor) -> torch.Tensor:
        return self.residual(self.film(self.upsample(features), condition))


class PitchConditionedGenerator(nn.Module):
    """BRAVE v1 generator with P-RAVE-style multi-band FiLM sites.

    `excitation` is already in PQMF bands and at the generator output rate.
    Its trainable downsampling pyramid keeps a constant band count, while each
    1x1 projection produces gamma/beta for the matching upsampling stage.
    """

    def __init__(
        self,
        latent_size: int,
        capacity: int,
        data_size: int,
        ratios: Sequence[int],
        loud_stride: int,
        use_noise: bool,
        n_channels: int = 1,
    ) -> None:
        super().__init__()
        if use_noise:
            raise ValueError("BRAVE pitch pilot requires use_noise=False")
        if not ratios or any(ratio <= 0 for ratio in ratios):
            raise ValueError("ratios must be positive")

        self.ratios = list(ratios)
        self.condition_channels = data_size * n_channels
        initial_channels = 2 ** len(ratios) * capacity
        self.initial = blocks.normalization(
            cc.Conv1d(latent_size, initial_channels, 7, padding=cc.get_padding(7))
        )

        self.stages = nn.ModuleList()
        cumulative_delay = self.initial.cumulative_delay
        output_channels = initial_channels
        for index, ratio in enumerate(ratios):
            input_channels = 2 ** (len(ratios) - index) * capacity
            output_channels = 2 ** (len(ratios) - index - 1) * capacity
            upsample = blocks.UpsampleLayer(input_channels, output_channels, ratio, cumulative_delay=cumulative_delay)
            residual = blocks.ResidualStack(output_channels, cumulative_delay=upsample.cumulative_delay)
            film = AlignedFiLMConditioner(self.condition_channels, output_channels, upsample.cumulative_delay)
            self.stages.append(ConditionedGeneratorStage(upsample, film, residual))
            cumulative_delay = residual.cumulative_delay

        # Registered in application order: downsamplers[0] maps the excitation
        # (deepest level) one stage up, so conditioning_levels can iterate the
        # ModuleList forward, which TorchScript supports.
        self.condition_downsamplers = nn.ModuleList()
        for next_ratio in reversed(list(ratios)[1:]):
            kernel_size = 1 if next_ratio == 1 else 2 * next_ratio
            self.condition_downsamplers.append(
                cc.Conv1d(
                    self.condition_channels,
                    self.condition_channels,
                    kernel_size,
                    stride=next_ratio,
                    padding=cc.get_padding(kernel_size, next_ratio),
                )
            )

        waveform = blocks.normalization(
            cc.Conv1d(output_channels, data_size * n_channels, 7, padding=cc.get_padding(7))
        )
        loudness = blocks.normalization(
            cc.Conv1d(
                output_channels,
                1,
                2 * loud_stride + 1,
                stride=loud_stride,
                padding=cc.get_padding(2 * loud_stride + 1, loud_stride),
            )
        )
        self.synth = cc.AlignBranches(waveform, loudness, cumulative_delay=cumulative_delay)
        self.loud_stride = loud_stride
        self.cumulative_delay = self.synth.cumulative_delay
        self.output_ratio = reduce(mul, ratios, 1)
        self.register_buffer("warmed_up", torch.tensor(0))

    @property
    @torch.jit.unused
    def upsamples(self) -> list[nn.Module]:
        return [stage.upsample for stage in self.stages]

    @property
    @torch.jit.unused
    def film_sites(self) -> list[AlignedFiLMConditioner]:
        return [stage.film for stage in self.stages]

    @property
    @torch.jit.unused
    def residuals(self) -> list[nn.Module]:
        return [stage.residual for stage in self.stages]

    def set_warmed_up(self, state: bool) -> None:
        self.warmed_up = torch.tensor(int(state), device=self.warmed_up.device)

    def conditioning_levels(self, excitation: torch.Tensor) -> List[torch.Tensor]:
        if excitation.ndim != 3 or excitation.shape[1] != self.condition_channels:
            raise ValueError("excitation must be [batch, pqmf_bands, frames]")
        levels: List[torch.Tensor] = [excitation]
        current = excitation
        for downsampler in self.condition_downsamplers:
            current = downsampler(current)
            levels.insert(0, current)
        return levels

    def forward(self, latent: torch.Tensor, excitation: torch.Tensor) -> torch.Tensor:
        expected = latent.shape[-1] * self.output_ratio
        if excitation.shape[-1] != expected:
            raise ValueError("excitation rate does not match latent and generator ratios")
        levels = self.conditioning_levels(excitation)
        features = self.initial(latent)
        index = 0
        for stage in self.stages:
            features = stage(features, levels[index])
            index += 1

        waveform, loudness = self.synth(features)
        if self.loud_stride != 1:
            loudness = loudness.repeat_interleave(self.loud_stride, dim=-1)
        loudness = loudness.reshape(features.shape[0], 1, -1)
        return torch.tanh(waveform) * blocks.mod_sigmoid(loudness)
