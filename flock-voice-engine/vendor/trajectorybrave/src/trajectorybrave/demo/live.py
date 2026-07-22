from __future__ import annotations

import hashlib
import inspect
import math
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
import torch
from torch import Tensor
from torch.nn import functional as F

from trajectorybrave.config import Config, DataConfig
from trajectorybrave.model import TrajectoryBrave


TrajectoryMode = Literal["natural", "static", "static_mean"]


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class RuntimeModel:
    model: TrajectoryBrave
    config: Config
    anchors: np.ndarray
    checkpoint: dict[str, Any]


def load_runtime_model(
    config_path: str | Path,
    checkpoint_path: str | Path,
    device: str | torch.device,
    expected_sha256: str | None = None,
) -> RuntimeModel:
    config = Config.load(config_path)
    checkpoint_path = Path(checkpoint_path)
    actual_hash = sha256_file(checkpoint_path)
    if expected_sha256 and actual_hash.lower() != expected_sha256.lower():
        raise ValueError(f"checkpoint SHA-256 mismatch: {actual_hash}")

    payload = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    if payload.get("format") != "trajectorybrave.checkpoint.v1":
        raise ValueError("not a TrajectoryBrave v1 checkpoint")
    if payload.get("stage") != "joint" or int(payload.get("step", -1)) != 35000:
        raise ValueError(
            f"expected joint step 35000, got {payload.get('stage')} {payload.get('step')}"
        )

    model = TrajectoryBrave(config.model, config.data)
    missing, unexpected = model.load_state_dict(payload["model"], strict=True)
    if missing or unexpected:
        raise ValueError(f"checkpoint mismatch: missing={missing}, unexpected={unexpected}")
    model.requires_grad_(False).eval()
    target_device = torch.device(device)
    anchors = model.control_coordinates(
        torch.arange(config.model.num_presets)
    ).detach().float().cpu().numpy()
    # The browser path never calls the teacher encoder, pitch adversary, or
    # embedding lookup.  Keeping those training-only modules on CPU reduces
    # pressure on the shared-memory GB10 without changing runtime audio.
    runtime_modules = (
        ("trajectory_expander", model.expander),
        ("note_conditioner", model.note_state),
        ("decoder_timbre_adapter", model.decoder_timbre_adapter),
        ("brave_decoder", model.decoder),
        ("harmonic_clock", model.harmonic),
    )
    for name, module in runtime_modules:
        try:
            module.to(target_device)
        except torch.AcceleratorError as error:
            free_bytes = 0
            if target_device.type == "cuda":
                free_bytes = int(torch.cuda.mem_get_info(target_device)[0])
            raise RuntimeError(
                f"failed to move {name} to {target_device}; "
                f"CUDA free={free_bytes / (1024 ** 2):.1f} MiB"
            ) from error
    metadata = {
        "format": payload["format"],
        "stage": payload["stage"],
        "step": int(payload["step"]),
        "sha256": actual_hash,
        "parameter_report": payload.get("parameter_report", model.parameter_report()),
    }
    del payload
    return RuntimeModel(model=model, config=config, anchors=anchors, checkpoint=metadata)


