from __future__ import annotations

import sys
import types
from dataclasses import replace
from pathlib import Path

import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from midibrave.cli import create_fixture
from midibrave.config import Config, ModelConfig
from midibrave.data import (PairDataset, _eligible_pitch_offset_frames, _frame_rms,
                            finalize_cache_manifest, load_manifest, validate_manifest)
from midibrave.evaluate import (pitch_measurements, ripple_error, spectral_metrics,
                                transient_metrics)
from midibrave.losses import (BraveMultiScaleDiscriminator, DifferentiableCrepeObjective,
                              MultiResolutionSTFTLoss, MultiScaleEnvelopeLoss, ReconstructionLoss,
                              discriminator_hinge, feature_matching, generator_adversarial,
                              latent_distribution_loss, rms_db,
                              velocity_delta_matching_loss, velocity_ranking_loss)
from midibrave.model import (ConditionalOutputGain, FiLM, FixedAntiAlias,
                             HarmonicExcitation, MidiBrave, PQMF, PairOutput)
from midibrave.trainer import _pitch_adversary_scale, _self_branch_schedule


def test_fractional_autocorrelation_ranks_periodic_signal_over_noise():
    sample_rate = 16_000
    frequency = 440.0
    time = torch.arange(1024, dtype=torch.float32) / sample_rate
    sine = torch.sin(2 * torch.pi * frequency * time).view(1, 1, -1).expand(1, 3, -1)
    generator = torch.Generator().manual_seed(7)
    noise = torch.randn(1, 3, 1024, generator=generator)
    lag = torch.tensor([sample_rate / frequency])
    maximum_lag = 320
    periodic = DifferentiableCrepeObjective._fractional_autocorrelation(
        sine, lag, maximum_lag)
    random = DifferentiableCrepeObjective._fractional_autocorrelation(
        noise, lag, maximum_lag)
    assert periodic.mean() > 0.95
    assert random.abs().mean() < 0.15


class _NonFiniteCrepe(nn.Module):
    def forward(self, frames: torch.Tensor) -> torch.Tensor:
        # Preserve an autograd path to the audio while deterministically
        # simulating the rare non-finite frozen-CREPE output seen in job 881.
        base = frames.mean(dim=-1, keepdim=True)
        return base.expand(-1, 360) * float("nan")


def test_crepe_nonfinite_activation_is_masked_without_probability_bce_assert(monkeypatch):
    fake = _NonFiniteCrepe()
    monkeypatch.setattr(
        DifferentiableCrepeObjective, "_crepe_model",
        staticmethod(lambda device: fake.to(device)),
    )
    objective = DifferentiableCrepeObjective(
        44_100, 128, 0.1, 25.0, 0.0,
        activation_weight=1.0, hard_negative_weight=0.25,
        autocorrelation_weight=0.0,
    )
    audio = torch.zeros(1, 1, 4096, requires_grad=True)
    components = objective.forward_group_components([(
        audio, torch.tensor([69]), torch.ones(1, 32),
        torch.ones(1, 32, dtype=torch.bool),
    )])[0]

    assert all(torch.isfinite(value) for value in components.values())
    assert all(value.item() == 0.0 for value in components.values())
    components["total"].backward()
    assert audio.grad is not None and torch.isfinite(audio.grad).all()
    assert audio.grad.abs().sum().item() == 0.0


def test_conditional_output_gain_is_identity_at_initialization_and_trainable():
    module = ConditionalOutputGain(timbre_dim=128, midi_dim=32, hidden=32, max_db=12.0)
    waveform = torch.randn(3, 1, 256)
    timbre = torch.randn(3, 128)
    midi = torch.randn(3, 32, 4)
    output = module(waveform, timbre, midi)
    assert torch.equal(output, waveform)
    assert sum(parameter.numel() for parameter in module.parameters()) == 5_185
    output.square().mean().backward()
    assert module.net[-1].weight.grad is not None
    assert module.net[-1].weight.grad.abs().sum() > 0


