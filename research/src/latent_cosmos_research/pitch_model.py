from __future__ import annotations

import math

import torch
from torch import nn
from torch.nn import functional as F


class HarmonicExcitation(nn.Module):
    """TorchScript-friendly implementation of the P-RAVE excitation equations.

    Input channels are f0_hz, target RMS loudness, gate and periodicity at
    latent rate (pitch-conditioning-v2). Periodicity blends the harmonic
    oscillator against the noise source; setting it to 1 on voiced frames and
    0 on unvoiced frames reproduces the v1 behaviour exactly, so inharmonic
    timbres get a noise-dominated excitation instead of a forced oscillator.
    Phase is explicit input/output state so separate realtime decoder sessions do
    not share hidden oscillator state.
    """

    def __init__(self, sample_rate: int = 44_100, samples_per_frame: int = 128, max_harmonics: int = 256, epsilon: float = 1e-5) -> None:
        super().__init__()
        if sample_rate <= 0 or samples_per_frame <= 0 or max_harmonics <= 0:
            raise ValueError("sample rate, frame size and harmonic count must be positive")
        self.sample_rate = sample_rate
        self.samples_per_frame = samples_per_frame
        self.max_harmonics = max_harmonics
        self.epsilon = epsilon
        self.register_buffer("harmonics", torch.arange(1, max_harmonics + 1, dtype=torch.float32).reshape(1, -1, 1))

    def forward(self, conditioning: torch.Tensor, initial_phase: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        if conditioning.ndim != 3 or conditioning.shape[1] != 4:
            raise ValueError("conditioning must have shape [batch, 4, frames]")
        if initial_phase.ndim != 1 or initial_phase.shape[0] != conditioning.shape[0]:
            raise ValueError("initial_phase must have shape [batch]")

        f0 = conditioning[:, 0].clamp(0.0, self.sample_rate / 2.0)
        loudness = conditioning[:, 1].clamp(0.0, 1.0)
        gate = conditioning[:, 2].clamp(0.0, 1.0)
        periodicity = conditioning[:, 3].clamp(0.0, 1.0)
        f0_audio = f0.repeat_interleave(self.samples_per_frame, dim=-1)
        mix = periodicity.repeat_interleave(self.samples_per_frame, dim=-1)
        phase_increment = 2.0 * math.pi * f0_audio / float(self.sample_rate)
        phase = initial_phase[:, None] + torch.cumsum(phase_increment, dim=-1)

        harmonic_numbers = self.harmonics.to(dtype=conditioning.dtype, device=conditioning.device)
        harmonic_frequency = harmonic_numbers * f0_audio[:, None, :]
        harmonic_mask = (harmonic_frequency <= self.sample_rate / 2.0) & (f0_audio[:, None, :] > 0.0)
        periodic = (torch.sin(harmonic_numbers * phase[:, None, :]) / harmonic_numbers * harmonic_mask).sum(dim=1)
        excitation = mix * periodic + (1.0 - mix) * torch.randn_like(periodic)

        frame_count = conditioning.shape[-1]
        framed = excitation.reshape(conditioning.shape[0], frame_count, self.samples_per_frame)
        measured_rms = torch.sqrt(torch.mean(torch.square(framed), dim=-1) + 1e-12)
        target_rms = loudness * gate
        gain = (target_rms + self.epsilon) / (measured_rms + self.epsilon)
        output = (framed * gain[:, :, None]).reshape(conditioning.shape[0], 1, -1)
        final_phase = torch.remainder(phase[:, -1], 2.0 * math.pi)
        return output, final_phase


class FiLMConditioner(nn.Module):
    """One causal-safe 1x1 FiLM site initialized as an exact pass-through."""

    def __init__(self, condition_channels: int, feature_channels: int) -> None:
        super().__init__()
        if condition_channels <= 0 or feature_channels <= 0:
            raise ValueError("channel counts must be positive")
        self.feature_channels = feature_channels
        self.projection = nn.Conv1d(condition_channels, feature_channels * 2, 1)
        nn.init.zeros_(self.projection.weight)
        nn.init.zeros_(self.projection.bias)
        with torch.no_grad():
            self.projection.bias[:feature_channels].fill_(1.0)

    def forward(self, features: torch.Tensor, condition: torch.Tensor) -> torch.Tensor:
        if features.ndim != 3 or condition.ndim != 3:
            raise ValueError("features and condition must be [batch, channels, frames]")
        if condition.shape[-1] != features.shape[-1]:
            condition = F.interpolate(condition, size=features.shape[-1], mode="nearest")
        gamma_beta = self.projection(condition)
        gamma, beta = torch.split(gamma_beta, self.feature_channels, dim=1)
        return gamma * features + beta
