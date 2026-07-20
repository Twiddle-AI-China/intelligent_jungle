from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import torch
from scipy.signal import firwin
from torch import Tensor, nn
from torch.nn import functional as F

from .config import ModelConfig


class CausalConv1d(nn.Conv1d):
    def __init__(self, *args, causal_pad_mode: str = "constant", **kwargs):
        super().__init__(*args, **kwargs)
        self.causal_pad_mode = causal_pad_mode

    def forward(self, x: Tensor) -> Tensor:
        pad = self.dilation[0] * (self.kernel_size[0] - 1)
        if not pad:
            return super().forward(x)
        if self.causal_pad_mode == "constant":
            x = F.pad(x, (pad, 0))
        else:
            x = F.pad(x, (pad, 0), mode=self.causal_pad_mode)
        return super().forward(x)


class ChannelRMSNorm(nn.Module):
    """Per-frame channel RMS normalization with an FP32 reduction."""

    def __init__(self, epsilon: float = 1e-6):
        super().__init__()
        self.epsilon = float(epsilon)

    def forward(self, x: Tensor) -> Tensor:
        dtype = x.dtype
        with torch.autocast(device_type=x.device.type, enabled=False):
            value = x.float()
            value = value * torch.rsqrt(value.square().mean(dim=1, keepdim=True) + self.epsilon)
        return value.to(dtype=dtype)


class FiLM(nn.Module):
    """Time-varying MIDI FiLM; zero initialization is an exact identity."""

    def __init__(self, condition_dim: int, channels: int,
                 scale_limit: float = 0.5, shift_limit: float = 1.0):
        super().__init__()
        self.affine = nn.Conv1d(condition_dim, channels * 2, 1)
        nn.init.zeros_(self.affine.weight)
        nn.init.zeros_(self.affine.bias)
        self.scale_limit = float(scale_limit)
        self.shift_limit = float(shift_limit)

    def _bounded(self, condition: Tensor) -> tuple[Tensor, Tensor]:
        gamma, beta = self.affine(condition).chunk(2, dim=1)
        return (self.scale_limit * torch.tanh(gamma),
                self.shift_limit * torch.tanh(beta))

    def forward(self, x: Tensor, condition: Tensor, static_condition: bool = False) -> Tensor:
        if condition.ndim == 2:
            condition = condition.unsqueeze(-1)
        if static_condition:
            condition = condition[..., :1]
            gamma, beta = self._bounded(condition)
            gamma = gamma.expand(-1, -1, x.shape[-1])
            beta = beta.expand(-1, -1, x.shape[-1])
            return x * (1.0 + gamma) + beta
        if condition.shape[-1] != x.shape[-1]:
            condition = F.interpolate(condition, size=x.shape[-1], mode="nearest")
        gamma, beta = self._bounded(condition)
        return x * (1.0 + gamma) + beta


class ResidualBlock(nn.Module):
    def __init__(self, channels: int, midi_dim: int, excitation_dim: int, dilation: int,
                 fp32_tail: bool = False, norm_epsilon: float = 1e-6,
                 film_scale_limit: float = 0.5, film_shift_limit: float = 1.0):
        super().__init__()
        self.norm1 = ChannelRMSNorm(norm_epsilon)
        self.norm2 = ChannelRMSNorm(norm_epsilon)
        self.conv1 = CausalConv1d(channels, channels, 3, dilation=dilation)
        self.conv2 = CausalConv1d(channels, channels, 1)
        # Keep the approved 32-D MIDI path explicit, then add the independent
        # P-RAVE-style excitation modulation. Both start as pass-throughs.
        self.film = FiLM(midi_dim, channels, film_scale_limit, film_shift_limit)
        self.excitation_film = FiLM(
            excitation_dim, channels, film_scale_limit, film_shift_limit)
        self.fp32_tail = bool(fp32_tail)

    def forward(self, x: Tensor, z_midi: Tensor, excitation: Tensor,
                static_midi: bool = False) -> Tensor:
        y = F.silu(self.conv1(self.norm1(x)))
        y = self.norm2(y)
        if self.fp32_tail:
            # At the trained Phase-1 checkpoint the last high-channel block can
            # reach ~5.1e4 after conv1. Its following 1x1 convolution overflows
            # FP16 (65504) for otherwise valid samples. Keep the expensive 3-tap
            # convolution on Tensor Cores, but perform the small tail and the
            # residual addition in FP32. This adds no parameters and preserves
            # checkpoint/optimizer compatibility.
            with torch.autocast(device_type=x.device.type, enabled=False):
                x = x.float()
                y = self.conv2(y.float())
                y = self.film(y, z_midi.float(), static_condition=static_midi)
                y = self.excitation_film(y, excitation.float())
                return (x + y) * (2.0**-0.5)
        y = self.film(self.conv2(y), z_midi, static_condition=static_midi)
        y = self.excitation_film(y, excitation)
        return (x + y) * (2.0**-0.5)