def test_evaluation_pitch_measurements_uses_singleton_source_rate_torchcrepe(monkeypatch):
    captured = {}

    def fake_predict(audio, sample_rate, hop_length, *args, **kwargs):
        captured.setdefault("predict_shapes", []).append(tuple(audio.shape))
        captured.setdefault("predict_rates", []).append(sample_rate)
        captured.setdefault("predict_hops", []).append(hop_length)
        pitch = torch.full((audio.shape[0], 8), 440.0, device=audio.device)
        return pitch, torch.ones_like(pitch)

    fake_torchcrepe = types.SimpleNamespace(predict=fake_predict)
    monkeypatch.setitem(sys.modules, "torchcrepe", fake_torchcrepe)

    errors, medians, periodicity = pitch_measurements(
        torch.zeros(2, 1, 49_152), torch.tensor([69, 69]), 44_100, 512)

    assert captured == {
        "predict_shapes": [(1, 49_152), (1, 49_152)],
        "predict_rates": [44_100, 44_100],
        "predict_hops": [512, 512],
    }
    assert errors == [0.0] * 16
    assert medians == [0.0, 0.0]
    assert periodicity == [1.0] * 16


def test_fixture_and_pairing(tmp_path: Path):
    manifest = create_fixture(tmp_path / "fixture", samples=4096)
    config = Config.load(Path(__file__).parents[1] / "configs" / "smoke.yaml")
    data = replace(config.data, manifest=str(manifest), cache_root=str(manifest.parent / "cache"),
                   dataset_root=str(manifest.parent), window_samples=4096, repeats=4)
    dataset = PairDataset(data, 7)
    assert len(load_manifest(manifest)) == 32
    sample = dataset[0]
    assert sample["audio_a"].shape == (1, 4096)
    assert sample["clap_a"].shape == (512,)
    assert sample["pitch_f0_a"].shape == sample["pitch_valid_mask_a"].shape == (32,)
    assert sample["crop_offset_a"].item() % 128 == 0
    assert sample["pitch_valid_mask_a"].all()
    assert torch.isfinite(sample["velocity_reference_rms_db_a"])
    assert torch.isfinite(sample["velocity_reference_rms_db_b"])
    assert sample["preset_id"].startswith("preset-")
    assert sample["pair_mode"] == "pitch"
    assert sample["midi_note_sent_a"].item() == sample["note_a"].item()
    observed = [dataset[index]["pair_mode"] for index in range(8)]
    assert observed == ["pitch", "pitch", "velocity", "pitch_velocity"] * 2


def test_finalize_cache_manifest_is_auditable_and_preserves_sparse_pairs(tmp_path: Path):
    manifest = create_fixture(tmp_path / "fixture", samples=4096)
    config = Config.load(Path(__file__).parents[1] / "configs" / "smoke.yaml")
    data = replace(
        config.data, manifest=str(manifest), cache_root=str(manifest.parent / "cache"),
        dataset_root=str(manifest.parent), window_samples=4096,
    )
    first = load_manifest(manifest)[0]
    (manifest.parent / "cache" / "clap" / f"{first.sample_id}.npy").unlink()
    output = tmp_path / "eligible.jsonl"
    result = finalize_cache_manifest(manifest, data, output)
    assert result["source_samples"] == 32
    assert result["cache_eligible_samples"] == result["retained_samples"] == 31
    assert result["retained_presets"] == 4
    assert result["cache_rejections"]["missing_clap"] == 1
    assert len(result["eligible_manifest_sha256"]) == 64
    assert len(load_manifest(output)) == 31
    eligible_data = replace(
        data, manifest=str(output), manifest_metadata=str(output.with_suffix(".meta.json")))
    validate_manifest(load_manifest(output), eligible_data, output)
    PairDataset(eligible_data, 7)


def test_frame_rms_clips_crepe_tail_frames_to_audio_bounds():
    audio = torch.linspace(-1.0, 1.0, 1000).numpy()
    values = _frame_rms(audio, frames=12, hop_length=128)
    assert values.shape == (12,)
    assert torch.from_numpy(values).isfinite().all()


def test_pitch_window_uses_frame_coverage_instead_of_contiguous_sustain():
    config = Config.load(Path(__file__).parents[1] / "configs" / "smoke.yaml")
    data = replace(config.data, window_samples=4096, pitch_window_valid_ratio_min=0.15)
    valid = torch.zeros(32, dtype=torch.bool)
    valid[::6] = True
    offsets = _eligible_pitch_offset_frames(valid.numpy(), data)
    assert offsets.tolist() == [0]
    assert not any(valid[index:index + 2].all() for index in range(len(valid) - 1))


