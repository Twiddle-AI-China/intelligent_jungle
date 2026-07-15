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
from rave.model import _pqmf_decode, _pqmf_encode

from .conditioning import CONDITIONING_SCHEMA
from .pitch_generator import PitchConditionedGenerator
from .pitch_model import HarmonicExcitation


class _GradientReverse(torch.autograd.Function):
    @staticmethod
    def forward(ctx, value: torch.Tensor, scale: float) -> torch.Tensor:
        ctx.scale = scale
        return value.view_as(value)

    @staticmethod
    def backward(ctx, gradient: torch.Tensor) -> tuple[torch.Tensor, None]:
        return -ctx.scale * gradient, None


class PitchAdversary(nn.Module):
    """Small source-pitch classifier used only while training P0-C4A."""

    def __init__(self, latent_size: int, hidden_size: int = 64, classes: int = 4) -> None:
        super().__init__()
        self.network = nn.Sequential(
            nn.Conv1d(latent_size, hidden_size, 3, padding=1),
            nn.SiLU(),
            nn.Conv1d(hidden_size, classes, 1),
        )

    def forward(self, latent: torch.Tensor) -> torch.Tensor:
        return self.network(latent)


def pitch_adversary_loss(
    logits: torch.Tensor, labels: torch.Tensor
) -> tuple[torch.Tensor, torch.Tensor]:
    """Classify each stable central latent frame with one clip-level pitch label."""
    start, stop = logits.shape[-1] // 4, 3 * logits.shape[-1] // 4
    central = logits[..., start:stop]
    frame_labels = labels[:, None].expand(labels.shape[0], central.shape[-1])
    loss = F.cross_entropy(central, frame_labels)
    accuracy = (central.argmax(dim=1) == frame_labels).float().mean()
    return loss, accuracy