class PQMF(nn.Module):
    """Matched fixed cosine-modulated analysis/synthesis filter bank."""

    def __init__(self, bands: int = 16, taps: int = 256, beta: float = 9.0):
        super().__init__()
        if taps % bands:
            raise ValueError("PQMF taps must be divisible by band count")
        # For a 16-band cosine-modulated bank the prototype occupies roughly
        # half of one subband. 0.56592 / bands is the calibrated alias-
        # cancellation point for the locked 256-tap, beta=9 design.
        prototype = firwin(taps + 1, 0.56592 / bands, window=("kaiser", beta))
        n = np.arange(taps + 1, dtype=np.float64) - taps / 2
        analysis = []
        synthesis = []
        for k in range(bands):
            carrier = (2 * k + 1) * np.pi * n / (2 * bands)
            phase = ((-1) ** k) * np.pi / 4
            analysis.append(2 * prototype * np.cos(carrier + phase))
            synthesis.append(2 * prototype * np.cos(carrier - phase))
        self.register_buffer("analysis_weight",
                             torch.tensor(np.stack(analysis)[:, ::-1].copy(),
                                          dtype=torch.float32).unsqueeze(1))
        self.register_buffer("synthesis_weight",
                             torch.tensor(np.stack(synthesis), dtype=torch.float32).unsqueeze(1))
        self.bands = bands
        self.taps = taps

    def analysis(self, waveform: Tensor) -> Tensor:
        if waveform.ndim != 3 or waveform.shape[1] != 1:
            raise ValueError("PQMF analysis expects [batch, 1, samples]")
        waveform = F.pad(waveform, (self.taps // 2, self.taps // 2))
        return F.conv1d(waveform, self.analysis_weight, stride=self.bands)

    def synthesis(self, subbands: Tensor, output_samples: int | None = None) -> Tensor:
        if subbands.ndim != 3 or subbands.shape[1] != self.bands:
            raise ValueError(f"expected {self.bands} subbands")
        waveform = F.conv_transpose1d(subbands, self.synthesis_weight, stride=self.bands)
        start = self.taps // 2
        if output_samples is None:
            output_samples = subbands.shape[-1] * self.bands
        waveform = waveform[..., start:start + output_samples] * self.bands
        if waveform.shape[-1] < output_samples:
            waveform = F.pad(waveform, (0, output_samples - waveform.shape[-1]))
        return waveform


class PQMFSynthesis(nn.Module):
    """Compatibility wrapper retained for existing callers and checkpoints."""

    def __init__(self, bands: int = 16, taps: int = 256, beta: float = 9.0):
        super().__init__()
        self.pqmf = PQMF(bands, taps, beta)

    def forward(self, subbands: Tensor, output_samples: int) -> Tensor:
        return self.pqmf.synthesis(subbands, output_samples)


class FixedAntiAlias(nn.Module):
    def __init__(self, ratio: int, taps: int):
        super().__init__()
        if taps % 2 != 1:
            raise ValueError("anti-image filter must have an odd number of taps")
        kernel = firwin(taps, 1.0 / ratio, window=("kaiser", 8.6)).astype(np.float32)
        self.register_buffer("kernel", torch.from_numpy(kernel).view(1, 1, -1))
        self.pad = taps - 1

    def forward(self, x: Tensor) -> Tensor:
        weight = self.kernel.expand(x.shape[1], 1, -1)
        return F.conv1d(F.pad(x, (self.pad, 0), mode="replicate"), weight,
                        groups=x.shape[1])


class HarmonicExcitation(nn.Module):
    """Parameter-free note clock used by the multi-scale BRAVE FiLM path.

    Note and time are sufficient to construct this signal; it does not add a
    gate, envelope, pitch-bend, periodicity, or any new training label. The
    fixed RMS deliberately leaves velocity-to-loudness mapping to z_midi.
    """

    def __init__(self, sample_rate: int, max_harmonics: int, target_rms: float,
                 chunk_size: int = 16):
        super().__init__()
        if sample_rate <= 0 or max_harmonics <= 0 or target_rms <= 0:
            raise ValueError("invalid harmonic excitation configuration")
        self.sample_rate = sample_rate
        self.target_rms = target_rms
        self.chunk_size = chunk_size
        self.register_buffer("harmonics", torch.arange(1, max_harmonics + 1,
                                                        dtype=torch.float32))

    @torch.no_grad()
    def forward(self, note: Tensor, samples: int) -> Tensor:
        if note.ndim != 1 or samples <= 0:
            raise ValueError("note must be [batch] and samples must be positive")
        with torch.autocast(device_type=note.device.type, enabled=False):
            frequency = 440.0 * torch.pow(2.0, (note.float() - 69.0) / 12.0)
            time = torch.arange(1, samples + 1, device=note.device, dtype=torch.float32)
            phase = (2.0 * math.pi / self.sample_rate) * frequency[:, None] * time[None, :]
            excitation = torch.zeros_like(phase)
            for harmonics in self.harmonics.split(self.chunk_size):
                harmonic = harmonics.to(note.device).view(1, -1, 1)
                keep = (frequency[:, None, None] * harmonic <= self.sample_rate / 2.0)
                excitation.add_(((torch.sin(phase[:, None, :] * harmonic) / harmonic)
                                 * keep).sum(dim=1))
            measured = excitation.square().mean(dim=-1, keepdim=True).sqrt().clamp_min(1e-6)
            excitation = excitation * (self.target_rms / measured)
        return excitation.unsqueeze(1)


class StochasticBandExcitation(nn.Module):
    """Deterministic-per-window random subband source for non-periodic detail.

    Training and validation pass explicit seeds, so exact checkpoint resume is
    unaffected by DataLoader scheduling. The low-rate envelope prevents a
    stationary noise shortcut while remaining independent of MIDI labels.
    """

    def __init__(self, bands: int, sample_rate: int, hop_samples: int,
                 target_rms: float, modulation_hz: float, default_seed: int):
        super().__init__()
        self.bands = int(bands)
        self.frame_rate = float(sample_rate) / float(hop_samples)
        self.target_rms = float(target_rms)
        self.modulation_hz = float(modulation_hz)
        self.default_seed = int(default_seed)

    @torch.no_grad()
    def forward(self, batch: int, frames: int, device: torch.device,
                seeds: Tensor | None = None) -> Tensor:
        values = []
        if seeds is None:
            seeds = torch.arange(batch, device=device, dtype=torch.long) + self.default_seed
        for index in range(batch):
            generator = torch.Generator(device=device)
            generator.manual_seed(int(seeds[index].item()))
            noise = torch.randn(self.bands, frames, device=device,
                                dtype=torch.float32, generator=generator)
            noise = noise / noise.square().mean(dim=-1, keepdim=True).sqrt().clamp_min(1e-6)
            duration = frames / max(self.frame_rate, 1e-6)
            control_points = max(2, int(math.ceil(duration * self.modulation_hz)) + 1)
            modulation = torch.randn(
                1, 1, control_points, device=device, dtype=torch.float32,
                generator=generator,
            )
            modulation = F.interpolate(
                modulation, size=frames, mode="linear", align_corners=True)[0]
            envelope = 0.75 + 0.25 * torch.tanh(modulation)
            values.append(noise * envelope * self.target_rms)
        return torch.stack(values, dim=0)


class ExcitationDownsample(CausalConv1d):
    """Trainable causal PQMF-band downsampler with a stable identity-like start."""

    def __init__(self, bands: int, ratio: int):
        kernel_size = 2 * ratio
        super().__init__(bands, bands, kernel_size, stride=ratio,
                         causal_pad_mode="replicate")
        nn.init.zeros_(self.weight)
        nn.init.zeros_(self.bias)
        with torch.no_grad():
            for band in range(bands):
                self.weight[band, band].fill_(1.0 / kernel_size)


class TimbreAdapter(nn.Module):
    def __init__(self, input_dim: int, output_dim: int):
        super().__init__()
        self.net = nn.Sequential(
            nn.LayerNorm(input_dim), nn.Linear(input_dim, 256), nn.SiLU(),
            nn.Linear(256, output_dim), nn.Tanh(),
        )

    def forward(self, clap: Tensor) -> Tensor:
        return self.net(F.normalize(clap, dim=-1))


class MidiConditioner(nn.Module):
    """32-D note/velocity conditioner. It has no event or envelope fields."""

    def __init__(self, output_dim: int = 32):
        super().__init__()
        if output_dim != 32:
            raise ValueError("the approved MIDI condition is exactly 32-D")
        self.note = nn.Embedding(128, 16)
        self.continuous = nn.Sequential(nn.Linear(2, 32), nn.SiLU(), nn.Linear(32, 16))
        self.tcn = nn.Sequential(
            CausalConv1d(32, 32, 3, dilation=1, causal_pad_mode="replicate"), nn.SiLU(),
            CausalConv1d(32, 32, 3, dilation=2, causal_pad_mode="replicate"), nn.SiLU(),
            CausalConv1d(32, 32, 3, dilation=4, causal_pad_mode="replicate"),
        )

    def forward(self, note: Tensor, velocity: Tensor, frames: int,
                static_condition: bool = False) -> Tensor:
        note = note.long().clamp(0, 127)
        velocity = velocity.float().clamp(0, 127)
        continuous = torch.stack(((note.float() - 69.0) / 48.0, velocity / 127.0), dim=-1)
        z = torch.cat((self.note(note), self.continuous(continuous)), dim=-1)
        if static_condition:
            return self.tcn(z.unsqueeze(-1)).expand(-1, -1, frames)
        return self.tcn(z.unsqueeze(-1).expand(-1, -1, frames))


class FusionProjection(nn.Module):
    def __init__(self, input_dim: int, output_dim: int):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv1d(input_dim, output_dim, 1), nn.SiLU(),
            nn.Conv1d(output_dim, output_dim, 1),
        )

    def forward(self, z_timbre: Tensor, z_midi: Tensor,
                static_condition: bool = False) -> Tensor:
        if static_condition:
            fused = self.net(torch.cat((z_timbre[..., :1], z_midi[..., :1]), dim=1))
            return fused.expand(-1, -1, z_midi.shape[-1])
        return self.net(torch.cat((z_timbre, z_midi), dim=1))


class ConditionalOutputGain(nn.Module):
    """Small direct loudness path for non-monotonic preset velocity responses.

    The decoder already receives MIDI at every stage.  This bounded residual
    path does not replace that conditioning: it gives relative RMS losses a
    short, condition-dependent route to the actual waveform amplitude.  The
    final layer starts at zero, so enabling the module is initially an exact
    identity and cannot perturb pitch, phase, or spectral reconstruction.
    """

    def __init__(self, timbre_dim: int, midi_dim: int, hidden: int, max_db: float):
        super().__init__()
        if hidden <= 0 or max_db <= 0.0:
            raise ValueError("conditional output gain requires positive hidden/max_db")
        self.net = nn.Sequential(
            nn.Linear(timbre_dim + midi_dim, hidden),
            nn.SiLU(),
            nn.Linear(hidden, 1),
        )
        nn.init.zeros_(self.net[-1].weight)
        nn.init.zeros_(self.net[-1].bias)
        self.max_db = float(max_db)

    def forward(self, waveform: Tensor, z_timbre: Tensor, z_midi: Tensor) -> Tensor:
        condition = torch.cat((z_timbre, z_midi[..., 0]), dim=-1)
        gain_db = self.max_db * torch.tanh(self.net(condition))
        gain = torch.pow(waveform.new_tensor(10.0), gain_db / 20.0).unsqueeze(-1)
        return waveform * gain


class BraveDecoder(nn.Module):
    def __init__(self, config: ModelConfig):
        super().__init__()
        self.ratios = config.ratios
        channels = [config.capacity * 16, config.capacity * 8, config.capacity * 4,
                    config.capacity * 2, config.capacity]
        if len(channels) != len(config.ratios) + 1:
            raise ValueError("decoder ratios must contain exactly four stages")
        self.fusion = FusionProjection(config.timbre_dim + config.midi_dim, channels[0])
        self.pqmf_dtype = config.pqmf_dtype
        self.blocks = nn.ModuleList()
        self.projections = nn.ModuleList()
        self.anti_alias = nn.ModuleList()
        for index, ratio in enumerate(self.ratios):
            self.blocks.append(nn.ModuleList([
                ResidualBlock(channels[index + 1], config.midi_dim, config.pqmf_bands, 1,
                              norm_epsilon=config.rms_norm_epsilon,
                              film_scale_limit=config.film_scale_limit,
                              film_shift_limit=config.film_shift_limit),
                ResidualBlock(channels[index + 1], config.midi_dim, config.pqmf_bands, 3,
                              norm_epsilon=config.rms_norm_epsilon,
                              film_scale_limit=config.film_scale_limit,
                              film_shift_limit=config.film_shift_limit),
                ResidualBlock(channels[index + 1], config.midi_dim, config.pqmf_bands, 9,
                              fp32_tail=(config.decoder_fp32_tail and index == 0),
                              norm_epsilon=config.rms_norm_epsilon,
                              film_scale_limit=config.film_scale_limit,
                              film_shift_limit=config.film_shift_limit),
            ]))
            self.anti_alias.append(FixedAntiAlias(ratio, config.anti_image_taps)
                                   if ratio > 1 else nn.Identity())
            self.projections.append(CausalConv1d(channels[index], channels[index + 1], 3))
        self.excitation_downsamplers = nn.ModuleList([
            ExcitationDownsample(config.pqmf_bands, ratio) if ratio > 1 else nn.Identity()
            for ratio in reversed(self.ratios[1:])
        ])
        self.output = CausalConv1d(channels[-1], config.pqmf_bands, 7)
        self.pqmf = PQMF(config.pqmf_bands, config.pqmf_taps)
        self.static_condition_fast_path = config.static_condition_fast_path

    def conditioning_levels(self, excitation: Tensor) -> list[Tensor]:
        levels = [excitation]
        current = excitation
        for downsampler in self.excitation_downsamplers:
            current = downsampler(current)
            levels.insert(0, current)
        return levels

    def forward(self, z_timbre: Tensor, z_midi: Tensor, excitation: Tensor,
                output_samples: int) -> Tensor:
        expected_excitation_frames = z_midi.shape[-1] * int(np.prod(self.ratios))
        if excitation.shape[1] != self.pqmf.bands or excitation.shape[-1] != expected_excitation_frames:
            raise ValueError("PQMF excitation is not aligned with decoder rates")
        excitation_levels = self.conditioning_levels(excitation)
        x = self.fusion(z_timbre, z_midi, self.static_condition_fast_path)
        for ratio, blocks, anti_alias, projection, excitation_level in zip(
                self.ratios, self.blocks, self.anti_alias, self.projections,
                excitation_levels):
            if ratio > 1:
                x = F.interpolate(x, scale_factor=ratio, mode="nearest")
                x = anti_alias(x)
            x = F.silu(projection(x))
            if excitation_level.shape[-1] != x.shape[-1]:
                raise ValueError("excitation pyramid does not match an upsampling stage")
            midi_level = (z_midi[..., :1] if self.static_condition_fast_path else
                          F.interpolate(z_midi, size=x.shape[-1], mode="nearest"))
            excitation_level = excitation_level.to(dtype=x.dtype)
            for block in blocks:
                x = block(x, midi_level, excitation_level,
                          static_midi=self.static_condition_fast_path)
        subbands = self.output(x)
        if self.pqmf_dtype == "fp32":
            with torch.autocast(device_type=x.device.type, enabled=False):
                waveform = self.pqmf.synthesis(subbands.float(), output_samples)
        elif self.pqmf_dtype == "amp_fp16":
            waveform = self.pqmf.synthesis(subbands, output_samples)
        else:
            raise ValueError(f"unknown pqmf_dtype: {self.pqmf_dtype}")
        return torch.tanh(waveform)


class PitchAdversary(nn.Module):
    def __init__(self, timbre_dim: int, classes: int = 128):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(timbre_dim, 128), nn.SiLU(), nn.Linear(128, classes))

    def forward(self, timbre: Tensor) -> Tensor:
        return self.net(timbre)