class LiveLifecycle:
    """Maps an indefinite stream clock onto the trained 5-second note lifecycle."""

    def __init__(self, data: DataConfig, mode: TrajectoryMode = "natural"):
        self.data = data
        self.mode: TrajectoryMode = mode
        self.state = "idle"
        self.release_at: int | None = None
        self.full_lifecycle = False

    def start(self, mode: TrajectoryMode = "natural",
              full_lifecycle: bool = False) -> None:
        self.set_mode(mode)
        self.state = "sustain"
        self.release_at = None
        self.full_lifecycle = bool(full_lifecycle)

    def set_mode(self, mode: TrajectoryMode) -> None:
        if mode not in ("natural", "static", "static_mean"):
            raise ValueError(f"unsupported trajectory mode: {mode}")
        self.mode = mode

    def stop(self, stream_sample: int) -> None:
        if self.state == "sustain":
            self.state = "release"
            self.release_at = max(0, int(stream_sample))

    def panic(self) -> None:
        self.state = "idle"
        self.release_at = None
        self.full_lifecycle = False

    @property
    def release_samples(self) -> int:
        return self.data.render_samples - self.data.note_off_sample

    @property
    def release_end_stream(self) -> int | None:
        if self.full_lifecycle:
            return self.data.render_samples
        if self.release_at is None:
            return None
        return self.release_at + self.release_samples

    def release_complete(self, stream_sample: int) -> bool:
        end = self.release_end_stream
        return end is not None and int(stream_sample) >= end

    def note_positions(self, stream_samples: Tensor) -> Tensor:
        if self.full_lifecycle:
            return stream_samples.clamp(0, self.data.render_samples - 1)
        sustain = (stream_samples + self.data.note_on_sample).clamp(
            max=self.data.note_off_sample - 1
        )
        if self.release_at is None:
            return sustain
        release = (stream_samples - self.release_at + self.data.note_off_sample).clamp(
            min=self.data.note_off_sample, max=self.data.render_samples - 1
        )
        return torch.where(stream_samples >= self.release_at, release, sustain)

    def trajectory_positions(self, stream_samples: Tensor) -> Tensor:
        positions = self.note_positions(stream_samples)
        if self.mode in ("natural", "static_mean"):
            return positions
        mature = torch.full_like(positions, self.data.note_off_sample - 1)
        # Keep pre-onset context intact and always use the learned release after Stop.
        static_sustain = torch.where(stream_samples >= 0, mature, positions)
        if self.release_at is None:
            return static_sustain
        return torch.where(stream_samples >= self.release_at, positions, static_sustain)

    def phase(self, stream_sample: int) -> str:
        position = int(self.note_positions(torch.tensor([stream_sample]))[0])
        if position < self.data.note_on_sample:
            return "pre_roll"
        if position < self.data.note_off_sample:
            return "gate"
        return "release"


class HarmonicClock:
    """Absolute-phase harmonic excitation with a constant analytic RMS scale."""

    def __init__(self, model: TrajectoryBrave):
        source = model.harmonic
        self.sample_rate = int(source.sample_rate)
        self.target_rms = float(source.target_rms)
        self.harmonics = source.harmonics.detach().float()

    @torch.no_grad()
    def render(self, note: int, start_sample: int, samples: int, device: torch.device) -> Tensor:
        frequency = 440.0 * (2.0 ** ((float(note) - 69.0) / 12.0))
        harmonics = self.harmonics.to(device=device)
        keep = harmonics * frequency <= self.sample_rate / 2.0
        harmonics = harmonics[keep]
        indices = torch.arange(
            start_sample + 1, start_sample + samples + 1,
            device=device, dtype=torch.float32,
        )
        phase = indices * (2.0 * math.pi * frequency / self.sample_rate)
        inverse = harmonics.reciprocal()
        waveform = (torch.sin(harmonics[:, None] * phase[None, :])
                    * inverse[:, None]).sum(dim=0)
        analytic_rms = torch.sqrt(0.5 * inverse.square().sum()).clamp_min(1e-6)
        waveform = waveform * (self.target_rms / analytic_rms)
        return waveform.view(1, 1, -1)


class StreamingStochasticCache:
    """A deterministic finite-session cache matching the trained band-noise source."""

    def __init__(self, model: TrajectoryBrave, maximum_seconds: float,
                 warmup_samples: int, seed: int = 20260721):
        config = model.model_config
        data = model.data_config
        self.bands = config.pqmf_bands
        self.history_frames = math.ceil(warmup_samples / self.bands) + 16
        future_frames = math.ceil((maximum_seconds + 2.0) * data.sample_rate / self.bands)
        frames = self.history_frames + future_frames
        generator = torch.Generator(device="cpu")
        generator.manual_seed(seed)
        cache = torch.empty(self.bands, frames, dtype=torch.float32)
        for band in range(self.bands):
            noise = torch.randn(frames, dtype=torch.float32, generator=generator)
            noise.mul_(torch.rsqrt(noise.square().mean().clamp_min(1e-6)))
            cache[band].copy_(noise)
        duration = frames / (data.sample_rate / self.bands)
        points = max(2, int(math.ceil(duration * config.stochastic_modulation_hz)) + 1)
        modulation = torch.randn(1, 1, points, dtype=torch.float32, generator=generator)
        modulation = F.interpolate(
            modulation, size=frames, mode="linear", align_corners=True
        )[0, 0]
        envelope = 0.75 + 0.25 * torch.tanh(modulation)
        cache.mul_(envelope[None]).mul_(config.stochastic_excitation_rms)
        self.cache = cache.contiguous()

    def render(self, start_sample: int, frames: int, device: torch.device) -> Tensor:
        if start_sample % self.bands:
            raise ValueError("stochastic cache requires PQMF-aligned sample positions")
        start = self.history_frames + start_sample // self.bands
        end = start + frames
        if start < 0 or end > self.cache.shape[1]:
            raise RuntimeError("maximum live session duration exceeded")
        return self.cache[:, start:end].unsqueeze(0).to(device=device, non_blocking=True)