def test_quality_metrics_are_zero_for_identical_audio():
    audio = torch.randn(2, 1, 4096).tanh()
    lsd, upper = spectral_metrics(audio, audio, 44100)
    generated_click, target_click, crest_error = transient_metrics(audio, audio, 44100)
    assert torch.allclose(lsd, torch.zeros_like(lsd))
    assert torch.allclose(upper, torch.zeros_like(upper))
    assert torch.equal(generated_click, target_click)
    assert torch.allclose(crest_error, torch.zeros_like(crest_error))
    assert torch.allclose(ripple_error(audio, audio), torch.zeros(2))


def test_film_starts_as_identity():
    film = FiLM(12, 8)
    x = torch.randn(2, 8, 20)
    condition = torch.randn(2, 12, 5)
    assert torch.equal(film(x, condition), x)


def test_pqmf_exact_shapes_and_reconstruction_metric():
    pqmf = PQMF(16)
    x = torch.randn(1, 1, 65536)
    subbands = pqmf.analysis(x)
    output = pqmf.synthesis(subbands, x.shape[-1])
    assert subbands.shape == (1, 16, 4096)
    assert output.shape == x.shape
    valid = slice(pqmf.taps, -pqmf.taps)
    error = (x[..., valid] - output[..., valid]).square().mean()
    snr = 10 * torch.log10(x[..., valid].square().mean() / error.clamp_min(1e-12))
    assert snr >= 60.0, f"PQMF reconstruction SNR is only {snr.item():.2f} dB"


def test_anti_image_filter_response():
    anti_alias = FixedAntiAlias(2, 31)
    response = torch.fft.rfft(anti_alias.kernel.flatten(), 32768).abs().clamp_min(1e-12)
    frequency = torch.linspace(0.0, 1.0, response.numel())
    response_db = 20 * torch.log10(response / response[0])
    passband = response_db[frequency <= 0.35]
    stopband = response_db[frequency >= 0.75]
    assert passband.max() - passband.min() <= 0.1
    assert stopband.max() <= -45.0


def test_midi_condition_has_no_fake_window_onset():
    config = ModelConfig(clap_dim=512, timbre_dim=128, midi_dim=32, capacity=2,
                         pqmf_bands=16, ratios=[2, 2, 2, 1], pitch_backend="spectral",
                         warmup_latent_frames=2)
    model = MidiBrave(config, 4096, 44100)
    z = model.midi(torch.tensor([60]), torch.tensor([127.0]), 20)
    assert torch.allclose(z[..., 1:], z[..., :-1], atol=1e-6)
    assert all(block.film.affine.in_channels == 32
               for stage in model.decoder.blocks for block in stage)
    assert all(block.excitation_film.affine.in_channels == 16
               for stage in model.decoder.blocks for block in stage)
    levels = model.decoder.conditioning_levels(torch.randn(1, 16, 160))
    assert [level.shape[-1] for level in levels] == [40, 80, 160, 160]


def test_only_last_high_channel_residual_tail_uses_fp32_guard():
    config = ModelConfig(clap_dim=512, timbre_dim=128, midi_dim=32, capacity=2,
                         pqmf_bands=16, ratios=[2, 2, 2, 1], pitch_backend="spectral",
                         warmup_latent_frames=2)
    model = MidiBrave(config, 4096, 44100)
    guarded = [(stage_index, block_index)
               for stage_index, stage in enumerate(model.decoder.blocks)
               for block_index, block in enumerate(stage) if block.fp32_tail]
    assert guarded == [(0, 2)]


def test_harmonic_excitation_supplies_a_real_note_clock():
    excitation = HarmonicExcitation(44100, 64, 0.1)
    notes = torch.tensor([48, 60])
    audio = excitation(notes, 32768)
    assert audio.shape == (2, 1, 32768)
    measured_rms = audio.square().mean(-1).sqrt().squeeze(1)
    assert torch.allclose(measured_rms, torch.full_like(measured_rms, 0.1), atol=1e-5)
    spectrum = torch.fft.rfft(audio.squeeze(1)).abs()
    frequency = torch.fft.rfftfreq(audio.shape[-1], 1 / 44100)
    peak_hz = frequency[spectrum.argmax(-1)]
    expected = 440.0 * torch.pow(2.0, (notes.float() - 69.0) / 12.0)
    assert torch.allclose(peak_hz, expected, atol=2.0)


