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


class _LinearResample(nn.Module):
    """Dependency-free differentiable fallback used by CPU validation."""

    def __init__(self, source_rate: int, target_rate: int):
        super().__init__()
        self.ratio = float(target_rate) / float(source_rate)

    def forward(self, audio: Tensor) -> Tensor:
        size = max(1, int(round(audio.shape[-1] * self.ratio)))
        return F.interpolate(audio[:, None], size=size, mode="linear",
                             align_corners=False).squeeze(1)


@dataclass
class ClapWaveformGradient:
    """Frozen-CLAP loss values and first-order gradients at the waveform."""

    losses: Tensor
    gradients: Tensor
    gradient_norms: Tensor
    clipped_gradient_norms: Tensor


class FrozenClapReconstructionObjective(nn.Module):
    """Window-aligned differentiable CLAP reconstruction objective.

    Conditioning CLAP embeddings are cached from complete renders.  This
    objective has a different contract: it embeds the exact generated and
    target windows used by the reconstruction losses.  Targets are evaluated
    without autograd, while the generated waveform keeps a gradient through a
    frozen CLAP audio encoder.

    The trainer asks this module for dL/dwaveform before its regular model
    forward, releases the large CLAP activation graph, then injects that
    gradient into the matching regular decoder output.  This is the exact
    first-order chain rule at an identical deterministic output and avoids
    retaining CLAP and full-batch decoder activations at the same time.
    """

    CLAP_SAMPLE_RATE = 48000

    def __init__(self, checkpoint: str | None, sample_rate: int, device: torch.device,
                 maximum_gradient_norm: float = 1.0,
                 encoder: nn.Module | None = None):
        super().__init__()
        if maximum_gradient_norm < 0:
            raise ValueError("CLAP waveform gradient norm must be non-negative")
        self.maximum_gradient_norm = float(maximum_gradient_norm)
        if encoder is None:
            if not checkpoint:
                raise ValueError("CLAP reconstruction requires data.clap_checkpoint")
            import laion_clap
            encoder = laion_clap.CLAP_Module(
                enable_fusion=False, amodel="HTSAT-base", device=device)
            encoder.load_ckpt(str(checkpoint))
        self.encoder = encoder.to(device)
        self.encoder.requires_grad_(False)
        self.encoder.eval()
        if sample_rate == self.CLAP_SAMPLE_RATE:
            self.resample: nn.Module = nn.Identity()
        else:
            try:
                import torchaudio
                self.resample = torchaudio.transforms.Resample(
                    sample_rate, self.CLAP_SAMPLE_RATE).to(device)
            except (ImportError, OSError):
                self.resample = _LinearResample(sample_rate, self.CLAP_SAMPLE_RATE).to(device)

    def train(self, mode: bool = True) -> "FrozenClapReconstructionObjective":
        # CLAP contains BatchNorm/dropout modules.  It is a fixed perceptual
        # operator even while the surrounding training code is in train mode.
        super().train(False)
        self.encoder.eval()
        return self

    def _embedding(self, audio: Tensor, valid_samples: Tensor) -> Tensor:
        if audio.ndim != 3 or audio.shape[1] != 1:
            raise ValueError("CLAP reconstruction audio must have shape [B,1,T]")
        if valid_samples.shape != (audio.shape[0],):
            raise ValueError("CLAP valid_samples must have shape [B]")
        waveforms = []
        with torch.autocast(device_type=audio.device.type, enabled=False):
            for index in range(audio.shape[0]):
                length = int(valid_samples[index].item())
                length = max(1, min(length, audio.shape[-1]))
                waveform = audio[index, 0, :length].float().unsqueeze(0)
                waveform = self.resample(waveform)[0]
                waveforms.append(waveform)
            embedding = self.encoder.get_audio_embedding_from_data(
                waveforms, use_tensor=True)
            embedding = F.normalize(embedding.float(), dim=-1)
        if not bool(torch.isfinite(embedding).all().item()):
            raise RuntimeError("frozen CLAP produced a non-finite embedding")
        return embedding

    def waveform_gradients(self, prediction: Tensor, target: Tensor,
                           valid_samples: Tensor) -> ClapWaveformGradient:
        if prediction.shape != target.shape:
            raise ValueError("CLAP prediction and target windows must have identical shapes")
        generated = prediction.detach().float().requires_grad_(True)
        with torch.no_grad():
            target_embedding = self._embedding(target.detach().float(), valid_samples)
        generated_embedding = self._embedding(generated, valid_samples)
        losses = (1.0 - F.cosine_similarity(
            generated_embedding, target_embedding, dim=-1)).clamp_min(0.0)
        gradients, = torch.autograd.grad(losses.sum(), generated, allow_unused=False)
        if not bool(torch.isfinite(losses).all().item()):
            raise RuntimeError("CLAP reconstruction loss is non-finite")
        if not bool(torch.isfinite(gradients).all().item()):
            raise RuntimeError("CLAP reconstruction waveform gradient is non-finite")
        norms = gradients.flatten(1).norm(dim=1)
        if self.maximum_gradient_norm > 0:
            scale = (self.maximum_gradient_norm / norms.clamp_min(1e-12)).clamp(max=1.0)
            gradients = gradients * scale[:, None, None]
        clipped_norms = gradients.flatten(1).norm(dim=1)
        return ClapWaveformGradient(
            losses.detach(), gradients.detach(), norms.detach(), clipped_norms.detach())


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

    @staticmethod
    def _frame_mask(valid_samples: Tensor, frames: int, hop: int,
                    fft_size: int, device: torch.device) -> Tensor:
        centers = torch.arange(frames, device=device) * hop
        # center=True supplies legitimate left padding for the onset. At the
        # right edge, only frames whose analysis support ends in valid audio
        # are admitted, so zero padding cannot improve reconstruction metrics.
        return centers[None, :] + fft_size // 2 <= valid_samples[:, None]

    def forward_groups(self, groups: list[tuple[Tensor, ...]]) -> list[Tensor]:
        if not groups:
            return []
        parsed = [(item[0], item[1], item[2] if len(item) == 3 else
                   torch.full((item[0].shape[0],), item[0].shape[-1],
                              device=item[0].device, dtype=torch.long)) for item in groups]
        sizes = [prediction.shape[0] for prediction, _, _ in parsed]
        predictions = torch.cat([prediction for prediction, _, _ in parsed], dim=0)
        targets = torch.cat([target for _, target, _ in parsed], dim=0)
        valid = torch.cat([length for _, _, length in parsed]).long()
        total = [predictions.new_zeros(()) for _ in groups]
        prediction_count = predictions.shape[0]
        for fft_size in self.fft_sizes:
            magnitude = self.magnitude(torch.cat((predictions, targets), dim=0), fft_size)
            prediction_magnitude = magnitude[:prediction_count]
            target_magnitude = magnitude[prediction_count:]
            valid_frames = self._frame_mask(
                valid, magnitude.shape[-1], fft_size // 4, fft_size, magnitude.device)
            offset = 0
            for index, size in enumerate(sizes):
                p = prediction_magnitude[offset:offset + size]
                t = target_magnitude[offset:offset + size]
                mask = valid_frames[offset:offset + size, None, :].to(p)
                numerator = ((p - t).square() * mask).sum(dim=(-1, -2)).sqrt()
                denominator = (t.square() * mask).sum(dim=(-1, -2)).sqrt().clamp_min(1e-7)
                convergence = (numerator / denominator).mean()
                log_error = ((p.log() - t.log()).abs() * mask).sum(dim=(-1, -2))
                log_count = (mask.sum(dim=(-1, -2)) * p.shape[-2]).clamp_min(1.0)
                total[index] = total[index] + convergence + (log_error / log_count).mean()
                offset += size
        return [value / len(self.fft_sizes) for value in total]

    def forward(self, prediction: Tensor, target: Tensor,
                valid_samples: Tensor | None = None) -> Tensor:
        group = ((prediction, target) if valid_samples is None
                 else (prediction, target, valid_samples))
        return self.forward_groups([group])[0]


class MultiBandSTFTLoss(nn.Module):
    def __init__(self, bands: int, taps: int):
        super().__init__()
        self.pqmf = PQMF(bands, taps)
        self.loss = MultiResolutionSTFTLoss((1024, 512, 256, 128))
        self.bands = bands

    def forward_groups(self, groups: list[tuple[Tensor, ...]]) -> list[Tensor]:
        if not groups:
            return []
        parsed = [(item[0], item[1], item[2] if len(item) == 3 else
                   torch.full((item[0].shape[0],), item[0].shape[-1],
                              device=item[0].device, dtype=torch.long)) for item in groups]
        sizes = [prediction.shape[0] for prediction, _, _ in parsed]
        predictions = torch.cat([prediction for prediction, _, _ in parsed], dim=0)
        targets = torch.cat([target for _, target, _ in parsed], dim=0)
        valid = torch.cat([length for _, _, length in parsed]).long()
        count = predictions.shape[0]
        subbands = self.pqmf.analysis(torch.cat((predictions, targets), dim=0))
        prediction_bands = subbands[:count]
        target_bands = subbands[count:]
        band_groups = []
        offset = 0
        for group_index, size in enumerate(sizes):
            p = prediction_bands[offset:offset + size]
            t = target_bands[offset:offset + size]
            band_groups.append((
                p.reshape(size * self.bands, 1, p.shape[-1]),
                t.reshape(size * self.bands, 1, t.shape[-1]),
                torch.div(valid[offset:offset + size] + self.bands - 1,
                          self.bands, rounding_mode="floor").repeat_interleave(self.bands),
            ))
            offset += size
        return self.loss.forward_groups(band_groups)

    def forward(self, prediction: Tensor, target: Tensor,
                valid_samples: Tensor | None = None) -> Tensor:
        group = ((prediction, target) if valid_samples is None
                 else (prediction, target, valid_samples))
        return self.forward_groups([group])[0]


class MultiScaleEnvelopeLoss(nn.Module):
    def __init__(self, windows: tuple[int, ...] = (1024, 4096, 16384)):
        super().__init__()
        self.windows = windows

    @staticmethod
    def envelope(x: Tensor, window: int) -> Tensor:
        hop = max(1, window // 4)
        return F.avg_pool1d(x.square(), window, hop, padding=window // 2).clamp_min(1e-8).sqrt()

    def forward(self, prediction: Tensor, target: Tensor,
                valid_samples: Tensor | None = None) -> Tensor:
        group = ((prediction, target) if valid_samples is None
                 else (prediction, target, valid_samples))
        return self.forward_groups([group])[0]

    def forward_groups(self, groups: list[tuple[Tensor, ...]]) -> list[Tensor]:
        if not groups:
            return []
        parsed = [(item[0], item[1], item[2] if len(item) == 3 else
                   torch.full((item[0].shape[0],), item[0].shape[-1],
                              device=item[0].device, dtype=torch.long)) for item in groups]
        sizes = [prediction.shape[0] for prediction, _, _ in parsed]
        predictions = torch.cat([prediction for prediction, _, _ in parsed], dim=0)
        targets = torch.cat([target for _, target, _ in parsed], dim=0)
        valid = torch.cat([length for _, _, length in parsed]).long()
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
                hop = max(1, window // 4)
                centers = torch.arange(p.shape[-1], device=p.device) * hop
                mask = (centers[None, :] + window // 2
                        <= valid[offset:offset + size, None]).to(p)[:, None]
                count_frames = mask.sum().clamp_min(1.0)
                level = ((p - t).abs() * mask).sum() / (count_frames * p.shape[1])
                delta_mask = mask[..., 1:] * mask[..., :-1]
                delta_count = delta_mask.sum().clamp_min(1.0)
                delta = (((p[..., 1:] - p[..., :-1]) -
                          (t[..., 1:] - t[..., :-1])).abs() * delta_mask).sum()
                delta = delta / (delta_count * p.shape[1])
                total[index] = total[index] + level + 0.5 * delta
                offset += size
        return [value / len(self.windows) for value in total]


def rms_db(x: Tensor, valid_samples: Tensor | None = None) -> Tensor:
    value = x.float()
    if valid_samples is None:
        mean_square = value.square().mean(dim=(-1, -2))
    else:
        positions = torch.arange(value.shape[-1], device=value.device)
        mask = (positions[None, :] < valid_samples[:, None]).to(value)[:, None]
        mean_square = (value.square() * mask).sum(dim=(-1, -2)) / valid_samples.float().clamp_min(1)
    rms = torch.sqrt(mean_square + 1e-8)
    return 20.0 * torch.log10(rms + 1e-7)


def _masked_spectrum(audio: Tensor, valid_samples: Tensor, fft_size: int = 1024,
                     hop: int = 256) -> tuple[Tensor, Tensor]:
    with torch.autocast(device_type=audio.device.type, enabled=False):
        window = torch.hann_window(fft_size, device=audio.device, dtype=torch.float32)
        magnitude = torch.stft(
            audio.float().squeeze(1), fft_size, hop, fft_size, window,
            return_complex=True, center=True, pad_mode="constant",
        ).abs().clamp_min(1e-7)
        centers = torch.arange(magnitude.shape[-1], device=audio.device) * hop
        mask = centers[None, :] + fft_size // 2 <= valid_samples[:, None]
    return magnitude, mask


def spectral_flux_loss(prediction: Tensor, target: Tensor, valid_samples: Tensor) -> Tensor:
    values = []
    for audio in (prediction, target):
        magnitude, mask = _masked_spectrum(audio, valid_samples)
        normalized = magnitude / magnitude.sum(dim=1, keepdim=True).clamp_min(1e-7)
        flux = (normalized[..., 1:] - normalized[..., :-1]).square().sum(dim=1).sqrt()
        pair_mask = mask[..., 1:] & mask[..., :-1]
        values.append((flux * pair_mask).sum(-1) / pair_mask.sum(-1).clamp_min(1))
    return F.smooth_l1_loss(values[0], values[1])


def band_statistics_loss(prediction: Tensor, target: Tensor,
                         valid_samples: Tensor, bands: int = 16) -> Tensor:
    statistics = []
    for audio in (prediction, target):
        magnitude, mask = _masked_spectrum(audio, valid_samples)
        energy = magnitude.square()
        chunks = torch.tensor_split(energy, bands, dim=1)
        band_values = []
        frame_mask = mask[:, None].to(energy)
        for chunk in chunks:
            mean = (chunk * frame_mask).sum(dim=(-1, -2))
            denominator = (frame_mask.sum(dim=(-1, -2)) * chunk.shape[1]).clamp_min(1.0)
            band_values.append((mean / denominator).clamp_min(1e-8).log())
        statistics.append(torch.stack(band_values, dim=-1))
    return F.smooth_l1_loss(statistics[0], statistics[1])


class SpectralPitchObjective(nn.Module):
    """Every-step harmonic-comb and MIDI-period autocorrelation objective."""

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
                    valid: Tensor) -> tuple[dict[str, Tensor], Tensor]:
        with torch.autocast(device_type=audio.device.type, enabled=False):
            x = audio.float().squeeze(1)
            magnitude = torch.stft(x, self.fft_size, self.fft_size // 4, self.fft_size,
                                   self.window, return_complex=True,
                                   pad_mode="constant").abs().mean(-1)
            offsets = x.new_tensor((0.0, -1.0, 1.0, -12.0, 12.0))
            candidate_note = note.float()[:, None] + offsets[None]
            fundamental = midi_to_hz(candidate_note).to(x)
            harmonics = torch.arange(1, 9, device=x.device, dtype=torch.float32)
            frequencies = fundamental[..., None] * harmonics
            bins = torch.round(frequencies / (self.sample_rate / self.fft_size)).long()
            keep = frequencies.le(self.sample_rate / 2.0) & frequencies.ge(50.0)
            bins = bins.clamp(0, magnitude.shape[-1] - 1)
            gathered = magnitude[:, None, :].expand(-1, offsets.numel(), -1).gather(2, bins)
            harmonic_weight = (1.0 / harmonics)[None, None] * keep
            comb_score = (gathered.clamp_min(1e-7).log() * harmonic_weight).sum(-1)
            comb_score = comb_score / harmonic_weight.sum(-1).clamp_min(1e-7)
            comb = F.cross_entropy(comb_score * 4.0,
                                   torch.zeros(x.shape[0], device=x.device, dtype=torch.long),
                                   reduction="none")

            lag = (self.sample_rate / midi_to_hz(note).to(x)).round().long()
            maximum_lag = int(math.ceil(self.sample_rate / 50.0))
            lag = lag.clamp(1, maximum_lag)
            usable = x.shape[-1] - maximum_lag
            base = x[:, :usable]
            indices = torch.arange(usable, device=x.device)[None] + lag[:, None]
            shifted = x.gather(1, indices)
            numerator = (base * shifted).sum(-1)
            denominator = (base.square().sum(-1) * shifted.square().sum(-1)).clamp_min(1e-12).sqrt()
            correlation = numerator / denominator
            autocorrelation = F.relu(0.3 - correlation)
            sample_weight = (valid.float() * confidence.float()).mean(-1)
            return {
                "comb": comb * sample_weight,
                "autocorrelation": autocorrelation * sample_weight,
            }, sample_weight

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
            group_denominator = denominator[offset:offset + size]
            comb = numerator["comb"][offset:offset + size].sum() / group_denominator.sum().clamp_min(1e-7)
            autocorrelation = (numerator["autocorrelation"][offset:offset + size].sum()
                               / group_denominator.sum().clamp_min(1e-7))
            values.append(comb + 0.25 * autocorrelation)
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
        sizes = [group[0].shape[0] for group in legacy_groups]
        numerators, denominator = self._statistics(
            torch.cat([item[0] for item in legacy_groups]),
            torch.cat([item[1] for item in legacy_groups]),
            torch.cat([item[2] for item in legacy_groups]),
            torch.cat([item[3] for item in legacy_groups]),
        )
        output = []
        offset = 0
        for size in sizes:
            scale = denominator[offset:offset + size].sum().clamp_min(1e-7)
            comb = numerators["comb"][offset:offset + size].sum() / scale
            autocorrelation = numerators["autocorrelation"][offset:offset + size].sum() / scale
            total = comb + 0.25 * autocorrelation
            output.append({
                "total": total, "comb": comb, "autocorrelation": autocorrelation,
                "cents": total * 0.0, "distribution": total * 0.0,
                "activation": total * 0.0, "hard_negative": total * 0.0,
            })
            offset += size
        return output

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
        try:
            import torchaudio
            self.resample = torchaudio.transforms.Resample(sample_rate, self.CREPE_SAMPLE_RATE)
        except (ImportError, OSError):
            self.resample = _LinearResample(sample_rate, self.CREPE_SAMPLE_RATE)
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


class SafeCrepeObjective(nn.Module):
    """CREPE loss with an isolated, sanitized waveform-gradient boundary."""

    def __init__(self, objective: DifferentiableCrepeObjective, maximum_gradient_norm: float):
        super().__init__()
        self.objective = objective
        self.maximum_gradient_norm = float(maximum_gradient_norm)

    def forward_group_components(
            self, groups: list[tuple[Tensor, Tensor, Tensor, Tensor, Tensor]]) -> list[dict[str, Tensor]]:
        results: list[dict[str, Tensor]] = []
        for audio, target_audio, note, confidence, valid in groups:
            detached = audio.detach().float().requires_grad_(True)
            try:
                components = self.objective.forward_group_components([
                    (detached, target_audio.detach(), note, confidence, valid)
                ])[0]
                value = components["total"]
                if not bool(torch.isfinite(value).item()):
                    raise FloatingPointError("non-finite CREPE forward loss")
                gradient = torch.autograd.grad(value, detached, retain_graph=False,
                                               create_graph=False, allow_unused=True)[0]
                if gradient is None:
                    raise FloatingPointError("CREPE produced no waveform gradient")
                gradient = torch.nan_to_num(gradient, nan=0.0, posinf=0.0, neginf=0.0)
                norms = gradient.flatten(1).norm(dim=1)
                scale = (self.maximum_gradient_norm / norms.clamp_min(1e-12)).clamp(max=1.0)
                gradient = gradient * scale.view(-1, 1, 1)
                surrogate = value.detach() + ((audio.float() - audio.float().detach())
                                                * gradient.detach()).sum()
                results.append({
                    **{name: component.detach() for name, component in components.items()},
                    "total": surrogate,
                    "crepe_skipped": value.detach() * 0.0,
                    "crepe_gradient_norm": norms.mean().detach(),
                })
            except (RuntimeError, FloatingPointError):
                zero = audio.float().sum() * 0.0
                results.append({
                    "total": zero, "cents": zero.detach(), "distribution": zero.detach(),
                    "activation": zero.detach(), "hard_negative": zero.detach(),
                    "autocorrelation": zero.detach(),
                    "crepe_skipped": zero.detach() + 1.0,
                    "crepe_gradient_norm": zero.detach(),
                })
        return results


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
                     margin_db: float,
                     velocity_known_a: Tensor | None = None,
                     velocity_known_b: Tensor | None = None) -> tuple[Tensor, Tensor, Tensor]:
    target_delta = audio_b_rms - audio_a_rms
    prediction_delta = cross_rms - self_rms
    direction = torch.sign(target_delta)
    active = (note_a.eq(note_b) & velocity_a.ne(velocity_b)
              & direction.ne(0) & target_delta.abs().ge(margin_db))
    if velocity_known_a is not None:
        active &= velocity_known_a.bool()
    if velocity_known_b is not None:
        active &= velocity_known_b.bool()
    return target_delta, prediction_delta, active


def velocity_ranking_from_rms(self_rms: Tensor, cross_rms: Tensor,
                              audio_a_rms: Tensor, audio_b_rms: Tensor,
                              note_a: Tensor, note_b: Tensor,
                              velocity_a: Tensor, velocity_b: Tensor,
                              margin_db: float,
                              velocity_known_a: Tensor | None = None,
                              velocity_known_b: Tensor | None = None) -> Tensor:
    target_delta, prediction_delta, active = _velocity_deltas(
        self_rms, cross_rms, audio_a_rms, audio_b_rms,
        note_a, note_b, velocity_a, velocity_b, margin_db,
        velocity_known_a, velocity_known_b,
    )
    direction = torch.sign(target_delta)
    if not active.any():
        return prediction_delta.sum() * 0.0
    return F.relu(margin_db - direction[active] * prediction_delta[active]).mean()


def velocity_delta_matching_from_rms(self_rms: Tensor, cross_rms: Tensor,
                                     audio_a_rms: Tensor, audio_b_rms: Tensor,
                                     note_a: Tensor, note_b: Tensor,
                                     velocity_a: Tensor, velocity_b: Tensor,
                                     margin_db: float, scale_db: float = 6.0,
                                     velocity_known_a: Tensor | None = None,
                                     velocity_known_b: Tensor | None = None) -> Tensor:
    if scale_db <= 0:
        raise ValueError("velocity delta scale must be positive")
    target_delta, prediction_delta, active = _velocity_deltas(
        self_rms, cross_rms, audio_a_rms, audio_b_rms,
        note_a, note_b, velocity_a, velocity_b, margin_db,
        velocity_known_a, velocity_known_b,
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
        self.pitch = SpectralPitchObjective(sample_rate)
        self.crepe: SafeCrepeObjective | None = None
        if pitch_backend == "differentiable_crepe_tiny":
            raw_crepe = DifferentiableCrepeObjective(
                sample_rate, pitch_hop_length, config.pitch_temperature,
                config.pitch_target_sigma_cents, config.pitch_kl,
                config.pitch_activation, config.pitch_hard_negative,
                config.pitch_autocorrelation, config.pitch_negative_margin_logits,
                config.pitch_negative_exclusion_cents, config.pitch_negative_temperature,
            )
            self.crepe = SafeCrepeObjective(raw_crepe, config.crepe_gradient_norm)
        elif pitch_backend == "spectral":
            pass
        else:
            raise ValueError(f"unsupported pitch backend: {pitch_backend}")

    def _crepe_enabled(self, update: int) -> bool:
        if self.crepe is None or update >= self.config.crepe_train_stop:
            return False
        interval = (self.config.crepe_every_until_1k if update < 1000
                    else self.config.crepe_every_until_5k)
        return interval > 0 and update % interval == 0

    def forward(self, output: PairOutput, batch: dict[str, Tensor], target_timbre: Tensor,
                adversary_enabled: bool = True, self_scale: float = 1.0,
                generator_update: int = 0,
                force_crepe: bool | None = None) -> GeneratorLoss:
        branch_names: list[str] = []
        audio_groups: list[tuple[Tensor, Tensor, Tensor]] = []
        pitch_groups: list[tuple[Tensor, Tensor, Tensor, Tensor, Tensor]] = []
        if output.self_audio is not None:
            branch_names.append("self")
            self_valid = batch.get(
                "valid_samples_a",
                torch.full_like(batch["note_a"], output.self_audio.shape[-1]),
            )
            audio_groups.append((output.self_audio, batch["audio_a"], self_valid))
            pitch_groups.append((output.self_audio, batch["audio_a"], batch["note_a"],
                                 batch["pitch_confidence_a"], batch["pitch_valid_mask_a"]))
        branch_names.append("cross")
        cross_valid = batch.get(
            "valid_samples_b",
            torch.full_like(batch["note_b"], output.cross_audio.shape[-1]),
        )
        audio_groups.append((output.cross_audio, batch["audio_b"], cross_valid))
        pitch_groups.append((output.cross_audio, batch["audio_b"], batch["note_b"],
                             batch["pitch_confidence_b"], batch["pitch_valid_mask_b"]))

        stft_values = self.stft.forward_groups(audio_groups)
        multiband_values = self.multiband.forward_groups(audio_groups)
        envelope_values = self.envelope.forward_groups(audio_groups)
        if hasattr(self.pitch, "forward_group_components"):
            analytic_components = self.pitch.forward_group_components(pitch_groups)
        else:
            pitch_values = self.pitch.forward_groups([
                (audio, note, confidence, valid)
                for audio, _, note, confidence, valid in pitch_groups
            ])
            analytic_components = [{"total": value} for value in pitch_values]
        use_crepe = self._crepe_enabled(generator_update) if force_crepe is None else force_crepe
        crepe_components = (self.crepe.forward_group_components(pitch_groups)
                            if use_crepe and self.crepe is not None else None)
        pitch_components: list[dict[str, Tensor]] = []
        for index, analytic in enumerate(analytic_components):
            components = {
                f"analytic_{name}": value for name, value in analytic.items()
                if name != "total"
            }
            total = self.config.analytic_pitch * analytic["total"]
            if crepe_components is not None:
                total = total + crepe_components[index]["total"]
                components.update({
                    f"crepe_{name}": value for name, value in crepe_components[index].items()
                    if name != "total"
                })
            components["total"] = total
            components["crepe_executed"] = total.detach() * 0.0 + float(
                crepe_components is not None)
            pitch_components.append(components)

        sizes = [prediction.shape[0] for prediction, _, _ in audio_groups]
        predictions = torch.cat([prediction for prediction, _, _ in audio_groups], dim=0)
        targets = torch.cat([target for _, target, _ in audio_groups], dim=0)
        valid_lengths = torch.cat([valid for _, _, valid in audio_groups]).long()
        all_rms = rms_db(
            torch.cat((predictions, targets), dim=0),
            torch.cat((valid_lengths, valid_lengths)),
        )
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
            prediction, target, valid = audio_groups[index]
            flux_weight = (self.config.self_spectral_flux if name == "self"
                           else self.config.cross_spectral_flux)
            band_weight = (self.config.self_band_statistics if name == "self"
                           else self.config.cross_band_statistics)
            terms[f"{name}_spectral_flux"] = (
                spectral_flux_loss(prediction, target, valid)
                if flux_weight else prediction.sum() * 0.0)
            terms[f"{name}_band_statistics"] = (
                band_statistics_loss(prediction, target, valid)
                if band_weight else prediction.sum() * 0.0)
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
                batch.get("velocity_known_a"), batch.get("velocity_known_b"),
            )
            terms["velocity_delta"] = velocity_delta_matching_from_rms(
                rms_by_branch["self"][0], rms_by_branch["cross"][0],
                velocity_target_a, velocity_target_b,
                batch["note_a"], batch["note_b"], batch["velocity_a"], batch["velocity_b"],
                self.config.velocity_margin_db, self.config.velocity_delta_scale_db,
                batch.get("velocity_known_a"), batch.get("velocity_known_b"),
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
            "self_spectral_flux": c.self_spectral_flux,
            "self_band_statistics": c.self_band_statistics,
            "cross_stft": c.cross_stft, "cross_envelope": c.cross_envelope,
            "cross_pitch": c.cross_pitch, "cross_rms": c.cross_rms,
            "cross_spectral_flux": c.cross_spectral_flux,
            "cross_band_statistics": c.cross_band_statistics,
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
