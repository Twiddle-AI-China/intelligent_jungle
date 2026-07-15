"""Training-side integration of the pitch-conditioned BRAVE generator.

The official acids-rave Lightning module only ever calls ``self.decoder(z)``
with a single argument, so the conditioned generator is wrapped in an adapter
that carries the current batch's excitation as transient state. Ordinary corpus
batches use self-supervised NCCF teacher forcing for P0-B compatibility; P0-C
pilot batches instead carry renderer-truth conditioning aligned by the dataset.
"""
from __future__ import annotations

from typing import Sequence

import torch
import torchaudio
from torch import nn
from torch.nn import functional as F

import rave
# Private helper, acceptable against the locked acids-rave 2.3.x dependency.
from rave.model import _pqmf_encode

from .conditioning import CONDITIONING_SCHEMA
from .pitch_generator import PitchConditionedGenerator
from .pitch_model import HarmonicExcitation


class ConditionedGeneratorAdapter(nn.Module):
    """Single-argument decoder facade over the two-input conditioned generator.

    ``rave.RAVE`` calls ``decoder(z)`` in training, validation and its
    receptive-field probe. The excitation for the current batch is injected via
    ``set_excitation``; whenever the stored excitation does not match the
    incoming latent (unset, stale, or probe-sized), the generator runs on a
    neutral zero excitation, which is exactly the baseline behaviour while the
    FiLM sites are pass-through.
    """

    def __init__(self, generator: PitchConditionedGenerator) -> None:
        super().__init__()
        self.generator = generator
        self.cumulative_delay = generator.cumulative_delay
        self.register_buffer("stored_excitation", torch.zeros(0), persistent=False)

    @torch.jit.export
    def set_excitation(self, excitation: torch.Tensor) -> None:
        self.stored_excitation = excitation.detach()

    @torch.jit.export
    def clear_excitation(self) -> None:
        self.stored_excitation = torch.zeros(0, device=self.stored_excitation.device)

    def set_warmed_up(self, state: bool) -> None:
        self.generator.set_warmed_up(state)

    def forward(self, latent: torch.Tensor) -> torch.Tensor:
        expected = latent.shape[-1] * self.generator.output_ratio
        excitation = self.stored_excitation
        if excitation.ndim != 3 or excitation.shape[0] != latent.shape[0] or excitation.shape[-1] != expected:
            excitation = torch.zeros(
                latent.shape[0],
                self.generator.condition_channels,
                expected,
                dtype=latent.dtype,
                device=latent.device,
            )
        return self.generator(latent, excitation)


def build_pitch_decoder(
    latent_size: int,
    capacity: int,
    data_size: int,
    ratios: Sequence[int],
    loud_stride: int,
    use_noise: bool,
    n_channels: int = 1,
) -> ConditionedGeneratorAdapter:
    """Decoder constructor referenced by configs/brave_pitch.gin."""
    return ConditionedGeneratorAdapter(
        PitchConditionedGenerator(
            latent_size=latent_size,
            capacity=capacity,
            data_size=data_size,
            ratios=ratios,
            loud_stride=loud_stride,
            use_noise=use_noise,
            n_channels=n_channels,
        )
    )


def extract_conditioning(
    audio: torch.Tensor,
    sample_rate: int,
    samples_per_frame: int,
    *,
    rms_floor: float = 0.02,
    f0_low: float = 50.0,
    f0_high: float = 2000.0,
) -> torch.Tensor:
    """Self-supervised ``[batch, 3, frames]`` conditioning from raw audio.

    Channel order follows CONDITIONING_SCHEMA. ``f0=0`` marks unvoiced frames;
    the voiced decision is tied to the RMS gate because the NCCF estimator
    reports a frequency even for silence.
    """
    if audio.ndim != 3:
        raise ValueError("audio must be [batch, channels, samples]")
    frames = audio.shape[-1] // samples_per_frame
    if frames == 0:
        raise ValueError("audio is shorter than one conditioning frame")

    with torch.no_grad():
        mono = audio.detach().mean(dim=1)[..., : frames * samples_per_frame]
        framed = mono.reshape(mono.shape[0], frames, samples_per_frame)
        rms = torch.sqrt(framed.square().mean(dim=-1) + 1e-12)
        loudness = rms.clamp(0.0, 1.0)
        gate = (rms > rms_floor).to(audio.dtype)

        f0 = torchaudio.functional.detect_pitch_frequency(
            mono,
            sample_rate,
            frame_time=samples_per_frame / sample_rate,
            freq_low=int(f0_low),
            freq_high=int(f0_high),
        )
        if f0.shape[-1] != frames:
            f0 = F.interpolate(f0[:, None, :], size=frames, mode="nearest")[:, 0, :]
        f0 = f0.to(audio.dtype) * gate

    return torch.stack([f0, loudness, gate], dim=1)