def test_dual_branch_shapes_gradients_and_no_loudness_head():
    config = ModelConfig(clap_dim=512, timbre_dim=128, midi_dim=32, capacity=2,
                         pqmf_bands=16, ratios=[2, 2, 2, 1], pitch_backend="spectral",
                         warmup_latent_frames=2)
    model = MidiBrave(config, 4096, 44100)
    clap = torch.randn(1, 512)
    output = model(clap, torch.tensor([48]), torch.tensor([50.0]),
                   torch.tensor([60]), torch.tensor([127.0]), torch.randn_like(clap))
    assert output.self_audio.shape == output.cross_audio.shape == (1, 1, 4096)
    assert output.pitch_logits.shape == (1, 128)
    assert not hasattr(model.decoder, "loudness")
    (output.self_audio.mean() + output.cross_audio.mean()).backward()
    assert model.decoder.output.weight.grad is not None
    assert all(block.excitation_film.affine.weight.grad is not None
               for stage in model.decoder.blocks for block in stage)


def test_static_condition_fast_path_matches_dense_path():
    dense_config = ModelConfig(
        clap_dim=512, timbre_dim=128, midi_dim=32, capacity=2,
        pqmf_bands=16, ratios=[2, 2, 2, 1], pitch_backend="spectral",
        warmup_latent_frames=2, excitation_harmonics=8,
    )
    fast_config = replace(dense_config, static_condition_fast_path=True)
    dense = MidiBrave(dense_config, 4096, 44100)
    fast = MidiBrave(fast_config, 4096, 44100)
    fast.load_state_dict(dense.state_dict())
    clap = torch.randn(2, 512)
    arguments = (clap, torch.tensor([48, 60]), torch.tensor([50.0, 127.0]),
                 torch.tensor([60, 48]), torch.tensor([127.0, 50.0]), torch.randn_like(clap))
    dense_output = dense(*arguments)
    fast_output = fast(*arguments)
    assert torch.allclose(fast_output.self_audio, dense_output.self_audio, atol=2e-5, rtol=2e-5)
    assert torch.allclose(fast_output.cross_audio, dense_output.cross_audio, atol=2e-5, rtol=2e-5)


def test_excitation_band_cache_matches_online_path():
    online_config = ModelConfig(
        clap_dim=512, timbre_dim=128, midi_dim=32, capacity=2,
        pqmf_bands=16, ratios=[2, 2, 2, 1], pitch_backend="spectral",
        warmup_latent_frames=2, excitation_harmonics=8, static_condition_fast_path=True,
    )
    cached_config = replace(
        online_config, cache_excitation_bands=True, excitation_cache_note_chunk=16)
    online = MidiBrave(online_config, 4096, 44100)
    cached = MidiBrave(cached_config, 4096, 44100)
    cached.load_state_dict(online.state_dict())
    cached.prepare_runtime_caches()
    clap = torch.randn(1, 512)
    arguments = (clap, torch.tensor([48]), torch.tensor([50.0]),
                 torch.tensor([60]), torch.tensor([127.0]), torch.randn_like(clap))
    online_output = online(*arguments)
    cached_output = cached(*arguments)
    assert cached.excitation_band_bank.shape[0] == 128
    assert torch.equal(cached_output.self_audio, online_output.self_audio)
    assert torch.equal(cached_output.cross_audio, online_output.cross_audio)


def test_grouped_stft_preserves_per_branch_formula():
    loss = MultiResolutionSTFTLoss((256, 128))
    groups = [(torch.randn(2, 1, 2048), torch.randn(2, 1, 2048)),
              (torch.randn(3, 1, 2048), torch.randn(3, 1, 2048))]
    grouped = loss.forward_groups(groups)
    separate = [loss(prediction, target) for prediction, target in groups]
    assert all(torch.allclose(a, b, atol=1e-6, rtol=1e-6)
               for a, b in zip(grouped, separate))


def test_latent_moments_matches_gather_backend_without_ddp():
    first = torch.randn(8, 16, requires_grad=True)
    second = torch.randn(8, 16, requires_grad=True)
    gather = latent_distribution_loss(first, second, 0.2, "gather")
    moments = latent_distribution_loss(first, second, 0.2, "moments")
    assert torch.allclose(gather, moments, atol=1e-6, rtol=1e-5)


def test_latent_moments_is_stable_with_large_common_offset():
    first = 64.0 + torch.randn(8, 16) * 0.02
    second = 64.0 + torch.randn(8, 16) * 0.02
    gather = latent_distribution_loss(first, second, 0.2, "gather")
    moments = latent_distribution_loss(first, second, 0.2, "moments")
    assert torch.allclose(gather, moments, atol=1e-6, rtol=1e-5)