class _GradientReverse(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x: Tensor, scale: float) -> Tensor:
        ctx.scale = scale
        return x

    @staticmethod
    def backward(ctx, gradient: Tensor) -> tuple[Tensor, None]:
        return -ctx.scale * gradient, None


@dataclass
class PairOutput:
    self_audio: Tensor | None
    cross_audio: Tensor
    timbre: Tensor
    target_timbre: Tensor
    pitch_logits: Tensor


class MidiBrave(nn.Module):
    def __init__(self, config: ModelConfig, output_samples: int, sample_rate: int):
        super().__init__()
        self.config = config
        self.output_samples = output_samples
        self.samples_per_latent = config.pqmf_bands * int(np.prod(config.ratios))
        if output_samples % self.samples_per_latent:
            raise ValueError("window must be divisible by PQMF bands times decoder ratios")
        self.latent_frames = output_samples // self.samples_per_latent
        self.tail_latent_frames = math.ceil((config.pqmf_taps // 2) / self.samples_per_latent)
        self.total_latent_frames = (self.latent_frames + config.warmup_latent_frames
                                    + self.tail_latent_frames)
        self.timbre = TimbreAdapter(config.clap_dim, config.timbre_dim)
        self.midi = MidiConditioner(config.midi_dim)
        self.decoder = BraveDecoder(config)
        self.condition_gain = (
            ConditionalOutputGain(
                config.timbre_dim, config.midi_dim,
                config.condition_gain_hidden, config.condition_gain_max_db,
            )
            if config.condition_gain_hidden > 0 else None
        )
        self.excitation = HarmonicExcitation(
            sample_rate, config.excitation_harmonics, config.excitation_rms)
        self.stochastic_excitation = StochasticBandExcitation(
            config.pqmf_bands, sample_rate, config.pqmf_bands,
            config.stochastic_excitation_rms, config.stochastic_modulation_hz,
            config.stochastic_seed,
        )
        self.pitch_adversary = PitchAdversary(config.timbre_dim, classes=128)
        self.register_buffer("excitation_band_bank", torch.empty(0), persistent=False)

    @torch.no_grad()
    def prepare_runtime_caches(self) -> None:
        if not self.config.cache_excitation_bands or self.excitation_band_bank.numel():
            return
        device = next(self.parameters()).device
        total_samples = self.total_latent_frames * self.samples_per_latent
        chunks = []
        chunk_size = max(1, self.config.excitation_cache_note_chunk)
        for start in range(0, 128, chunk_size):
            notes = torch.arange(start, min(128, start + chunk_size), device=device)
            waveform = self.excitation(notes, total_samples)
            chunks.append(self._analyze_excitation(waveform))
        self.excitation_band_bank = torch.cat(chunks, dim=0)

    def _analyze_excitation(self, waveform: Tensor) -> Tensor:
        if self.config.pqmf_dtype == "fp32":
            with torch.autocast(device_type=waveform.device.type, enabled=False):
                return self.decoder.pqmf.analysis(waveform.float())
        return self.decoder.pqmf.analysis(waveform)

    def decode(self, z_timbre: Tensor, note: Tensor, velocity: Tensor,
               excitation_seed: Tensor | None = None) -> Tensor:
        z_midi = self.midi(
            note, velocity, self.total_latent_frames,
            static_condition=self.config.static_condition_fast_path,
        )
        z_timbre_frames = z_timbre.unsqueeze(-1).expand(-1, -1, self.total_latent_frames)
        total_samples = self.total_latent_frames * self.samples_per_latent
        if self.config.cache_excitation_bands:
            self.prepare_runtime_caches()
            excitation_bands = self.excitation_band_bank.index_select(
                0, note.long().clamp(0, 127))
        else:
            excitation_waveform = self.excitation(note, total_samples)
            excitation_bands = self._analyze_excitation(excitation_waveform)
        if self.config.stochastic_excitation:
            random_bands = self.stochastic_excitation(
                note.shape[0], excitation_bands.shape[-1], note.device, excitation_seed)
            excitation_bands = excitation_bands.float() + random_bands
        waveform = self.decoder(z_timbre_frames, z_midi, excitation_bands, total_samples)
        start = self.config.warmup_latent_frames * self.samples_per_latent
        waveform = waveform[..., start:start + self.output_samples]
        if self.condition_gain is not None:
            waveform = self.condition_gain(waveform, z_timbre, z_midi)
        return waveform

    def forward(self, clap: Tensor, source_note: Tensor, source_velocity: Tensor,
                target_note: Tensor, target_velocity: Tensor, target_clap: Tensor | None = None,
                grl_scale: float = 1.0, include_self: bool = True,
                source_excitation_seed: Tensor | None = None,
                target_excitation_seed: Tensor | None = None) -> PairOutput:
        z_timbre = self.timbre(clap)
        target_timbre = self.timbre(target_clap) if target_clap is not None else z_timbre
        z = torch.cat((z_timbre, z_timbre), dim=0) if include_self else z_timbre
        note = torch.cat((source_note, target_note), dim=0) if include_self else target_note
        velocity = (torch.cat((source_velocity, target_velocity), dim=0)
                    if include_self else target_velocity)
        excitation_seed = None
        if source_excitation_seed is not None and target_excitation_seed is not None:
            excitation_seed = (torch.cat((source_excitation_seed, target_excitation_seed), dim=0)
                               if include_self else target_excitation_seed)
        audio = self.decode(z, note, velocity, excitation_seed)
        batch = clap.shape[0]
        pitch_logits = self.pitch_adversary(_GradientReverse.apply(z_timbre, grl_scale))
        if include_self:
            return PairOutput(audio[:batch], audio[batch:], z_timbre, target_timbre, pitch_logits)
        return PairOutput(None, audio, z_timbre, target_timbre, pitch_logits)