def conditioning_diagnostics(conditioning: torch.Tensor) -> dict[str, float]:
    """Minimal health metrics for extracted conditioning (review requirement)."""
    f0 = conditioning[:, 0]
    gate = conditioning[:, 2]
    voiced = f0 > 0.0
    voiced_count = int(voiced.sum())
    silent_frames = gate == 0.0
    silent_count = int(silent_frames.sum())
    return {
        "frames": float(conditioning.shape[-1]),
        "voiced_ratio": float(voiced.float().mean()),
        "gate_ratio": float(gate.mean()),
        "f0_min_voiced": float(f0[voiced].min()) if voiced_count else 0.0,
        "f0_max_voiced": float(f0[voiced].max()) if voiced_count else 0.0,
        "silent_false_voiced_ratio": (
            float((f0[silent_frames] > 0.0).float().mean()) if silent_count else 0.0
        ),
    }


class PitchConditionedRAVE(rave.RAVE):
    """rave.RAVE with excitation injected from the batch before each step.

    Instantiated in place of ``rave.RAVE`` by scripts/train_pitch.py; all gin
    bindings for ``rave.RAVE`` flow through ``super().__init__``.
    """

    def __init__(self, rms_floor: float = 0.02, **kwargs) -> None:
        super().__init__(**kwargs)
        if not isinstance(self.decoder, ConditionedGeneratorAdapter):
            raise TypeError(
                "PitchConditionedRAVE requires the brave_pitch.gin decoder "
                "(pitch_rave.build_pitch_decoder)"
            )
        if self.input_mode != "pqmf" or self.output_mode != "pqmf":
            raise ValueError("pitch pilot assumes BRAVE's pqmf input/output modes")
        if self.n_channels != 1:
            raise ValueError("pitch pilot is single-channel")
        generator = self.decoder.generator
        self.samples_per_frame = generator.condition_channels * generator.output_ratio
        self.excitation = HarmonicExcitation(
            sample_rate=self.sr, samples_per_frame=self.samples_per_frame
        )
        self.rms_floor = rms_floor
        self.conditioning_schema = CONDITIONING_SCHEMA

    def _excitation_from_conditioning(self, conditioning: torch.Tensor) -> torch.Tensor:
        with torch.no_grad():
            phase = torch.zeros(
                conditioning.shape[0], device=conditioning.device, dtype=conditioning.dtype
            )
            excitation, _ = self.excitation(conditioning, phase)
            return _pqmf_encode(self.pqmf, excitation)

    def _unpack_batch(self, batch) -> tuple[torch.Tensor, torch.Tensor]:
        if isinstance(batch, dict):
            audio = batch["audio"]
            conditioning = batch["conditioning"]
            expected_frames = audio.shape[-1] // self.samples_per_frame
            if conditioning.shape != (audio.shape[0], 3, expected_frames):
                raise ValueError("pilot conditioning is not aligned with the audio batch")
            return audio, conditioning
        return batch, extract_conditioning(
            batch, self.sr, self.samples_per_frame, rms_floor=self.rms_floor
        )

    def training_step(self, batch, batch_idx):
        # Excitation is transient per-batch state: always overwrite before the
        # step and clear afterwards so no other path (forward, receptive-field
        # probe) can reuse a stale batch.
        audio, conditioning = self._unpack_batch(batch)
        self.decoder.set_excitation(self._excitation_from_conditioning(conditioning))
        try:
            return super().training_step(audio, batch_idx)
        finally:
            self.decoder.clear_excitation()

    def validation_step(self, x, batch_idx):
        x, conditioning = self._unpack_batch(x)
        if self._trainer is not None:
            self.log_dict(
                {f"conditioning_{k}": v for k, v in conditioning_diagnostics(conditioning).items()}
            )
        with torch.no_grad():
            self.decoder.set_excitation(self._excitation_from_conditioning(conditioning))
        try:
            return super().validation_step(x, batch_idx)
        finally:
            self.decoder.clear_excitation()

    def decode_conditioned(
        self,
        z: torch.Tensor,
        conditioning: torch.Tensor,
        initial_phase: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Decode a latent under explicit conditioning; returns (audio, phase)."""
        phase = (
            initial_phase
            if initial_phase is not None
            else torch.zeros(z.shape[0], device=z.device, dtype=z.dtype)
        )
        excitation, final_phase = self.excitation(conditioning, phase)
        self.decoder.set_excitation(_pqmf_encode(self.pqmf, excitation))
        audio = self.decode(z)
        self.decoder.clear_excitation()
        return audio, final_phase