def test_self_schedule_is_deterministic_and_unbiased_weighted():
    config = Config.load(Path(__file__).parents[1] / "configs" / "smoke.yaml")
    phase1 = [_self_branch_schedule(config, 1, step) for step in range(4)]
    phase2 = [_self_branch_schedule(config, 2, step) for step in range(4)]
    assert phase1 == phase2 == [(False, 0.0), (True, 2.0),
                                (False, 0.0), (True, 2.0)]


def test_pitch_adversary_ramps_in_phase1_and_stays_enabled_in_phase2():
    config = Config.load(Path(__file__).parents[1] / "configs" / "smoke.yaml")
    start = config.train.pitch_adversary_start
    ramp = config.train.pitch_adversary_ramp
    assert _pitch_adversary_scale(config, 1, start - 1) == 0.0
    assert _pitch_adversary_scale(config, 1, start) == 1.0 / ramp
    assert _pitch_adversary_scale(config, 1, start + ramp - 1) == 1.0
    assert _pitch_adversary_scale(config, 2, 0) == 1.0
    assert _pitch_adversary_scale(config, 2, config.train.phase2_steps - 1) == 1.0


def test_velocity_ranking_masks_and_direction():
    target_low = torch.full((1, 1, 2048), 0.1)
    target_high = torch.full((1, 1, 2048), 0.3)
    predicted_low = torch.full((1, 1, 2048), 0.1, requires_grad=True)
    predicted_high = torch.full((1, 1, 2048), 0.3, requires_grad=True)
    note = torch.tensor([60])
    low = torch.tensor([50.0])
    high = torch.tensor([127.0])
    equal = velocity_ranking_loss(predicted_low, predicted_high, target_low, target_high,
                                  note, note, low, low, 1.0)
    different_note = velocity_ranking_loss(predicted_low, predicted_high, target_low, target_high,
                                           note, note + 1, low, high, 1.0)
    correct = velocity_ranking_loss(predicted_low, predicted_high, target_low, target_high,
                                    note, note, low, high, 1.0)
    reversed_order = velocity_ranking_loss(predicted_high, predicted_low, target_low, target_high,
                                           note, note, low, high, 1.0)
    assert equal.item() == 0.0
    assert different_note.item() == 0.0
    assert correct.item() == 0.0
    assert reversed_order.item() > 1.0


def test_velocity_ranking_follows_observed_non_monotonic_audio():
    target_v50 = torch.full((1, 1, 2048), 0.3)
    target_v127 = torch.full((1, 1, 2048), 0.1)
    predicted_v50 = torch.full((1, 1, 2048), 0.3, requires_grad=True)
    predicted_v127 = torch.full((1, 1, 2048), 0.1, requires_grad=True)
    note = torch.tensor([60])
    loss = velocity_ranking_loss(
        predicted_v50, predicted_v127, target_v50, target_v127, note, note,
        torch.tensor([50.0]), torch.tensor([127.0]), 1.0)
    wrong = velocity_ranking_loss(
        predicted_v127, predicted_v50, target_v50, target_v127, note, note,
        torch.tensor([50.0]), torch.tensor([127.0]), 1.0)
    assert loss.item() == 0.0
    assert wrong.item() > 1.0


def test_velocity_delta_matches_observed_db_difference_and_masks_invalid_pairs():
    target_low = torch.full((1, 1, 2048), 0.1)
    target_high = torch.full((1, 1, 2048), 0.4)
    predicted_low = torch.full((1, 1, 2048), 0.2, requires_grad=True)
    predicted_high = torch.full((1, 1, 2048), 0.2, requires_grad=True)
    note = torch.tensor([60])
    low = torch.tensor([50.0])
    high = torch.tensor([127.0])
    exact = velocity_delta_matching_loss(
        target_low, target_high, target_low, target_high,
        note, note, low, high, 1.0)
    collapsed = velocity_delta_matching_loss(
        predicted_low, predicted_high, target_low, target_high,
        note, note, low, high, 1.0)
    equal_velocity = velocity_delta_matching_loss(
        predicted_low, predicted_high, target_low, target_high,
        note, note, low, low, 1.0)
    different_note = velocity_delta_matching_loss(
        predicted_low, predicted_high, target_low, target_high,
        note, note + 1, low, high, 1.0)
    assert exact.item() == 0.0
    assert collapsed.item() > 0.0
    assert equal_velocity.item() == 0.0
    assert different_note.item() == 0.0
    collapsed.backward()
    assert predicted_low.grad is not None and predicted_low.grad.abs().sum() > 0
    assert predicted_high.grad is not None and predicted_high.grad.abs().sum() > 0