@dataclass(frozen=True)
class RenderBlock:
    audio: np.ndarray
    render_ms: float
    state: str
    stream_sample: int
    finite: bool


def _linear_resample(values: Tensor, source: Tensor, target: Tensor) -> Tensor:
    if values.shape[-1] != source.numel() or source.numel() < 2:
        raise ValueError("invalid trajectory resampling grid")
    right = torch.searchsorted(source, target, right=True).clamp(1, source.numel() - 1)
    left = right - 1
    x0 = source[left].float()
    x1 = source[right].float()
    weight = ((target.float() - x0) / (x1 - x0).clamp_min(1.0)).view(1, 1, -1)
    return values[..., left] * (1.0 - weight) + values[..., right] * weight


class LiveRenderer:
    """Single-voice pull renderer; one call produces one browser audio packet."""

    def __init__(
        self,
        model: TrajectoryBrave,
        block_samples: int = 2048,
        maximum_session_seconds: float = 900.0,
        stochastic_cache: StreamingStochasticCache | None = None,
    ):
        if block_samples <= 0 or block_samples % model.samples_per_latent:
            raise ValueError("block_samples must be a positive multiple of 128")
        self.model = model
        self.device = next(model.decoder.parameters()).device
        self.data = model.data_config
        self.block_samples = int(block_samples)
        self.maximum_session_samples = int(maximum_session_seconds * self.data.sample_rate)
        self.output_frames = self.block_samples // model.samples_per_latent
        self.total_frames = model.warmup_frames + self.output_frames + model.tail_frames
        self.total_samples = self.total_frames * model.samples_per_latent
        self.harmonic = HarmonicClock(model)
        self.lifecycle = LiveLifecycle(self.data)
        if model.model_config.stochastic_excitation:
            self.stochastic = stochastic_cache or StreamingStochasticCache(
                model, maximum_session_seconds,
                model.warmup_frames * model.samples_per_latent,
            )
        else:
            self.stochastic = None
        self.note = 48
        self.velocity = 50
        self.stream_sample = 0
        self._initial_coordinate = np.zeros(8, dtype=np.float32)
        self._target_coordinate = self._initial_coordinate.copy()
        self._smoothed_coordinate = self._initial_coordinate.copy()
        self._coordinate_frames: dict[int, np.ndarray] = {}
        self._latest_control_frame = -1
        self._static_mean_trajectory: Tensor | None = None
        self._render_times: deque[float] = deque(maxlen=512)
        self._lock = threading.RLock()
        frame_seconds = self.data.trajectory_hop / self.data.sample_rate
        self._smoothing_alpha = float(1.0 - math.exp(-frame_seconds / 0.1))

    def start(self, coordinate: np.ndarray, note: int = 48, velocity: int = 50,
              mode: TrajectoryMode = "natural",
              full_lifecycle: bool = False) -> None:
        value = self._validate_coordinate(coordinate)
        if not 36 <= int(note) <= 71:
            raise ValueError("Pad V1 live note must be in MIDI 36..71")
        if not 1 <= int(velocity) <= 127:
            raise ValueError("velocity must be in 1..127")
        with self._lock:
            self.note = int(note)
            self.velocity = int(velocity)
            self.stream_sample = 0
            self._initial_coordinate = value.copy()
            self._target_coordinate = value.copy()
            self._smoothed_coordinate = value.copy()
            self._coordinate_frames.clear()
            self._latest_control_frame = -1
            self._static_mean_trajectory = None
            self._render_times.clear()
            self.lifecycle.start(mode, full_lifecycle=full_lifecycle)
            if mode == "static_mean":
                frames = math.ceil(self.data.render_samples / self.data.trajectory_hop)
                positions = (
                    torch.arange(frames, device=self.device, dtype=torch.long)
                    * self.data.trajectory_hop
                )
                coordinate_tensor = torch.from_numpy(value).to(self.device).unsqueeze(0)
                velocity_tensor = torch.tensor(
                    [self.velocity], device=self.device, dtype=torch.long
                )
                with torch.inference_mode():
                    self._static_mean_trajectory = self._expand_coordinates(
                        coordinate_tensor, positions, velocity_tensor
                    ).float().mean(dim=-1, keepdim=True)

    def update_coordinate(self, coordinate: np.ndarray) -> None:
        value = self._validate_coordinate(coordinate)
        with self._lock:
            self._target_coordinate = value.copy()

    def set_mode(self, mode: TrajectoryMode) -> None:
        with self._lock:
            self.lifecycle.set_mode(mode)

    def stop(self) -> None:
        with self._lock:
            self.lifecycle.stop(self.stream_sample)

    def panic(self) -> None:
        with self._lock:
            self.lifecycle.panic()

    @property
    def state(self) -> str:
        return self.lifecycle.state

    def timing(self) -> dict[str, float | int | bool]:
        values = np.asarray(self._render_times, dtype=np.float64)
        if not values.size:
            return {"count": 0, "p50_ms": 0.0, "p99_ms": 0.0, "mean_ms": 0.0}
        return {
            "count": int(values.size),
            "p50_ms": float(np.percentile(values, 50)),
            "p99_ms": float(np.percentile(values, 99)),
            "mean_ms": float(values.mean()),
            "realtime": bool(np.percentile(values, 99) < 1000.0 * self.block_samples
                             / self.data.sample_rate),
        }

    def reset_timing(self) -> None:
        with self._lock:
            self._render_times.clear()

    def render_block(self, output_samples: int | None = None) -> RenderBlock | None:
        with self._lock:
            if self.lifecycle.state == "idle":
                return None
            samples = self.block_samples if output_samples is None else int(output_samples)
            if not 1 <= samples <= self.block_samples:
                raise ValueError("output_samples must be within one render block")
            if self.stream_sample >= self.maximum_session_samples and self.lifecycle.state == "sustain":
                self.lifecycle.stop(self.stream_sample)
            self._advance_coordinates_for_output(samples)
            start_sample = self.stream_sample
            if self.device.type == "cuda":
                torch.cuda.synchronize(self.device)
            started = time.perf_counter()
            audio = self._render_tensor(start_sample)
            if self.device.type == "cuda":
                torch.cuda.synchronize(self.device)
            render_ms = (time.perf_counter() - started) * 1000.0
            audio_np = audio.detach().float().cpu().numpy().reshape(-1).astype(np.float32)
            audio_np = audio_np[:samples]
            finite = bool(np.isfinite(audio_np).all())
            if not finite:
                self.lifecycle.panic()
                raise FloatingPointError("live renderer produced NaN/Inf")
            audio_np = self._apply_transport_fades(audio_np, start_sample)
            self.stream_sample += samples
            if self.lifecycle.release_complete(self.stream_sample):
                self.lifecycle.panic()
            self._render_times.append(render_ms)
            return RenderBlock(
                audio=audio_np,
                render_ms=render_ms,
                state=self.lifecycle.state,
                stream_sample=self.stream_sample,
                finite=finite,
            )

    @torch.inference_mode()
    def render_pair_block(
        self,
        other: "LiveRenderer",
        output_samples: int | None = None,
    ) -> tuple[RenderBlock, RenderBlock]:
        if self is other or self.model is not other.model:
            raise ValueError("paired renderers must be distinct and share one model")
        if (
            self.block_samples != other.block_samples
            or self.total_samples != other.total_samples
            or self.device != other.device
        ):
            raise ValueError("paired renderers must have identical runtime geometry")
        first, second = (
            (self, other) if id(self) < id(other) else (other, self)
        )
        with first._lock:
            with second._lock:
                if self.lifecycle.state == "idle" or other.lifecycle.state == "idle":
                    raise RuntimeError("paired renderer became idle")
                samples = (
                    self.block_samples
                    if output_samples is None
                    else int(output_samples)
                )
                if not 1 <= samples <= self.block_samples:
                    raise ValueError(
                        "output_samples must be within one render block"
                    )
                self._advance_coordinates_for_output(samples)
                other._advance_coordinates_for_output(samples)
                starts = (self.stream_sample, other.stream_sample)
                if self.device.type == "cuda":
                    torch.cuda.synchronize(self.device)
                started = time.perf_counter()
                left = self._prepare_decoder_inputs(starts[0])
                right = other._prepare_decoder_inputs(starts[1])
                decoder_timbre = torch.cat((left[0], right[0]), dim=0)
                note_condition = torch.cat((left[1], right[1]), dim=0)
                excitation = torch.cat((left[2], right[2]), dim=0)
                autocast_enabled = self.device.type == "cuda"
                with torch.autocast(
                    device_type=self.device.type,
                    dtype=(
                        torch.float16 if autocast_enabled else torch.float32
                    ),
                    enabled=autocast_enabled,
                ):
                    waveform = self.model.decoder(
                        decoder_timbre,
                        note_condition,
                        excitation,
                        self.total_samples,
                    )
                if self.device.type == "cuda":
                    torch.cuda.synchronize(self.device)
                render_ms = (time.perf_counter() - started) * 1000.0
                crop = self.model.warmup_frames * self.model.samples_per_latent
                audio_pair = waveform[
                    ..., crop:crop + self.block_samples
                ].float().clamp(-1.0, 1.0)
                blocks = []
                for index, renderer in enumerate((self, other)):
                    audio = (
                        audio_pair[index]
                        .detach()
                        .float()
                        .cpu()
                        .numpy()
                        .reshape(-1)[:samples]
                        .astype(np.float32)
                    )
                    finite = bool(np.isfinite(audio).all())
                    if not finite:
                        self.lifecycle.panic()
                        other.lifecycle.panic()
                        raise FloatingPointError(
                            "paired live renderer produced NaN/Inf"
                        )
                    audio = renderer._apply_transport_fades(
                        audio, starts[index]
                    )
                    renderer.stream_sample += samples
                    if renderer.lifecycle.release_complete(
                        renderer.stream_sample
                    ):
                        renderer.lifecycle.panic()
                    renderer._render_times.append(render_ms / 2.0)
                    blocks.append(RenderBlock(
                        audio=audio,
                        render_ms=render_ms / 2.0,
                        state=renderer.lifecycle.state,
                        stream_sample=renderer.stream_sample,
                        finite=finite,
                    ))
                return blocks[0], blocks[1]

    @torch.inference_mode()
    def _render_tensor(self, start_sample: int) -> Tensor:
        decoder_timbre, note_condition, excitation = (
            self._prepare_decoder_inputs(start_sample)
        )
        autocast_enabled = self.device.type == "cuda"
        with torch.autocast(
            device_type=self.device.type,
            dtype=torch.float16 if autocast_enabled else torch.float32,
            enabled=autocast_enabled,
        ):
            waveform = self.model.decoder(
                decoder_timbre, note_condition, excitation, self.total_samples
            )
        crop = self.model.warmup_frames * self.model.samples_per_latent
        return waveform[..., crop:crop + self.block_samples].float().clamp(-1.0, 1.0)

    @torch.inference_mode()
    def _prepare_decoder_inputs(
        self, start_sample: int
    ) -> tuple[Tensor, Tensor, Tensor]:
        latent_offsets = (
            torch.arange(self.total_frames, device=self.device, dtype=torch.long)
            - self.model.warmup_frames
        ) * self.model.samples_per_latent
        latent_stream = latent_offsets + start_sample
        control_start = math.floor(int(latent_stream[0].item()) / self.data.trajectory_hop)
        control_end = math.ceil(int(latent_stream[-1].item()) / self.data.trajectory_hop)
        control_indices = torch.arange(
            control_start, control_end + 1, device=self.device, dtype=torch.long
        )
        control_stream = control_indices * self.data.trajectory_hop
        coordinates = np.stack(
            [self._coordinate_for_frame(int(index)) for index in control_indices.cpu().tolist()],
            axis=0,
        )
        coordinate_tensor = torch.from_numpy(coordinates).to(self.device).unsqueeze(0)
        trajectory_positions = self.lifecycle.trajectory_positions(control_stream)

        note = torch.tensor([self.note], device=self.device, dtype=torch.long)
        velocity = torch.tensor([self.velocity], device=self.device, dtype=torch.long)
        note_positions = self.lifecycle.note_positions(latent_stream).unsqueeze(0)
        autocast_enabled = self.device.type == "cuda"
        with torch.autocast(
            device_type=self.device.type,
            dtype=torch.float16 if autocast_enabled else torch.float32,
            enabled=autocast_enabled,
        ):
            if self.lifecycle.mode == "static_mean":
                if self._static_mean_trajectory is None:
                    raise RuntimeError("static mean trajectory is not initialized")
                coarse = self._static_mean_trajectory.expand(
                    -1, -1, trajectory_positions.numel()
                )
            else:
                coarse = self._expand_coordinates(
                    coordinate_tensor, trajectory_positions.unsqueeze(0), velocity
                )
            trajectory = _linear_resample(coarse, control_stream, latent_stream)
            note_condition = self.model.note_state(
                note, velocity, note_positions, self.data
            )
            decoder_timbre = self.model.decoder_timbre_adapter(trajectory)

            excitation_start = start_sample - (
                self.model.warmup_frames * self.model.samples_per_latent
            )
            excitation_waveform = self.harmonic.render(
                self.note, excitation_start, self.total_samples, self.device
            )
            with torch.autocast(device_type=self.device.type, enabled=False):
                excitation = self.model.decoder.pqmf.analysis(excitation_waveform.float())
            if self.stochastic is not None:
                excitation = excitation + self.stochastic.render(
                    excitation_start, excitation.shape[-1], self.device
                )
        return decoder_timbre, note_condition, excitation

    def _expand_coordinates(
        self,
        coordinates: Tensor,
        sample_positions: Tensor,
        velocity: Tensor,
    ) -> Tensor:
        parameters = inspect.signature(self.model.expand_coordinates).parameters
        if "velocity" in parameters:
            return self.model.expand_coordinates(
                coordinates, sample_positions, velocity
            )
        return self.model.expand_coordinates(coordinates, sample_positions)

    def _advance_coordinates_for_output(self, output_samples: int) -> None:
        first = self.stream_sample // self.data.trajectory_hop
        last = (self.stream_sample + output_samples - 1) // self.data.trajectory_hop
        for frame in range(max(first, self._latest_control_frame + 1), last + 1):
            self._smoothed_coordinate += self._smoothing_alpha * (
                self._target_coordinate - self._smoothed_coordinate
            )
            self._coordinate_frames[frame] = self._smoothed_coordinate.copy()
            self._latest_control_frame = frame
        keep_after = first - 32
        self._coordinate_frames = {
            key: value for key, value in self._coordinate_frames.items() if key >= keep_after
        }

    def _coordinate_for_frame(self, frame: int) -> np.ndarray:
        if frame in self._coordinate_frames:
            return self._coordinate_frames[frame]
        if frame < 0:
            return self._initial_coordinate
        return self._smoothed_coordinate

    def _apply_transport_fades(self, audio: np.ndarray, start_sample: int) -> np.ndarray:
        fade = max(1, int(round(0.015 * self.data.sample_rate)))
        gain = np.ones(audio.shape[0], dtype=np.float32)
        absolute = start_sample + np.arange(audio.shape[0])
        if start_sample < fade:
            gain *= np.clip((absolute + 1) / fade, 0.0, 1.0).astype(np.float32)
        end = self.lifecycle.release_end_stream
        if end is not None:
            gain *= np.clip((end - absolute) / fade, 0.0, 1.0).astype(np.float32)
        return np.clip(audio * gain, -1.0, 1.0).astype(np.float32)

    @staticmethod
    def _validate_coordinate(coordinate: np.ndarray) -> np.ndarray:
        value = np.asarray(coordinate, dtype=np.float32)
        if value.shape != (8,) or not np.isfinite(value).all():
            raise ValueError("live coordinate must be a finite 8-D vector")
        return value
