from __future__ import annotations

import math
from dataclasses import dataclass

import torch
import torch.distributed as dist
from torch import Tensor, nn
from torch.nn import functional as F
from torch.nn.utils import weight_norm

from .config import LossConfig
from .data import midi_to_hz
from .model import PQMF, PairOutput


class MultiResolutionSTFTLoss(nn.Module):
    def __init__(self, fft_sizes: tuple[int, ...] = (2048, 1024, 512, 256, 128)):
        super().__init__()
        self.fft_sizes = fft_sizes
        for fft_size in fft_sizes:
            self.register_buffer(f"hann_{fft_size}", torch.hann_window(fft_size),
                                 persistent=False)

    def magnitude(self, x: Tensor, fft_size: int) -> Tensor:
        with torch.autocast(device_type=x.device.type, enabled=False):
            x = x.float().squeeze(1)
            window = getattr(self, f"hann_{fft_size}").to(dtype=x.dtype)
            spectrum = torch.stft(x, fft_size, fft_size // 4, fft_size, window,
                                  return_complex=True, center=True, pad_mode="constant")
        return spectrum.abs().clamp_min(1e-7)

    def forward_groups(self, groups: list[tuple[Tensor, Tensor]]) -> list[Tensor]:
        if not groups:
            return []
        sizes = [prediction.shape[0] for prediction, _ in groups]
        predictions = torch.cat([prediction for prediction, _ in groups], dim=0)
        targets = torch.cat([target for _, target in groups], dim=0)
        total = [predictions.new_zeros(()) for _ in groups]
        prediction_count = predictions.shape[0]
        for fft_size in self.fft_sizes:
            magnitude = self.magnitude(torch.cat((predictions, targets), dim=0), fft_size)
            prediction_magnitude = magnitude[:prediction_count]
            target_magnitude = magnitude[prediction_count:]
            offset = 0
            for index, size in enumerate(sizes):
                p = prediction_magnitude[offset:offset + size]
                t = target_magnitude[offset:offset + size]
                convergence = (torch.linalg.vector_norm(p - t)
                               / torch.linalg.vector_norm(t).clamp_min(1e-7))
                total[index] = total[index] + convergence + F.l1_loss(p.log(), t.log())
                offset += size
        return [value / len(self.fft_sizes) for value in total]

    def forward(self, prediction: Tensor, target: Tensor) -> Tensor:
        return self.forward_groups([(prediction, target)])[0]


class MultiBandSTFTLoss(nn.Module):
    def __init__(self, bands: int, taps: int):
        super().__init__()
        self.pqmf = PQMF(bands, taps)
        self.loss = MultiResolutionSTFTLoss((1024, 512, 256, 128))
        self.bands = bands

    def forward_groups(self, groups: list[tuple[Tensor, Tensor]]) -> list[Tensor]:
        if not groups:
            return []
        sizes = [prediction.shape[0] for prediction, _ in groups]
        predictions = torch.cat([prediction for prediction, _ in groups], dim=0)
        targets = torch.cat([target for _, target in groups], dim=0)
        count = predictions.shape[0]
        subbands = self.pqmf.analysis(torch.cat((predictions, targets), dim=0))
        prediction_bands = subbands[:count]
        target_bands = subbands[count:]
        band_groups = []
        offset = 0
        for size in sizes:
            p = prediction_bands[offset:offset + size]
            t = target_bands[offset:offset + size]
            band_groups.append((
                p.reshape(size * self.bands, 1, p.shape[-1]),
                t.reshape(size * self.bands, 1, t.shape[-1]),
            ))
            offset += size
        return self.loss.forward_groups(band_groups)

    def forward(self, prediction: Tensor, target: Tensor) -> Tensor:
        return self.forward_groups([(prediction, target)])[0]