def test_rms_db_is_computed_from_waveform():
    waveform = torch.full((1, 1, 1024), 0.25, requires_grad=True)
    value = rms_db(waveform)
    value.backward()
    assert waveform.grad is not None and waveform.grad.abs().sum() > 0
    assert torch.allclose(value.detach(), torch.tensor([-12.0412]), atol=1e-3)


def test_envelope_loss_does_not_reintroduce_low_note_phase_matching():
    time = torch.arange(65536, dtype=torch.float32) / 44100.0
    first = torch.sin(2 * torch.pi * 65.406 * time).view(1, 1, -1)
    shifted = torch.sin(2 * torch.pi * 65.406 * time + 1.7).view(1, 1, -1)
    assert MultiScaleEnvelopeLoss()(first, shifted).item() < 0.03


def test_feature_matching_compares_texture_statistics_not_absolute_phase():
    time = torch.linspace(0, 16 * torch.pi, 4096)
    first = torch.stack((torch.sin(time), torch.cos(2 * time))).view(1, 2, -1)
    shifted = torch.roll(first, 317, dims=-1).requires_grad_()
    real = [(torch.zeros(1), [first])]
    fake = [(torch.zeros(1), [shifted])]
    loss = feature_matching(real, fake)
    loss.backward()
    assert loss.item() < 0.01
    assert shifted.grad is not None


class _RecordingPitch(nn.Module):
    def __init__(self):
        super().__init__()
        self.notes: list[torch.Tensor] = []

    def forward(self, audio, note, confidence, valid):
        self.notes.append(note.detach().clone())
        return audio.mean() * 0

    def forward_groups(self, groups):
        return [self.forward(*group) for group in groups]


def test_loss_routes_midi_b_and_has_no_waveform_or_voiced_terms():
    config = Config.load(Path(__file__).parents[1] / "configs" / "smoke.yaml")
    loss = ReconstructionLoss(config.loss, 44100, "spectral", 128, 16, 256)
    recorder = _RecordingPitch()
    loss.pitch = recorder
    self_raw = torch.randn(1, 1, 4096, requires_grad=True)
    cross_raw = torch.randn(1, 1, 4096, requires_grad=True)
    self_audio = self_raw.tanh()
    cross_audio = cross_raw.tanh()
    output = PairOutput(self_audio, cross_audio, torch.randn(1, 128),
                        torch.randn(1, 128), torch.randn(1, 36))
    batch = {
        "audio_a": torch.randn(1, 1, 4096), "audio_b": torch.randn(1, 1, 4096),
        "note_a": torch.tensor([48]), "note_b": torch.tensor([60]),
        "velocity_a": torch.tensor([50.0]), "velocity_b": torch.tensor([127.0]),
        "pitch_confidence_a": torch.ones(1, 32), "pitch_confidence_b": torch.ones(1, 32),
        "pitch_valid_mask_a": torch.ones(1, 32, dtype=torch.bool),
        "pitch_valid_mask_b": torch.ones(1, 32, dtype=torch.bool),
    }
    result = loss(output, batch, output.target_timbre, adversary_enabled=False)
    assert torch.equal(recorder.notes[0], batch["note_a"])
    assert torch.equal(recorder.notes[1], batch["note_b"])
    assert not any("waveform" in key or "voiced" in key for key in result.values)
    result.total.backward()
    assert self_raw.grad is not None and cross_raw.grad is not None


