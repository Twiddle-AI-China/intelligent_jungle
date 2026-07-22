from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F
from torch import Tensor, nn

from midibrave.model import (
    BraveDecoder,
    CausalConv1d,
    HarmonicExcitation,
    StochasticBandExcitation,
)

from .config import DataConfig, ModelConfig


class TemporalResidualBlock(nn.Module):
    def __init__(self, channels: int, dilation: int):
        super().__init__()
        self.norm1 = nn.GroupNorm(1, channels)
        self.conv1 = CausalConv1d(channels, channels, 3, dilation=dilation)
        self.norm2 = nn.GroupNorm(1, channels)
        self.conv2 = CausalConv1d(channels, channels, 3, dilation=dilation)
        nn.init.zeros_(self.conv2.weight)
        nn.init.zeros_(self.conv2.bias)

    def forward(self, x: Tensor) -> Tensor:
        residual = F.silu(self.norm1(x))
        residual = self.conv1(residual)
        residual = self.conv2(F.silu(self.norm2(residual)))
        return x + residual


class TemporalTimbreEncoder(nn.Module):
    """Causal 96D/86Hz features -> 128D/21.53Hz acoustic teacher."""

    def __init__(self, feature_dim: int = 96, channels: int = 128, output_dim: int = 128):
        super().__init__()
        self.stem = CausalConv1d(feature_dim, channels, 7)
        self.blocks = nn.ModuleList([
            TemporalResidualBlock(channels, 1),
            TemporalResidualBlock(channels, 3),
            TemporalResidualBlock(channels, 9),
            TemporalResidualBlock(channels, 27),
        ])
        self.downsample_after = {0, 1}
        self.downsamples = nn.ModuleList([
            CausalConv1d(channels, channels, 4, stride=2),
            CausalConv1d(channels, channels, 4, stride=2),
        ])
        self.norm = nn.GroupNorm(1, channels)
        self.output = nn.Conv1d(channels, output_dim, 1)

    def forward(self, features: Tensor) -> Tensor:
        x = self.stem(features)
        downsample_index = 0
        for index, block in enumerate(self.blocks):
            x = block(x)
            if index in self.downsample_after:
                x = self.downsamples[downsample_index](x)
                downsample_index += 1
        return torch.tanh(self.output(F.silu(self.norm(x))))


class FourierTimeEmbedding(nn.Module):
    def __init__(self, frequencies: int = 6):
        super().__init__()
        self.frequencies = frequencies
        values = math.pi * (2.0 ** torch.arange(frequencies, dtype=torch.float32))
        self.register_buffer("omega", values, persistent=False)

    @property
    def output_dim(self) -> int:
        return 4 + 2 * self.frequencies

    def forward(self, normalized_age: Tensor, gate: Tensor, release: Tensor) -> Tensor:
        phase = normalized_age.unsqueeze(-1) * self.omega
        onset_proximity = torch.exp(-8.0 * normalized_age)
        values = [
            normalized_age.unsqueeze(-1),
            gate.unsqueeze(-1),
            release.unsqueeze(-1),
            onset_proximity.unsqueeze(-1),
            torch.sin(phase),
            torch.cos(phase),
        ]
        return torch.cat(values, dim=-1)


