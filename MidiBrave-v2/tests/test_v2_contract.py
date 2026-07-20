from __future__ import annotations

from dataclasses import replace

import torch

from midibrave.cli import create_fixture
from midibrave.config import Config
from midibrave.data import PairDataset
from midibrave.losses import MultiResolutionSTFTLoss, SafeCrepeObjective
from midibrave.model import ChannelRMSNorm, FiLM, StochasticBandExcitation
from midibrave.selection import _tier_assignment, keyword_scores


def test_label_dictionary_and_global_assignment_are_deterministic():
    assert keyword_scores("Warm Atmos Pad")["pad"] == 1.0
    assert keyword_scores("DX STRINGS")["pad"] == 1.0
    assert keyword_scores("DEEPBASS")["base"] == 1.0
    assert keyword_scores("BASSORGAN2")["base"] == 1.0
    assert keyword_scores("bassoon")["base"] == 0.0
    assert keyword_scores("embassy")["base"] == 0.0
    assert keyword_scores("Cello pizzicato")["pluck"] == 1.0
    candidates = [
        {
            "timbre_id": f"t{index}", "source_family": f"family-{index}",
            "label_scores": {name: float(name == class_name)
                             for name in ("pad", "lead", "base", "pluck", "texture")},
            "clap_scores": {name: 0.5 for name in ("pad", "lead", "base", "pluck", "texture")},
        }
        for index, class_name in enumerate(("pad", "lead", "base", "pluck", "texture"))
    ]
    remaining = {name: 1 for name in ("pad", "lead", "base", "pluck", "texture")}
    first = sorted(_tier_assignment(candidates, remaining, 20))
    second = sorted(_tier_assignment(candidates, remaining, 20))
    assert first == second
    assert len(first) == 5
    assert len({item[0] for item in first}) == 5


def test_v2_clap_reconstruction_keeps_256_plus_32_condition_contract():
    config = Config.load("configs/v2/base.yaml")
    assert config.model.clap_dim == 512
    assert config.model.timbre_dim == 256
    assert config.model.midi_dim == 32
    assert config.model.timbre_dim + config.model.midi_dim == 288
    assert config.loss.self_clap == 2.0
    assert config.loss.cross_clap == 2.0
    assert config.loss.clap_every_updates == 4


def test_assignment_reports_final_flow_after_residual_reroute():
    names = ("pad", "lead", "base", "pluck", "texture")
    shared = {
        "timbre_id": "shared", "source_family": "family-shared",
        "label_scores": {name: float(name in {"pad", "lead"}) for name in names},
        "clap_scores": {name: 0.5 for name in names},
    }
    pad_only = {
        "timbre_id": "pad-only", "source_family": "family-pad",
        "label_scores": {name: float(name == "pad") for name in names},
        "clap_scores": {name: 0.5 for name in names},
    }
    result = _tier_assignment([shared, pad_only], {**dict.fromkeys(names, 0), "pad": 1, "lead": 1}, 20)
    assert sorted(result) == [("pad-only", "pad"), ("shared", "lead")]


def test_short_audio_is_padded_and_reports_valid_samples(tmp_path):
    manifest = create_fixture(tmp_path / "fixture", samples=2048)
    config = Config.load("configs/smoke.yaml")
    data = replace(
        config.data, manifest=str(manifest), cache_root=str(manifest.parent / "cache"),
        dataset_root=str(manifest.parent), window_samples=4096,
        minimum_valid_samples=1024, repeats=1, require_pitch_cache=True,
    )
    sample = PairDataset(data, 9)[0]
    assert sample["audio_a"].shape[-1] == 4096
    assert sample["valid_samples_a"].item() == 2048
    assert torch.count_nonzero(sample["audio_a"][..., 2048:]).item() == 0


def test_masked_stft_ignores_invalid_prediction_tail():
    loss = MultiResolutionSTFTLoss((256, 128))
    target = torch.randn(2, 1, 2048)
    first = target.clone()
    second = target.clone()
    second[..., 1024:] = 1000.0
    valid = torch.full((2,), 1024, dtype=torch.long)
    assert torch.allclose(loss(first, target, valid), loss(second, target, valid), atol=1e-6)


class _BadJacobian(torch.autograd.Function):
    @staticmethod
    def forward(ctx, value):
        return value.sum() * 0.0

    @staticmethod
    def backward(ctx, gradient):
        return torch.full((1, 1, 32), torch.nan) * gradient


class _BadCrepe(torch.nn.Module):
    def forward_group_components(self, groups):
        audio = groups[0][0]
        value = _BadJacobian.apply(audio)
        return [{"total": value, "cents": value}]


def test_crepe_firewall_sanitizes_finite_forward_nan_backward():
    audio = torch.randn(1, 1, 32, requires_grad=True)
    zero = torch.zeros(1, 1, 32)
    note = torch.tensor([60])
    confidence = torch.ones(1, 4)
    valid = torch.ones(1, 4, dtype=torch.bool)
    safe = SafeCrepeObjective(_BadCrepe(), 1.0)
    result = safe.forward_group_components([(audio, zero, note, confidence, valid)])[0]
    result["total"].backward()
    assert torch.isfinite(result["total"])
    assert torch.isfinite(audio.grad).all()
    assert torch.count_nonzero(audio.grad).item() == 0


def test_rmsnorm_film_and_stochastic_excitation_contract():
    x = torch.randn(3, 8, 16) * 1e4
    normalized = ChannelRMSNorm()(x)
    assert torch.isfinite(normalized).all()
    assert torch.allclose(normalized.square().mean(1), torch.ones(3, 16), atol=1e-4)
    film = FiLM(4, 8, 0.5, 1.0)
    assert torch.allclose(film(normalized, torch.randn(3, 4, 16)), normalized)
    source = StochasticBandExcitation(16, 44100, 16, 0.05, 2.0, 7)
    seeds = torch.tensor([11, 12, 13])
    first = source(3, 64, torch.device("cpu"), seeds)
    second = source(3, 64, torch.device("cpu"), seeds)
    assert torch.equal(first, second)
    assert not torch.equal(first[0], first[1])