def unfreeze_encoder_tail(encoder: nn.Module, parameterized_modules: int) -> dict[str, int]:
    """Freeze an encoder except for its final parameterized sequential modules."""
    if parameterized_modules <= 0:
        raise ValueError("parameterized_modules must be positive")
    network = getattr(getattr(encoder, "encoder", None), "net", None)
    if not isinstance(network, nn.Sequential):
        raise TypeError("locked BRAVE encoder does not expose encoder.net Sequential")
    for parameter in encoder.parameters():
        parameter.requires_grad_(False)
    candidates = [
        (name, module)
        for name, module in network.named_children()
        if any(True for _ in module.parameters())
    ]
    selected = candidates[-parameterized_modules:]
    if len(selected) != parameterized_modules:
        raise ValueError(
            f"encoder has only {len(candidates)} parameterized modules, "
            f"cannot unfreeze {parameterized_modules}"
        )
    for _, module in selected:
        for parameter in module.parameters():
            parameter.requires_grad_(True)
    return {
        "parameterized_modules": len(selected),
        "trainable_tensors": sum(
            int(parameter.requires_grad) for parameter in encoder.parameters()
        ),
        "trainable_parameters": sum(
            parameter.numel() for parameter in encoder.parameters() if parameter.requires_grad
        ),
    }


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
        self.pitch_adversary: PitchAdversary | None = None
        self.pitch_adversary_weight = 0.0
        self.pitch_adversary_grl_scale = 0.0
        self.pitch_adversary_warmup_batches = 0
        self.pitch_adversary_updates_per_batch = 1
        self.latent_pitch_consistency_weight = 0.0

    def enable_pitch_adversary(
        self,
        *,
        weight: float,
        grl_scale: float = 1.0,
        hidden_size: int = 64,
        classes: int = 4,
        warmup_batches: int = 0,
        updates_per_batch: int = 1,
    ) -> None:
        if weight <= 0.0 or grl_scale <= 0.0:
            raise ValueError("pitch adversary weight and GRL scale must be positive")
        if warmup_batches < 0 or updates_per_batch <= 0:
            raise ValueError("warmup must be non-negative and updates per batch positive")
        self.pitch_adversary = PitchAdversary(
            self.latent_size, hidden_size=hidden_size, classes=classes
        )
        self.pitch_adversary_weight = weight
        self.pitch_adversary_grl_scale = grl_scale
        self.pitch_adversary_warmup_batches = warmup_batches
        self.pitch_adversary_updates_per_batch = updates_per_batch
        self.register_buffer(
            "pitch_adversary_batches_seen", torch.zeros((), dtype=torch.long)
        )

    def enable_latent_pitch_consistency(self, weight: float) -> None:
        if weight <= 0.0:
            raise ValueError("latent pitch consistency weight must be positive")
        if self.pitch_adversary is not None:
            raise ValueError("do not mix adversarial and consistency experiments")
        self.latent_pitch_consistency_weight = weight

    def configure_optimizers(self):
        if self.pitch_adversary is None:
            return super().configure_optimizers()
        generator_parameters = list(self.encoder.parameters()) + list(
            self.decoder.parameters()
        )
        generator_optimizer = torch.optim.Adam(generator_parameters, 1e-3, (0.5, 0.9))
        adversary_optimizer = torch.optim.Adam(
            self.pitch_adversary.parameters(), 1e-3, (0.5, 0.9)
        )
        return (
            {
                "optimizer": generator_optimizer,
                "lr_scheduler": {
                    "scheduler": torch.optim.lr_scheduler.LinearLR(
                        generator_optimizer,
                        start_factor=1.0,
                        end_factor=0.1,
                        total_iters=self.warmup,
                    )
                },
            },
            {"optimizer": adversary_optimizer},
        )

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

    def _swap_forward(
        self,
        source: torch.Tensor,
        target: torch.Tensor,
        conditioning: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, dict[str, torch.Tensor]]:
        """Encode source timbre and reconstruct a different target pitch."""
        if self.warmed_up:
            raise RuntimeError("P0-C3 pitch-swap is a phase-1-only experiment")
        batch_size = target.shape[:-2]
        self.encoder.set_warmed_up(self.warmed_up)
        self.decoder.set_warmed_up(self.warmed_up)
        distribution = self.encode(source)
        latent = distribution.chunk(2, dim=1)[0]
        target_multiband = _pqmf_encode(self.pqmf, target)
        self.decoder.set_excitation(self._excitation_from_conditioning(conditioning))
        try:
            output_multiband = self.decoder(latent)
        finally:
            self.decoder.clear_excitation()
        output = _pqmf_decode(
            self.pqmf, output_multiband, batch_size=batch_size, n_channels=self.n_channels
        )
        output = output[..., : target.shape[-1]]
        output_multiband = output_multiband[..., : target_multiband.shape[-1]]
        distances: dict[str, torch.Tensor] = {}
        for key, value in self.multiband_audio_distance(
            target_multiband, output_multiband
        ).items():
            distances[f"swap_multiband_{key}"] = (
                self.weights["multiband_audio_distance"] * value
            )
        for key, value in self.audio_distance(target, output).items():
            distances[f"swap_fullband_{key}"] = self.weights["audio_distance"] * value
        if self.latent_pitch_consistency_weight > 0.0:
            target_distribution = self.encode(target)
            target_latent = target_distribution.chunk(2, dim=1)[0]
            start, stop = latent.shape[-1] // 4, 3 * latent.shape[-1] // 4
            consistency = F.smooth_l1_loss(
                latent[..., start:stop], target_latent[..., start:stop]
            )
            distances["latent_pitch_consistency"] = (
                self.latent_pitch_consistency_weight * consistency
            )
        return output, latent, distances

    def training_step(self, batch, batch_idx):
        # Excitation is transient per-batch state: always overwrite before the
        # step and clear afterwards so no other path (forward, receptive-field
        # probe) can reuse a stale batch.
        if isinstance(batch, dict) and "source_audio" in batch:
            generator_optimizer, auxiliary_optimizer = self.optimizers()
            raw_auxiliary_optimizer = getattr(
                auxiliary_optimizer, "optimizer", auxiliary_optimizer
            )
            generator_optimizer.zero_grad()
            _, latent, distances = self._swap_forward(
                batch["source_audio"], batch["target_audio"], batch["conditioning"]
            )
            if self.pitch_adversary is not None:
                labels = batch["source_pitch_class"]
                for _ in range(self.pitch_adversary_updates_per_batch):
                    raw_auxiliary_optimizer.zero_grad()
                    detached_logits = self.pitch_adversary(latent.detach())
                    classifier_loss, classifier_accuracy = pitch_adversary_loss(
                        detached_logits, labels
                    )
                    classifier_loss.backward()
                    raw_auxiliary_optimizer.step()

                in_warmup = (
                    int(self.pitch_adversary_batches_seen)
                    < self.pitch_adversary_warmup_batches
                )
                self.pitch_adversary_batches_seen.add_(1)
                self.log("pitch_adversary_warmup", float(in_warmup))
                self.log(
                    "pitch_adversary_batches_seen",
                    self.pitch_adversary_batches_seen.float(),
                )
                self.log("pitch_classifier_loss", classifier_loss.detach())
                self.log("pitch_classifier_accuracy", classifier_accuracy)
                if in_warmup:
                    # Advance Lightning's batch/global-step bookkeeping once
                    # without changing generator weights. Auxiliary raw-optimizer
                    # steps above intentionally do not consume the step budget.
                    (latent.sum() * 0.0).backward()
                    generator_optimizer.step()
                    reconstruction = sum(distances.values())
                    self.log_dict(distances)
                    self.log("swap_loss", reconstruction.detach())
                    return classifier_loss.detach()

                reversed_latent = _GradientReverse.apply(
                    latent, self.pitch_adversary_grl_scale
                )
                adversarial_loss, _ = pitch_adversary_loss(
                    self.pitch_adversary(reversed_latent), labels
                )
                distances["pitch_adversary"] = (
                    self.pitch_adversary_weight * adversarial_loss
                )
            loss = sum(distances.values())
            loss.backward()
            generator_optimizer.step()
            self.log_dict(distances)
            self.log("swap_loss", loss)
            return loss.detach()
        audio, conditioning = self._unpack_batch(batch)
        self.decoder.set_excitation(self._excitation_from_conditioning(conditioning))
        try:
            return super().training_step(audio, batch_idx)
        finally:
            self.decoder.clear_excitation()

    def validation_step(self, x, batch_idx):
        if isinstance(x, dict) and "source_audio" in x:
            conditioning = x["conditioning"]
            with torch.no_grad():
                output, latent, distances = self._swap_forward(
                    x["source_audio"], x["target_audio"], conditioning
                )
            validation = sum(distances.values())
            if self._trainer is not None:
                self.log("validation", validation)
                if self.pitch_adversary is not None:
                    labels = x["source_pitch_class"]
                    logits = self.pitch_adversary(latent)
                    classifier_loss, classifier_accuracy = pitch_adversary_loss(
                        logits, labels
                    )
                    self.log(
                        "validation_pitch_classifier_loss",
                        classifier_loss,
                    )
                    self.log(
                        "validation_pitch_classifier_accuracy",
                        classifier_accuracy,
                    )
                self.log_dict(
                    {
                        f"conditioning_{key}": value
                        for key, value in conditioning_diagnostics(conditioning).items()
                    }
                )
            return torch.cat([x["target_audio"], output], -1), latent
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