class FiLMResidualMLP(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.linear1 = nn.Linear(channels, channels)
        self.linear2 = nn.Linear(channels, channels)
        nn.init.zeros_(self.linear2.weight)
        nn.init.zeros_(self.linear2.bias)

    def forward(self, x: Tensor, scale: Tensor, shift: Tensor) -> Tensor:
        conditioned = (1.0 + 0.5 * torch.tanh(scale)) * x + torch.tanh(shift)
        return x + self.linear2(F.silu(self.linear1(conditioned)))


class TrajectoryExpander(nn.Module):
    """Continuous-time 8D control coordinate -> 128D acoustic trajectory."""

    def __init__(self, control_dim: int = 8, channels: int = 128,
                 output_dim: int = 128, blocks: int = 4):
        super().__init__()
        self.time_embedding = FourierTimeEmbedding(6)
        self.time_projection = nn.Linear(self.time_embedding.output_dim, channels)
        self.coordinate_base = nn.Linear(control_dim, channels)
        self.anchor_projection = nn.Sequential(
            nn.Linear(control_dim, channels),
            nn.SiLU(),
            nn.Linear(channels, blocks * channels * 2),
        )
        self.blocks = nn.ModuleList([FiLMResidualMLP(channels) for _ in range(blocks)])
        self.gate_head = nn.Linear(channels, output_dim)
        self.release_head = nn.Linear(channels, output_dim)
        self.blocks_count = blocks
        self.channels = channels

    def _hidden(self, coordinate: Tensor, age: Tensor, gate: Tensor, release: Tensor) -> Tensor:
        # coordinate: [B, 8] or [B, T, 8]; time tensors: [B, T].
        if coordinate.ndim == 2:
            coordinate = coordinate[:, None, :].expand(-1, age.shape[1], -1)
        film = self.anchor_projection(coordinate)
        film = film.view(*film.shape[:-1], self.blocks_count, 2, self.channels)
        x = (self.time_projection(self.time_embedding(age, gate, release))
             + self.coordinate_base(coordinate))
        for index, block in enumerate(self.blocks):
            x = block(x, film[..., index, 0, :], film[..., index, 1, :])
        return x

    def forward(self, coordinate: Tensor, sample_positions: Tensor,
                data: DataConfig) -> Tensor:
        if sample_positions.ndim == 1:
            sample_positions = sample_positions[None].expand(coordinate.shape[0], -1)
        position = sample_positions.float()
        gate_duration = (data.note_off_sample - data.note_on_sample) / data.sample_rate
        release_duration = (data.render_samples - data.note_off_sample) / data.sample_rate
        note_age_seconds = ((position - data.note_on_sample) / data.sample_rate).clamp(
            0.0, gate_duration
        )
        release_age_seconds = ((position - data.note_off_sample) / data.sample_rate).clamp(
            0.0, release_duration
        )
        gate = ((position >= data.note_on_sample) & (position < data.note_off_sample)).float()
        release = (position >= data.note_off_sample).float()

        gate_age = (note_age_seconds / max(gate_duration, 1e-6)).clamp(0.0, 1.0)
        gate_hidden = self._hidden(coordinate, gate_age, gate, release * 0.0)
        gate_value = self.gate_head(gate_hidden)

        release_age = (release_age_seconds / max(release_duration, 1e-6)).clamp(0.0, 1.0)
        release_hidden = self._hidden(coordinate, release_age, gate * 0.0, release)
        release_zero_hidden = self._hidden(
            coordinate, torch.zeros_like(release_age), gate * 0.0, release
        )
        release_delta = self.release_head(release_hidden) - self.release_head(release_zero_hidden)

        # The standard render reaches note-off at normalized gate age 1.
        off_age = torch.ones_like(release_age)
        off_hidden = self._hidden(coordinate, off_age, torch.ones_like(gate), release * 0.0)
        off_value = self.gate_head(off_hidden)
        value = torch.where(release[..., None].bool(), off_value + release_delta, gate_value)
        return torch.tanh(value).transpose(1, 2)


class WeakVelocityBranch(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(1, 16), nn.SiLU(), nn.Linear(16, 4))
        nn.init.zeros_(self.net[-1].weight)
        nn.init.zeros_(self.net[-1].bias)

    def forward(self, velocity: Tensor) -> Tensor:
        return 0.1 * self.net((velocity.float() / 127.0).unsqueeze(-1))


class NoteStateConditioner(nn.Module):
    """Pitch/event condition without note_age/release_age spectral bypass."""

    def __init__(self, output_dim: int = 32):
        super().__init__()
        if output_dim != 32:
            raise ValueError("note conditioner output must be 32D")
        self.note = nn.Embedding(128, 16)
        self.event = nn.Sequential(nn.Linear(4, 32), nn.SiLU(), nn.Linear(32, 12))
        self.velocity = WeakVelocityBranch()
        self.tcn = nn.Sequential(
            CausalConv1d(32, 32, 3, dilation=1, causal_pad_mode="replicate"),
            nn.SiLU(),
            CausalConv1d(32, 32, 3, dilation=2, causal_pad_mode="replicate"),
            nn.SiLU(),
            CausalConv1d(32, 32, 3, dilation=4, causal_pad_mode="replicate"),
        )

    def forward(self, note: Tensor, velocity: Tensor, sample_positions: Tensor,
                data: DataConfig) -> Tensor:
        if sample_positions.ndim == 1:
            sample_positions = sample_positions[None].expand(note.shape[0], -1)
        note = note.long().clamp(0, 127)
        position = sample_positions
        gate = ((position >= data.note_on_sample) & (position < data.note_off_sample)).float()
        frame_span = 128
        onset = ((position <= data.note_on_sample)
                 & (position + frame_span > data.note_on_sample)).float()
        offset = ((position <= data.note_off_sample)
                  & (position + frame_span > data.note_off_sample)).float()
        normalized_note = ((note.float() - 69.0) / 48.0)[:, None].expand_as(gate)
        event = torch.stack((normalized_note, gate, onset, offset), dim=-1)
        pitch = self.note(note)[:, None, :].expand(-1, position.shape[1], -1)
        weak_velocity = self.velocity(velocity)[:, None, :].expand(-1, position.shape[1], -1)
        condition = torch.cat((pitch, self.event(event), weak_velocity), dim=-1)
        return self.tcn(condition.transpose(1, 2))


class GradientReverse(torch.autograd.Function):
    @staticmethod
    def forward(ctx: Any, value: Tensor, scale: float) -> Tensor:
        ctx.scale = scale
        return value

    @staticmethod
    def backward(ctx: Any, gradient: Tensor) -> tuple[Tensor, None]:
        return -ctx.scale * gradient, None


@dataclass
class PairOutput:
    self_audio: Tensor
    cross_audio: Tensor
    teacher_a: Tensor
    teacher_b: Tensor
    runtime: Tensor | None
    coordinates: Tensor
    pitch_logits: Tensor


class TrajectoryBrave(nn.Module):
    samples_per_latent = 128

    def __init__(self, model: ModelConfig, data: DataConfig):
        super().__init__()
        self.model_config = model
        self.data_config = data
        self.teacher = TemporalTimbreEncoder(
            model.feature_dim, model.temporal_channels, model.acoustic_dim
        )
        self.coordinates = nn.Embedding(model.num_presets, model.control_dim)
        nn.init.normal_(self.coordinates.weight, std=0.25)
        self.expander = TrajectoryExpander(
            model.control_dim, model.expander_channels, model.acoustic_dim,
            model.expander_blocks,
        )
        self.note_state = NoteStateConditioner(model.midi_dim)
        self.decoder_timbre_adapter = nn.Conv1d(
            model.acoustic_dim, model.decoder_timbre_dim, 1
        )
        nn.init.orthogonal_(self.decoder_timbre_adapter.weight)
        nn.init.zeros_(self.decoder_timbre_adapter.bias)
        self.decoder = BraveDecoder(model.brave())
        self.harmonic = HarmonicExcitation(
            data.sample_rate, model.excitation_harmonics, model.excitation_rms
        )
        self.stochastic = StochasticBandExcitation(
            model.pqmf_bands,
            data.sample_rate,
            model.pqmf_bands,
            model.stochastic_excitation_rms,
            model.stochastic_modulation_hz,
            20260721,
        )
        self.pitch_adversary = nn.Sequential(
            nn.Linear(model.acoustic_dim, 128), nn.SiLU(), nn.Linear(128, 128)
        )
        self.warmup_frames = model.warmup_latent_frames
        self.tail_frames = math.ceil((model.pqmf_taps // 2) / self.samples_per_latent)
        self.output_frames = data.window_samples // self.samples_per_latent
        self.total_frames = self.warmup_frames + self.output_frames + self.tail_frames

    def parameter_report(self) -> dict[str, int]:
        groups = {
            "temporal_encoder": self.teacher,
            "trajectory_expander": self.expander,
            "anchor_table": self.coordinates,
            "note_conditioner": self.note_state,
            "decoder_timbre_adapter": self.decoder_timbre_adapter,
            "brave_decoder": self.decoder,
            "pitch_adversary": self.pitch_adversary,
        }
        report = {name: sum(p.numel() for p in module.parameters())
                  for name, module in groups.items()}
        report["generator_total"] = sum(p.numel() for p in self.parameters())
        return report

    def control_coordinates(self, preset_index: Tensor) -> Tensor:
        return torch.tanh(self.coordinates(preset_index.long()))

    def teacher_trajectory(self, features: Tensor) -> Tensor:
        return self.teacher(features)

    def runtime_trajectory(self, preset_index: Tensor, frames: int | None = None) -> Tensor:
        frames = frames or math.ceil(self.data_config.render_samples
                                     / self.data_config.trajectory_hop)
        positions = torch.arange(frames, device=preset_index.device)
        positions = positions * self.data_config.trajectory_hop
        return self.expander(
            self.control_coordinates(preset_index), positions, self.data_config
        )

    def expand_coordinates(self, coordinates: Tensor,
                           sample_positions: Tensor) -> Tensor:
        """Expand an arbitrary 8-D control path without changing checkpoint state.

        The training/runtime preset API remains unchanged.  This inference-only
        entry point lets an interactive controller provide either one coordinate
        per voice (``[B, 8]``) or a time-varying path (``[B, T, 8]``).
        """
        if coordinates.ndim not in (2, 3):
            raise ValueError("coordinates must be [B, 8] or [B, T, 8]")
        if coordinates.shape[-1] != self.model_config.control_dim:
            raise ValueError(
                f"expected {self.model_config.control_dim}-D coordinates"
            )
        if sample_positions.ndim not in (1, 2):
            raise ValueError("sample_positions must be [T] or [B, T]")
        if coordinates.ndim == 3 and coordinates.shape[1] != sample_positions.shape[-1]:
            raise ValueError("coordinate path and sample positions must have equal length")
        return self.expander(coordinates, sample_positions, self.data_config)

    def _slice_trajectory(self, trajectory: Tensor, window_start: Tensor) -> Tensor:
        full_frames = math.ceil(self.data_config.render_samples / self.samples_per_latent)
        expanded = F.interpolate(
            trajectory.float(), size=full_frames, mode="linear", align_corners=False
        ).to(trajectory)
        base = torch.div(window_start.long(), self.samples_per_latent, rounding_mode="floor")
        base = base - self.warmup_frames
        offsets = torch.arange(self.total_frames, device=trajectory.device)
        indices = (base[:, None] + offsets[None]).clamp(0, full_frames - 1)
        return expanded.gather(2, indices[:, None].expand(-1, expanded.shape[1], -1))

    def _latent_sample_positions(self, window_start: Tensor) -> Tensor:
        offsets = torch.arange(self.total_frames, device=window_start.device)
        offsets = (offsets - self.warmup_frames) * self.samples_per_latent
        return window_start[:, None].long() + offsets[None]

    def decode(self, trajectory: Tensor, note: Tensor, velocity: Tensor,
               window_start: Tensor, excitation_seed: Tensor | None = None) -> Tensor:
        z = self._slice_trajectory(trajectory, window_start)
        positions = self._latent_sample_positions(window_start)
        note_condition = self.note_state(
            note, velocity, positions, self.data_config
        )
        total_samples = self.total_frames * self.samples_per_latent
        excitation_waveform = self.harmonic(note, total_samples)
        with torch.autocast(device_type=trajectory.device.type, enabled=False):
            excitation = self.decoder.pqmf.analysis(excitation_waveform.float())
        if self.model_config.stochastic_excitation:
            random_bands = self.stochastic(
                note.shape[0], excitation.shape[-1], note.device, excitation_seed
            )
            excitation = excitation + random_bands.float()
        decoder_timbre = self.decoder_timbre_adapter(z)
        waveform = self.decoder(decoder_timbre, note_condition, excitation, total_samples)
        start = self.warmup_frames * self.samples_per_latent
        return waveform[..., start:start + self.data_config.window_samples]

    def forward_teacher(self, batch: dict[str, Tensor], adversary_scale: float = 1.0) -> PairOutput:
        teacher_a = self.teacher_trajectory(batch["features_a"])
        teacher_b = self.teacher_trajectory(batch["features_b"])
        trajectories = torch.cat((teacher_a, teacher_a), dim=0)
        note = torch.cat((batch["note_a"], batch["note_b"]), dim=0)
        velocity = torch.cat((batch["velocity_a"], batch["velocity_b"]), dim=0)
        start = torch.cat((batch["window_start"], batch["window_start"]), dim=0)
        decoded = self.decode(trajectories, note, velocity, start)
        batch_size = teacher_a.shape[0]
        pooled = teacher_a.mean(dim=-1)
        logits = self.pitch_adversary(GradientReverse.apply(pooled, adversary_scale))
        return PairOutput(
            self_audio=decoded[:batch_size],
            cross_audio=decoded[batch_size:],
            teacher_a=teacher_a,
            teacher_b=teacher_b,
            runtime=None,
            coordinates=self.control_coordinates(batch["preset_index"]),
            pitch_logits=logits,
        )

    def forward_runtime(self, batch: dict[str, Tensor], teacher: Tensor | None = None) -> PairOutput:
        runtime = self.runtime_trajectory(
            batch["preset_index"], frames=(teacher.shape[-1] if teacher is not None else None)
        )
        trajectories = torch.cat((runtime, runtime), dim=0)
        note = torch.cat((batch["note_a"], batch["note_b"]), dim=0)
        velocity = torch.cat((batch["velocity_a"], batch["velocity_b"]), dim=0)
        start = torch.cat((batch["window_start"], batch["window_start"]), dim=0)
        decoded = self.decode(trajectories, note, velocity, start)
        batch_size = runtime.shape[0]
        if teacher is None:
            teacher = runtime.detach()
        logits = self.pitch_adversary(teacher.mean(dim=-1).detach())
        return PairOutput(
            self_audio=decoded[:batch_size],
            cross_audio=decoded[batch_size:],
            teacher_a=teacher,
            teacher_b=teacher,
            runtime=runtime,
            coordinates=self.control_coordinates(batch["preset_index"]),
            pitch_logits=logits,
        )

    def forward(self, batch: dict[str, Tensor], stage: str = "teacher"):
        """DDP-visible dispatcher for the three serial training stages."""
        if stage == "teacher":
            return self.forward_teacher(batch)
        if stage == "distill":
            with torch.no_grad():
                teacher = self.teacher_trajectory(batch["features_a"])
            runtime = self.runtime_trajectory(
                batch["preset_index"], frames=teacher.shape[-1]
            )
            return runtime, teacher, self.control_coordinates(batch["preset_index"])
        if stage == "joint":
            with torch.no_grad():
                teacher = self.teacher_trajectory(batch["features_a"])
            return self.forward_runtime(batch, teacher)
        raise ValueError(f"unsupported training stage: {stage}")

    def load_decoder_core(self, checkpoint: str | Path) -> dict[str, Any]:
        payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
        state = payload.get("model", payload.get("generator", payload))
        if not isinstance(state, dict):
            raise ValueError("checkpoint does not contain a model state dictionary")
        current = self.state_dict()
        filtered: dict[str, Tensor] = {}
        skipped: dict[str, dict[str, list[int]]] = {}
        for key, value in state.items():
            clean = key.removeprefix("module.")
            if clean.startswith("decoder."):
                if clean in current and current[clean].shape == value.shape:
                    filtered[clean] = value
                else:
                    skipped[clean] = {
                        "checkpoint": list(value.shape),
                        "current": list(current[clean].shape) if clean in current else [],
                    }
        result = self.load_state_dict(filtered, strict=False)
        if not filtered:
            raise ValueError("checkpoint has no decoder.* weights")
        loaded_parameters = sum(value.numel() for value in filtered.values())
        decoder_parameters = sum(value.numel() for value in self.decoder.state_dict().values())
        coverage = loaded_parameters / max(1, decoder_parameters)
        if coverage < 0.95:
            raise ValueError(f"decoder warm-start coverage is only {coverage:.2%}")
        return {
            "loaded_tensors": len(filtered),
            "loaded_parameter_fraction": coverage,
            "skipped": skipped,
            "missing": list(result.missing_keys),
            "unexpected": list(result.unexpected_keys),
        }