class MultiScaleEnvelopeLoss(nn.Module):
    def __init__(self, windows: tuple[int, ...] = (1024, 4096, 16384)):
        super().__init__()
        self.windows = windows

    @staticmethod
    def envelope(x: Tensor, window: int) -> Tensor:
        hop = max(1, window // 4)
        return F.avg_pool1d(x.square(), window, hop, padding=window // 2).clamp_min(1e-8).sqrt()

    def forward(self, prediction: Tensor, target: Tensor) -> Tensor:
        return self.forward_groups([(prediction, target)])[0]

    def forward_groups(self, groups: list[tuple[Tensor, Tensor]]) -> list[Tensor]:
        if not groups:
            return []
        sizes = [prediction.shape[0] for prediction, _ in groups]
        predictions = torch.cat([prediction for prediction, _ in groups], dim=0)
        targets = torch.cat([target for _, target in groups], dim=0)
        count = predictions.shape[0]
        total = [predictions.new_zeros(()) for _ in groups]
        for window in self.windows:
            envelope = self.envelope(torch.cat((predictions, targets), dim=0).float(), window).log()
            prediction_envelope = envelope[:count]
            target_envelope = envelope[count:]
            offset = 0
            for index, size in enumerate(sizes):
                p = prediction_envelope[offset:offset + size]
                t = target_envelope[offset:offset + size]
                level = F.l1_loss(p, t)
                delta = F.l1_loss(p[..., 1:] - p[..., :-1], t[..., 1:] - t[..., :-1])
                total[index] = total[index] + level + 0.5 * delta
                offset += size
        return [value / len(self.windows) for value in total]


def rms_db(x: Tensor) -> Tensor:
    rms = torch.sqrt(x.float().square().mean(dim=(-1, -2)) + 1e-8)
    return 20.0 * torch.log10(rms + 1e-7)


class SpectralPitchObjective(nn.Module):
    """Small differentiable fallback used by CPU tests and smoke DDP."""

    def __init__(self, sample_rate: int, fft_size: int = 4096):
        super().__init__()
        self.sample_rate = sample_rate
        self.fft_size = fft_size
        self.register_buffer("window", torch.hann_window(fft_size), persistent=False)
        frequency = torch.fft.rfftfreq(fft_size, 1 / sample_rate)
        self.register_buffer("frequency", frequency, persistent=False)
        self.register_buffer("frequency_keep", (frequency >= 50.0) & (frequency <= 2000.0),
                             persistent=False)

    def _statistics(self, audio: Tensor, note: Tensor, confidence: Tensor,
                    valid: Tensor) -> tuple[Tensor, Tensor]:
        with torch.autocast(device_type=audio.device.type, enabled=False):
            x = audio.float().squeeze(1)
            magnitude = torch.stft(x, self.fft_size, self.fft_size // 4, self.fft_size,
                                   self.window, return_complex=True,
                                   pad_mode="constant").abs().mean(-1)
            distribution = (magnitude[:, self.frequency_keep].clamp_min(1e-7).log()
                            * 8.0).softmax(-1)
            predicted_hz = (distribution * self.frequency[self.frequency_keep]).sum(-1)
            target_hz = midi_to_hz(note).to(predicted_hz)
            cents = 1200.0 * torch.log2((predicted_hz + 1e-7) / (target_hz + 1e-7))
            sample_weight = (valid.float() * confidence.float()).mean(-1)
            values = F.smooth_l1_loss(cents / 100.0, torch.zeros_like(cents), reduction="none")
            return values * sample_weight, sample_weight

    def forward_groups(self, groups: list[tuple[Tensor, Tensor, Tensor, Tensor]]) -> list[Tensor]:
        if not groups:
            return []
        sizes = [audio.shape[0] for audio, _, _, _ in groups]
        numerator, denominator = self._statistics(
            torch.cat([item[0] for item in groups]), torch.cat([item[1] for item in groups]),
            torch.cat([item[2] for item in groups]), torch.cat([item[3] for item in groups]),
        )
        values = []
        offset = 0
        for size in sizes:
            group_numerator = numerator[offset:offset + size]
            group_denominator = denominator[offset:offset + size]
            values.append(group_numerator.sum() / group_denominator.sum().clamp_min(1e-7))
            offset += size
        return values

    def forward_group_components(
            self, groups: list[tuple[Tensor, ...]]) -> list[dict[str, Tensor]]:
        legacy_groups = []
        for group in groups:
            if len(group) == 5:
                audio, _, note, confidence, valid = group
            elif len(group) == 4:
                audio, note, confidence, valid = group
            else:
                raise ValueError("pitch groups must have four or five tensors")
            legacy_groups.append((audio, note, confidence, valid))
        values = self.forward_groups(legacy_groups)
        return [{
            "total": value,
            "cents": value,
            "distribution": value * 0.0,
            "activation": value * 0.0,
            "hard_negative": value * 0.0,
            "autocorrelation": value * 0.0,
        } for value in values]

    def forward(self, audio: Tensor, note: Tensor, confidence: Tensor, valid: Tensor) -> Tensor:
        return self.forward_groups([(audio, note, confidence, valid)])[0]


class DifferentiableCrepeObjective(nn.Module):
    """Frozen CREPE Tiny forward with differentiable resampling and soft-bin decoding."""

    CREPE_SAMPLE_RATE = 16000
    CREPE_WINDOW = 1024

    def __init__(self, sample_rate: int, source_hop: int, temperature: float,
                 sigma_cents: float, kl_weight: float, activation_weight: float = 0.0,
                 hard_negative_weight: float = 0.0,
                 autocorrelation_weight: float = 0.0,
                 negative_margin_logits: float = 1.0,
                 negative_exclusion_cents: float = 100.0,
                 negative_temperature: float = 0.25):
        super().__init__()
        import torchaudio

        self.resample = torchaudio.transforms.Resample(sample_rate, self.CREPE_SAMPLE_RATE)
        self.hop = max(1, round(source_hop * self.CREPE_SAMPLE_RATE / sample_rate))
        self.temperature = temperature
        self.sigma_cents = sigma_cents
        self.kl_weight = kl_weight
        self.activation_weight = activation_weight
        self.hard_negative_weight = hard_negative_weight
        self.autocorrelation_weight = autocorrelation_weight
        self.negative_margin_logits = negative_margin_logits
        self.negative_exclusion_cents = negative_exclusion_cents
        self.negative_temperature = negative_temperature
        cents = torch.arange(360, dtype=torch.float32) * 20.0 + 1997.3794084376191
        keep = (10.0 * torch.pow(2.0, cents / 1200.0) >= 50.0) & (
            10.0 * torch.pow(2.0, cents / 1200.0) <= 2000.0)
        self.register_buffer("bin_cents", cents[keep])
        self.register_buffer("kept_bins", torch.nonzero(keep, as_tuple=False).flatten())

    @staticmethod
    def _crepe_model(device: torch.device) -> nn.Module:
        import torchcrepe

        if (not hasattr(torchcrepe.core.infer, "model")
                or getattr(torchcrepe.core.infer, "capacity", None) != "tiny"):
            torchcrepe.load.model(device, "tiny")
        model = torchcrepe.core.infer.model.to(device)
        model.eval()
        model.requires_grad_(False)
        return model

    @staticmethod
    def _fractional_autocorrelation(frames: Tensor, lag: Tensor,
                                    maximum_lag: int) -> Tensor:
        """Normalized autocorrelation at a per-item fractional sample lag."""
        if frames.ndim != 3 or lag.ndim != 1 or frames.shape[0] != lag.shape[0]:
            raise ValueError("autocorrelation expects [batch, frames, samples] and [batch]")
        usable = frames.shape[-1] - maximum_lag
        if usable <= 1:
            raise ValueError("CREPE frame is too short for the requested pitch lag")
        base = frames[..., :usable]
        sample_index = torch.arange(usable, device=frames.device).view(1, 1, -1)

        def at(integer_lag: Tensor) -> Tensor:
            gather_index = sample_index + integer_lag[:, None, None]
            shifted = frames.gather(-1, gather_index.expand(frames.shape[0],
                                                            frames.shape[1], usable))
            numerator = (base * shifted).sum(-1)
            # Clamp before sqrt: clamping only afterwards still leaves the
            # infinite derivative of sqrt(0), yielding NaN silence gradients.
            energy_product = base.square().sum(-1) * shifted.square().sum(-1)
            denominator = energy_product.clamp_min(1e-12).sqrt()
            return numerator / denominator

        lower = lag.floor().long().clamp(1, maximum_lag)
        upper = (lower + 1).clamp(max=maximum_lag)
        fraction = (lag - lower.to(lag)).clamp(0.0, 1.0)[:, None]
        return at(lower) * (1.0 - fraction) + at(upper) * fraction

    def _statistics(self, audio: Tensor, target_audio: Tensor | None, note: Tensor,
                    confidence: Tensor, valid: Tensor) -> tuple[dict[str, Tensor], Tensor]:
        with torch.autocast(device_type=audio.device.type, enabled=False):
            audio_float = audio.float()
            audio_sample_finite = torch.isfinite(audio_float).flatten(1).all(-1)
            # Pitch supervision must not turn a local frozen-CREPE numerical
            # failure into a process-wide CUDA failure.  Replace only invalid
            # analysis samples and later mask their pitch weights; the waveform,
            # STFT, envelope and RMS objectives still see the original audio and
            # therefore continue to reject decoder-side non-finite output.
            analysis_audio = torch.where(
                torch.isfinite(audio_float), audio_float, torch.zeros_like(audio_float)
            ).clamp(-32.0, 32.0)
            x = self.resample(analysis_audio.squeeze(1))
            x = F.pad(x, (self.CREPE_WINDOW // 2, self.CREPE_WINDOW // 2))
            frames = x.unfold(-1, self.CREPE_WINDOW, self.hop)
            batch, frame_count, _ = frames.shape
            centered_frames = frames - frames.mean(dim=-1, keepdim=True)
            # Pitch is intentionally amplitude-invariant, while RMS is handled
            # by a separate loss.  Detaching a conservative scale floor avoids
            # exploding CREPE gradients when a decoder initially emits silence.
            normalization_scale = centered_frames.std(
                dim=-1, keepdim=True).detach().clamp_min(1e-2)
            normalized_frames = centered_frames / normalization_scale
            activations = self._crepe_model(audio.device)(
                normalized_frames.reshape(-1, self.CREPE_WINDOW))
            activations = activations.reshape(batch, frame_count, 360)[..., self.kept_bins]
            # Do not merely mask a non-finite CREPE output with `where`: an
            # invalid internal derivative can still turn an incoming zero into
            # NaN during backward (0 * NaN).  A host-side decision is deliberate
            # here so the invalid frozen-CREPE graph is excluded from autograd
            # altogether.  Other reconstruction objectives remain active.
            if not bool(torch.isfinite(activations).all().item()):
                zero = analysis_audio.flatten(1).sum(-1) * 0.0
                return ({
                    "cents": zero,
                    "distribution": zero,
                    "activation": zero,
                    "hard_negative": zero,
                    "autocorrelation": zero,
                }, torch.ones_like(zero))
            crepe_frame_finite = torch.isfinite(activations).all(-1)
            activations = torch.where(
                torch.isfinite(activations), activations, torch.zeros_like(activations))
            raw_logits = torch.logit(activations.clamp(1e-5, 1 - 1e-5))
            raw_logits = F.interpolate(raw_logits.transpose(1, 2), size=valid.shape[-1],
                                       mode="linear", align_corners=False).transpose(1, 2)
            resized_crepe_finite = F.interpolate(
                crepe_frame_finite.float()[:, None], size=valid.shape[-1],
                mode="linear", align_corners=False,
            ).squeeze(1).ge(1.0 - 1e-6)
            resized_activations = raw_logits.sigmoid()
            log_probability = F.log_softmax(raw_logits / self.temperature, dim=-1)
            probability = log_probability.exp()
            target_cents = 1200.0 * torch.log2(midi_to_hz(note).to(audio) / 10.0)
            distance = self.bin_cents.view(1, 1, -1) - target_cents[:, None, None]
            target_distribution = F.softmax(
                -0.5 * (distance / self.sigma_cents).square(), dim=-1)
            expected_cents = (probability * self.bin_cents).sum(-1)
            cents_error = (expected_cents - target_cents[:, None]) / 100.0
            regression = F.smooth_l1_loss(cents_error, torch.zeros_like(cents_error), reduction="none")
            classification = F.kl_div(log_probability, target_distribution.expand_as(probability),
                                      reduction="none").sum(-1)

            target_activation = (resized_activations * target_distribution).sum(-1)
            # Keep the activation objective mathematically equivalent to BCE on
            # probabilities, but evaluate it in logit space.  CUDA's probability
            # BCE kernel device-asserts when a rare non-finite CREPE activation
            # reaches it, aborting every DDP rank before the trainer can apply its
            # existing global non-finite-gradient skip.  BCE-with-logits instead
            # propagates the non-finite value, so the bad batch is skipped without
            # updating parameters or corrupting the optimizer state.
            positive = torch.logit(target_activation.clamp(1e-5, 1.0 - 1e-5))
            confidence_float = confidence.float()
            confidence_finite = torch.isfinite(confidence_float)
            safe_confidence = torch.where(
                confidence_finite, confidence_float, torch.zeros_like(confidence_float)
            ).clamp(0.0, 1.0)
            activation = F.binary_cross_entropy_with_logits(
                positive, safe_confidence, reduction="none")

            negative_mask = distance.abs().ge(self.negative_exclusion_cents)
            negative_logits = raw_logits.masked_fill(~negative_mask, -torch.inf)
            negative = self.negative_temperature * torch.logsumexp(
                negative_logits / self.negative_temperature, dim=-1)
            hard_negative = F.softplus(
                negative - positive + self.negative_margin_logits)

            autocorrelation = regression * 0.0
            if self.autocorrelation_weight > 0.0:
                if target_audio is None:
                    raise ValueError("target audio is required by pitch_autocorrelation")
                target_float = target_audio.detach().float()
                target_sample_finite = torch.isfinite(target_float).flatten(1).all(-1)
                analysis_target = torch.where(
                    torch.isfinite(target_float), target_float, torch.zeros_like(target_float)
                ).clamp(-32.0, 32.0)
                target_x = self.resample(analysis_target.squeeze(1))
                target_x = F.pad(target_x,
                                 (self.CREPE_WINDOW // 2, self.CREPE_WINDOW // 2))
                target_frames = target_x.unfold(-1, self.CREPE_WINDOW, self.hop)
                target_frames = target_frames - target_frames.mean(dim=-1, keepdim=True)
                maximum_lag = min(self.CREPE_WINDOW - 2,
                                  math.ceil(self.CREPE_SAMPLE_RATE / 50.0))
                lag = (self.CREPE_SAMPLE_RATE / midi_to_hz(note).to(audio)).clamp(
                    1.0, float(maximum_lag))
                generated_correlation = self._fractional_autocorrelation(
                    centered_frames, lag, maximum_lag)
                target_correlation = self._fractional_autocorrelation(
                    target_frames, lag, maximum_lag).detach()
                generated_correlation = F.interpolate(
                    generated_correlation[:, None], size=valid.shape[-1],
                    mode="linear", align_corners=False).squeeze(1)
                target_correlation = F.interpolate(
                    target_correlation[:, None], size=valid.shape[-1],
                    mode="linear", align_corners=False).squeeze(1)
                # A stable-frame constraint: only penalize periodicity missing
                # from the generated signal.  Extra periodicity is not an error
                # here because timbre/harmonics may legitimately differ.
                autocorrelation = F.relu(
                    target_correlation - generated_correlation)
            else:
                target_sample_finite = torch.ones_like(audio_sample_finite)

            pitch_valid = (
                valid.bool()
                & resized_crepe_finite
                & confidence_finite
                & audio_sample_finite[:, None]
                & target_sample_finite[:, None]
            )
            weight = pitch_valid.float() * safe_confidence
            values = {
                "cents": regression,
                "distribution": classification,
                "activation": activation,
                "hard_negative": hard_negative,
                "autocorrelation": autocorrelation,
            }
            numerators = {name: (value * weight).sum(-1)
                          for name, value in values.items()}
            return numerators, weight.sum(-1)

    def forward_group_components(
            self, groups: list[tuple[Tensor, ...]]) -> list[dict[str, Tensor]]:
        if not groups:
            return []
        parsed = []
        for group in groups:
            if len(group) == 5:
                audio, target_audio, note, confidence, valid = group
            elif len(group) == 4:
                audio, note, confidence, valid = group
                target_audio = None
            else:
                raise ValueError("pitch groups must have four or five tensors")
            parsed.append((audio, target_audio, note, confidence, valid))

        sizes = [item[0].shape[0] for item in parsed]
        generated = torch.cat([item[0] for item in parsed])
        target = (torch.cat([item[1] for item in parsed])
                  if all(item[1] is not None for item in parsed) else None)
        numerators, denominator = self._statistics(
            generated, target,
            torch.cat([item[2] for item in parsed]),
            torch.cat([item[3] for item in parsed]),
            torch.cat([item[4] for item in parsed]),
        )
        values = []
        offset = 0
        for size in sizes:
            group_denominator = denominator[offset:offset + size].sum().clamp_min(1e-7)
            components = {
                name: value[offset:offset + size].sum() / group_denominator
                for name, value in numerators.items()
            }
            components["total"] = (
                components["cents"]
                + self.kl_weight * components["distribution"]
                + self.activation_weight * components["activation"]
                + self.hard_negative_weight * components["hard_negative"]
                + self.autocorrelation_weight * components["autocorrelation"]
            )
            values.append(components)
            offset += size
        return values

    def forward_groups(self, groups: list[tuple[Tensor, Tensor, Tensor, Tensor]]) -> list[Tensor]:
        return [item["total"] for item in self.forward_group_components(groups)]

    def forward(self, audio: Tensor, note: Tensor, confidence: Tensor, valid: Tensor) -> Tensor:
        return self.forward_groups([(audio, note, confidence, valid)])[0]


def velocity_ranking_loss(self_audio: Tensor, cross_audio: Tensor, audio_a: Tensor,
                          audio_b: Tensor, note_a: Tensor, note_b: Tensor,
                          velocity_a: Tensor, velocity_b: Tensor, margin_db: float) -> Tensor:
    return velocity_ranking_from_rms(
        rms_db(self_audio), rms_db(cross_audio), rms_db(audio_a), rms_db(audio_b),
        note_a, note_b, velocity_a, velocity_b, margin_db,
    )


def velocity_delta_matching_loss(self_audio: Tensor, cross_audio: Tensor,
                                 audio_a: Tensor, audio_b: Tensor,
                                 note_a: Tensor, note_b: Tensor,
                                 velocity_a: Tensor, velocity_b: Tensor,
                                 margin_db: float, scale_db: float = 6.0) -> Tensor:
    return velocity_delta_matching_from_rms(
        rms_db(self_audio), rms_db(cross_audio), rms_db(audio_a), rms_db(audio_b),
        note_a, note_b, velocity_a, velocity_b, margin_db, scale_db,
    )


def _velocity_deltas(self_rms: Tensor, cross_rms: Tensor,
                     audio_a_rms: Tensor, audio_b_rms: Tensor,
                     note_a: Tensor, note_b: Tensor,
                     velocity_a: Tensor, velocity_b: Tensor,
                     margin_db: float) -> tuple[Tensor, Tensor, Tensor]:
    target_delta = audio_b_rms - audio_a_rms
    prediction_delta = cross_rms - self_rms
    direction = torch.sign(target_delta)
    active = (note_a.eq(note_b) & velocity_a.ne(velocity_b)
              & direction.ne(0) & target_delta.abs().ge(margin_db))
    return target_delta, prediction_delta, active


def velocity_ranking_from_rms(self_rms: Tensor, cross_rms: Tensor,
                              audio_a_rms: Tensor, audio_b_rms: Tensor,
                              note_a: Tensor, note_b: Tensor,
                              velocity_a: Tensor, velocity_b: Tensor,
                              margin_db: float) -> Tensor:
    target_delta, prediction_delta, active = _velocity_deltas(
        self_rms, cross_rms, audio_a_rms, audio_b_rms,
        note_a, note_b, velocity_a, velocity_b, margin_db,
    )
    direction = torch.sign(target_delta)
    if not active.any():
        return prediction_delta.sum() * 0.0
    return F.relu(margin_db - direction[active] * prediction_delta[active]).mean()


def velocity_delta_matching_from_rms(self_rms: Tensor, cross_rms: Tensor,
                                     audio_a_rms: Tensor, audio_b_rms: Tensor,
                                     note_a: Tensor, note_b: Tensor,
                                     velocity_a: Tensor, velocity_b: Tensor,
                                     margin_db: float, scale_db: float = 6.0) -> Tensor:
    if scale_db <= 0:
        raise ValueError("velocity delta scale must be positive")
    target_delta, prediction_delta, active = _velocity_deltas(
        self_rms, cross_rms, audio_a_rms, audio_b_rms,
        note_a, note_b, velocity_a, velocity_b, margin_db,
    )
    if not active.any():
        return prediction_delta.sum() * 0.0
    return F.smooth_l1_loss(
        prediction_delta[active] / scale_db,
        target_delta[active] / scale_db,
    )


def _gather_with_grad(x: Tensor) -> Tensor:
    if not dist.is_available() or not dist.is_initialized():
        return x
    from torch.distributed.nn.functional import all_gather
    return torch.cat(tuple(all_gather(x)), dim=0)


def _distribution_from_centered_sum(centered_sum: Tensor, sample_count: int,
                                    std_floor: float) -> Tensor:
    variance_per_dimension = torch.diagonal(centered_sum) / sample_count
    std = torch.sqrt(variance_per_dimension.clamp_min(0.0) + 1e-4)
    variance = F.relu(std_floor - std).mean()
    if sample_count <= 1:
        return variance
    covariance = centered_sum / (sample_count - 1)
    off_diagonal = covariance - torch.diag_embed(torch.diagonal(covariance))
    dimension = centered_sum.shape[0]
    covariance_loss = off_diagonal.square().sum() / max(1, dimension * (dimension - 1))
    return variance + covariance_loss


def latent_distribution_loss(z_a: Tensor, z_b: Tensor, std_floor: float,
                             backend: str = "gather") -> Tensor:
    # Global sufficient statistics involve Q - SS^T/N.  Keep them in FP32 even
    # under autocast; FP16 cancellation made exact resume depend on NCCL timing.
    local = torch.cat((z_a, z_b), dim=0).float()
    if backend == "gather":
        z = _gather_with_grad(local)
        centered = z - z.mean(dim=0, keepdim=True)
        return _distribution_from_centered_sum(centered.T @ centered, z.shape[0], std_floor)
    if backend != "moments":
        raise ValueError(f"unsupported latent distribution backend: {backend}")
    sample_count = local.shape[0]
    total = local.sum(dim=0)
    if dist.is_available() and dist.is_initialized():
        from torch.distributed.nn.functional import all_reduce
        total = all_reduce(total, op=dist.ReduceOp.SUM)
        sample_count *= dist.get_world_size()
    # Use a two-pass covariance instead of Q - SS^T/N.  The latter loses the
    # small variance signal when embeddings share a large mean and made a
    # resumed multi-GPU run sensitive to low-bit NCCL reduction order.
    centered = local - total / sample_count
    centered_sum = centered.T @ centered
    if dist.is_available() and dist.is_initialized():
        centered_sum = all_reduce(centered_sum, op=dist.ReduceOp.SUM)
    return _distribution_from_centered_sum(centered_sum, sample_count, std_floor)


@dataclass
class GeneratorLoss:
    total: Tensor
    values: dict[str, Tensor]


class ReconstructionLoss(nn.Module):
    def __init__(self, config: LossConfig, sample_rate: int,
                 pitch_backend: str, pitch_hop_length: int, pqmf_bands: int, pqmf_taps: int):
        super().__init__()
        self.config = config
        self.stft = MultiResolutionSTFTLoss()
        self.multiband = MultiBandSTFTLoss(pqmf_bands, pqmf_taps)
        self.envelope = MultiScaleEnvelopeLoss()
        if pitch_backend == "differentiable_crepe_tiny":
            self.pitch = DifferentiableCrepeObjective(
                sample_rate, pitch_hop_length, config.pitch_temperature,
                config.pitch_target_sigma_cents, config.pitch_kl,
                config.pitch_activation, config.pitch_hard_negative,
                config.pitch_autocorrelation, config.pitch_negative_margin_logits,
                config.pitch_negative_exclusion_cents, config.pitch_negative_temperature,
            )
        elif pitch_backend == "spectral":
            self.pitch = SpectralPitchObjective(sample_rate)
        else:
            raise ValueError(f"unsupported pitch backend: {pitch_backend}")

    def forward(self, output: PairOutput, batch: dict[str, Tensor], target_timbre: Tensor,
                adversary_enabled: bool = True, self_scale: float = 1.0) -> GeneratorLoss:
        branch_names: list[str] = []
        audio_groups: list[tuple[Tensor, Tensor]] = []
        pitch_groups: list[tuple[Tensor, Tensor, Tensor, Tensor, Tensor]] = []
        if output.self_audio is not None:
            branch_names.append("self")
            audio_groups.append((output.self_audio, batch["audio_a"]))
            pitch_groups.append((output.self_audio, batch["audio_a"], batch["note_a"],
                                 batch["pitch_confidence_a"], batch["pitch_valid_mask_a"]))
        branch_names.append("cross")
        audio_groups.append((output.cross_audio, batch["audio_b"]))
        pitch_groups.append((output.cross_audio, batch["audio_b"], batch["note_b"],
                             batch["pitch_confidence_b"], batch["pitch_valid_mask_b"]))

        stft_values = self.stft.forward_groups(audio_groups)
        multiband_values = self.multiband.forward_groups(audio_groups)
        envelope_values = self.envelope.forward_groups(audio_groups)
        if hasattr(self.pitch, "forward_group_components"):
            pitch_components = self.pitch.forward_group_components(pitch_groups)
        else:
            pitch_values = self.pitch.forward_groups([
                (audio, note, confidence, valid)
                for audio, _, note, confidence, valid in pitch_groups
            ])
            pitch_components = [{"total": value} for value in pitch_values]
        sizes = [prediction.shape[0] for prediction, _ in audio_groups]
        predictions = torch.cat([prediction for prediction, _ in audio_groups], dim=0)
        targets = torch.cat([target for _, target in audio_groups], dim=0)
        all_rms = rms_db(torch.cat((predictions, targets), dim=0))
        prediction_rms = all_rms[:predictions.shape[0]]
        target_rms = all_rms[predictions.shape[0]:]

        terms: dict[str, Tensor] = {}
        diagnostics: dict[str, Tensor] = {}
        rms_by_branch: dict[str, tuple[Tensor, Tensor]] = {}
        offset = 0
        for index, (name, size) in enumerate(zip(branch_names, sizes)):
            branch_prediction_rms = prediction_rms[offset:offset + size]
            branch_target_rms = target_rms[offset:offset + size]
            rms_by_branch[name] = (branch_prediction_rms, branch_target_rms)
            terms[f"{name}_stft"] = stft_values[index] + 0.25 * multiband_values[index]
            terms[f"{name}_envelope"] = envelope_values[index]
            terms[f"{name}_pitch"] = pitch_components[index]["total"]
            for component_name, component_value in pitch_components[index].items():
                if component_name != "total":
                    diagnostics[f"{name}_pitch_{component_name}"] = component_value
            terms[f"{name}_rms"] = F.smooth_l1_loss(
                (branch_prediction_rms - branch_target_rms) / 20.0,
                torch.zeros_like(branch_target_rms),
            )
            offset += size

        if output.self_audio is not None:
            # A deterministic decoder does not observe the independently
            # sampled crop offsets.  Use complete-render RMS references for
            # relative velocity supervision; branch RMS reconstruction still
            # uses the actual training windows above.
            velocity_target_a = batch.get(
                "velocity_reference_rms_db_a", rms_by_branch["self"][1])
            velocity_target_b = batch.get(
                "velocity_reference_rms_db_b", rms_by_branch["cross"][1])
            terms["velocity_rank"] = velocity_ranking_from_rms(
                rms_by_branch["self"][0], rms_by_branch["cross"][0],
                velocity_target_a, velocity_target_b,
                batch["note_a"], batch["note_b"], batch["velocity_a"], batch["velocity_b"],
                self.config.velocity_margin_db,
            )
            terms["velocity_delta"] = velocity_delta_matching_from_rms(
                rms_by_branch["self"][0], rms_by_branch["cross"][0],
                velocity_target_a, velocity_target_b,
                batch["note_a"], batch["note_b"], batch["velocity_a"], batch["velocity_b"],
                self.config.velocity_margin_db, self.config.velocity_delta_scale_db,
            )
        terms["timbre_pair"] = (1 - F.cosine_similarity(output.timbre, target_timbre, dim=-1)).mean()
        terms["distribution"] = latent_distribution_loss(
            output.timbre, target_timbre, self.config.latent_std_floor,
            self.config.latent_distribution_backend)
        classes = batch["note_a"].long().clamp(0, 127)
        terms["pitch_adversary"] = (F.cross_entropy(output.pitch_logits, classes)
                                    if adversary_enabled else output.pitch_logits.sum() * 0)
        c = self.config
        weights = {
            "self_stft": c.self_stft, "self_envelope": c.self_envelope,
            "self_pitch": c.self_pitch, "self_rms": c.self_rms,
            "cross_stft": c.cross_stft, "cross_envelope": c.cross_envelope,
            "cross_pitch": c.cross_pitch, "cross_rms": c.cross_rms,
            "velocity_rank": c.velocity_rank, "velocity_delta": c.velocity_delta,
            "timbre_pair": c.timbre_pair,
            "distribution": c.distribution, "pitch_adversary": c.pitch_adversary,
        }
        total = output.cross_audio.new_zeros(())
        for name, value in terms.items():
            sampling_scale = (self_scale if name.startswith("self_")
                              or name in ("velocity_rank", "velocity_delta")
                              else 1.0)
            total = total + value * weights[name] * sampling_scale
        return GeneratorLoss(total, {**terms, **diagnostics})


class BraveScaleDiscriminator(nn.Module):
    def __init__(self):
        super().__init__()
        channels = (1, 32, 64, 128, 256)
        self.layers = nn.ModuleList([
            weight_norm(nn.Conv1d(channels[i], channels[i + 1], 15,
                                  stride=4, padding=7, bias=True))
            for i in range(len(channels) - 1)
        ])
        self.output = nn.Conv1d(channels[-1], 1, 1, bias=True)

    def forward(self, x: Tensor) -> tuple[Tensor, list[Tensor]]:
        features = []
        for layer in self.layers:
            hidden = layer(x)
            features.append(hidden)
            x = F.leaky_relu(hidden, 0.2)
        return self.output(x), features


class BraveMultiScaleDiscriminator(nn.Module):
    architecture_id = "brave_multiscale_v1"

    def __init__(self, scales: int = 3):
        super().__init__()
        if scales != 3:
            raise ValueError("BRAVE discriminator is fixed to exactly three scales")
        self.scales = nn.ModuleList([BraveScaleDiscriminator() for _ in range(scales)])

    def forward(self, x: Tensor) -> list[tuple[Tensor, list[Tensor]]]:
        outputs = []
        scaled = x
        for index, discriminator in enumerate(self.scales):
            if index:
                scaled = F.avg_pool1d(scaled, 2, 2)
            outputs.append(discriminator(scaled))
        return outputs


def discriminator_hinge(real, fake) -> Tensor:
    values = [F.relu(1 - r[0]).mean() + F.relu(1 + f[0]).mean() for r, f in zip(real, fake)]
    return torch.stack(values).mean()


def generator_adversarial(fake) -> Tensor:
    return torch.stack([-item[0].mean() for item in fake]).mean()


def _feature_statistics(value: Tensor) -> tuple[Tensor, Tensor, Tensor]:
    flat = value.float().flatten(2)
    mean = flat.mean(dim=-1)
    standard_deviation = flat.var(dim=-1, unbiased=False).add(1e-8).sqrt().log()
    if flat.shape[-1] > 1:
        delta_energy = (flat[..., 1:] - flat[..., :-1]).square().mean(-1).add(1e-8).sqrt().log()
    else:
        delta_energy = torch.full_like(mean, math.log(1e-4))
    return mean, standard_deviation, delta_energy


def feature_matching(real, fake) -> Tensor:
    values = []
    for (_, real_features), (_, fake_features) in zip(real, fake):
        for real_feature, fake_feature in zip(real_features, fake_features):
            real_mean, real_std, real_delta = _feature_statistics(real_feature.detach())
            fake_mean, fake_std, fake_delta = _feature_statistics(fake_feature)
            values.append(F.l1_loss(fake_mean, real_mean)
                          + F.l1_loss(fake_std, real_std)
                          + 0.5 * F.l1_loss(fake_delta, real_delta))
    return torch.stack(values).mean()