def test_cross_only_loss_omits_self_and_velocity_terms():
    config = Config.load(Path(__file__).parents[1] / "configs" / "smoke.yaml")
    loss = ReconstructionLoss(config.loss, 44100, "spectral", 128, 16, 256)
    cross_raw = torch.randn(1, 1, 4096, requires_grad=True)
    output = PairOutput(None, cross_raw.tanh(), torch.randn(1, 128, requires_grad=True),
                        torch.randn(1, 128), torch.randn(1, 128, requires_grad=True))
    batch = {
        "audio_a": torch.randn(1, 1, 4096), "audio_b": torch.randn(1, 1, 4096),
        "note_a": torch.tensor([48]), "note_b": torch.tensor([60]),
        "velocity_a": torch.tensor([50.0]), "velocity_b": torch.tensor([127.0]),
        "pitch_confidence_a": torch.ones(1, 32), "pitch_confidence_b": torch.ones(1, 32),
        "pitch_valid_mask_a": torch.ones(1, 32, dtype=torch.bool),
        "pitch_valid_mask_b": torch.ones(1, 32, dtype=torch.bool),
    }
    result = loss(output, batch, output.target_timbre, adversary_enabled=True, self_scale=0.0)
    assert "cross_stft" in result.values
    assert not any(name.startswith("self_") for name in result.values)
    assert "velocity_rank" not in result.values
    assert "velocity_delta" not in result.values
    result.total.backward()
    assert cross_raw.grad is not None


def test_reconstruction_velocity_uses_complete_render_reference_not_crop_rms():
    config = Config.load(Path(__file__).parents[1] / "configs" / "smoke.yaml")
    loss = ReconstructionLoss(config.loss, 44100, "spectral", 128, 16, 256)
    loss.pitch = _RecordingPitch()
    self_audio = torch.full((1, 1, 4096), 0.2)
    cross_audio = torch.full((1, 1, 4096), 0.4)
    output = PairOutput(self_audio, cross_audio, torch.randn(1, 128),
                        torch.randn(1, 128), torch.randn(1, 36))
    batch = {
        # Crop RMS points in the wrong direction on purpose.
        "audio_a": torch.full((1, 1, 4096), 0.8),
        "audio_b": torch.full((1, 1, 4096), 0.1),
        "note_a": torch.tensor([60]), "note_b": torch.tensor([60]),
        "velocity_a": torch.tensor([50.0]), "velocity_b": torch.tensor([127.0]),
        # Complete-render reference points in the same direction as prediction.
        "velocity_reference_rms_db_a": torch.tensor([-30.0]),
        "velocity_reference_rms_db_b": torch.tensor([-10.0]),
        "pitch_confidence_a": torch.ones(1, 32), "pitch_confidence_b": torch.ones(1, 32),
        "pitch_valid_mask_a": torch.ones(1, 32, dtype=torch.bool),
        "pitch_valid_mask_b": torch.ones(1, 32, dtype=torch.bool),
    }
    result = loss(output, batch, output.target_timbre, adversary_enabled=False)
    assert result.values["velocity_rank"].item() == 0.0

    reversed_reference = dict(batch)
    reversed_reference["velocity_reference_rms_db_a"] = torch.tensor([-10.0])
    reversed_reference["velocity_reference_rms_db_b"] = torch.tensor([-30.0])
    reversed_result = loss(
        output, reversed_reference, output.target_timbre, adversary_enabled=False)
    assert reversed_result.values["velocity_rank"].item() > 1.0


def test_brave_discriminator_matches_official_parameter_budget_and_shapes():
    discriminator = BraveMultiScaleDiscriminator()
    assert sum(parameter.numel() for parameter in discriminator.parameters()) == 1_940_451
    assert not any(isinstance(module, nn.Conv2d) for module in discriminator.modules())
    output = discriminator(torch.randn(2, 1, 65536))
    assert len(output) == 3
    expected_lengths = ((16384, 4096, 1024, 256),
                        (8192, 2048, 512, 128),
                        (4096, 1024, 256, 64))
    for (score, features), lengths in zip(output, expected_lengths):
        assert len(features) == 4
        assert tuple(feature.shape[-1] for feature in features) == lengths
        assert score.shape[-1] == lengths[-1]


def test_brave_discriminator_losses_are_finite_and_backpropagate():
    discriminator = BraveMultiScaleDiscriminator()
    real_audio = torch.randn(1, 1, 4097)
    fake_audio = torch.randn(1, 1, 4097, requires_grad=True)
    real = discriminator(real_audio)
    fake = discriminator(fake_audio)
    generator_loss = generator_adversarial(fake) + feature_matching(real, fake)
    assert torch.isfinite(generator_loss)
    generator_loss.backward(retain_graph=True)
    assert fake_audio.grad is not None and torch.isfinite(fake_audio.grad).all()
    d_loss = discriminator_hinge(real, fake)
    assert torch.isfinite(d_loss)
