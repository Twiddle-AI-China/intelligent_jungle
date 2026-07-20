from __future__ import annotations

import math
from pathlib import Path

import yaml

from midibrave.config import Config


ROOT = Path(__file__).resolve().parents[1]
ACTIVE_FULL = ROOT / "configs" / "full_c9_optimized.yaml"
ACTIVE_Q300 = ROOT / "configs" / "quality300_c9_optimized.yaml"
PREOPT_DIR = ROOT / "training_profiles" / "pre_time_optimization_c9"
PREOPT_FULL = PREOPT_DIR / "full_fixed_1m_250k.yaml"
PREOPT_Q300 = PREOPT_DIR / "quality300_20plus5.yaml"

C9_LOSS = {
    "self_stft": 1.0,
    "self_envelope": 0.05,
    "self_pitch": 0.5,
    "self_rms": 0.25,
    "cross_stft": 0.5,
    "cross_envelope": 0.0125,
    "cross_pitch": 1.0,
    "cross_rms": 0.5,
    "velocity_rank": 0.5,
    "timbre_pair": 0.1,
    "distribution": 0.01,
    "pitch_adversary": 0.1,
    "adversarial": 1.0,
    "feature_matching": 2.0,
    "pitch_temperature": 0.1,
    "pitch_target_sigma_cents": 25.0,
    "pitch_kl": 0.0,
    "pitch_activation": 1.0,
    "pitch_hard_negative": 0.25,
    "pitch_autocorrelation": 20.0,
    "pitch_negative_margin_logits": 1.0,
    "pitch_negative_exclusion_cents": 100.0,
    "pitch_negative_temperature": 0.25,
    "velocity_delta": 0.0,
    "velocity_delta_scale_db": 6.0,
    "velocity_margin_db": 1.0,
    "latent_std_floor": 0.2,
    "latent_distribution_backend": "gather",
}


def _raw(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_all_published_c9_profiles_parse_and_share_exact_loss() -> None:
    paths = [
        ROOT / "configs" / "base.yaml",
        ROOT / "configs" / "pipeline.yaml",
        ROOT / "configs" / "quality300.yaml",
        ROOT / "configs" / "smoke.yaml",
        ROOT / "configs" / "smoke_resumed.yaml",
        ACTIVE_FULL,
        ACTIVE_Q300,
        PREOPT_FULL,
        PREOPT_Q300,
    ]
    for path in paths:
        Config.load(path)
        assert _raw(path)["loss"] == C9_LOSS, path


def test_active_full_budget_is_16_plus_2_epochs_at_global_batch_80() -> None:
    cfg = _raw(ACTIVE_FULL)
    updates_per_epoch = 75362 * cfg["data"]["repeats"] / (
        8 * cfg["train"]["batch_per_gpu"] * cfg["train"]["grad_accum"]
    )
    assert cfg["data"]["window_samples"] == 49152
    assert cfg["data"]["pitch_window_valid_ratio_min"] == 0.75
    assert math.ceil(updates_per_epoch * 16) == cfg["train"]["phase1_steps"]
    assert math.ceil(updates_per_epoch * 2) == cfg["train"]["phase2_steps"]
    assert cfg["train"]["self_full_fraction"] == 0.1
    assert cfg["train"]["self_probability"] == 0.5
    assert cfg["model"]["static_condition_fast_path"] is True
    assert cfg["model"]["cache_excitation_bands"] is True


def test_quality_first_full_restores_compute_and_budget_only() -> None:
    active = _raw(ACTIVE_FULL)
    quality = _raw(PREOPT_FULL)
    assert quality["data"] == active["data"]
    assert quality["model"] == active["model"]
    assert quality["data"]["window_samples"] == 49152
    assert quality["data"]["pitch_window_valid_ratio_min"] == 0.75
    assert quality["train"]["phase1_steps"] == 1_000_000
    assert quality["train"]["phase2_steps"] == 250_000
    assert quality["train"]["batch_per_gpu"] == 10
    assert quality["train"]["self_full_fraction"] == 1.0
    assert quality["train"]["self_probability"] == 1.0
    assert quality["model"]["static_condition_fast_path"] is True
    assert quality["model"]["cache_excitation_bands"] is True
    assert quality["train"]["fused_adamw"] is True
    assert quality["train"]["ddp_gradient_as_bucket_view"] is True
    assert quality["train"]["ddp_bucket_cap_mb"] == 16
    assert quality["loss"] == active["loss"] == C9_LOSS


def test_quality_first_q300_uses_20_plus_5_epochs_at_global_batch_80() -> None:
    cfg = _raw(PREOPT_Q300)
    updates_per_epoch = 12676 * cfg["data"]["repeats"] / (
        8 * cfg["train"]["batch_per_gpu"] * cfg["train"]["grad_accum"]
    )
    assert cfg["data"]["manifest"].endswith(
        "serum_quality300_eligible_optimized.jsonl"
    )
    assert cfg["data"]["window_samples"] == 49152
    assert cfg["data"]["pitch_window_valid_ratio_min"] == 0.75
    assert cfg["train"]["batch_per_gpu"] == 10
    assert cfg["train"]["self_full_fraction"] == 1.0
    assert cfg["train"]["self_probability"] == 1.0
    assert cfg["model"]["static_condition_fast_path"] is True
    assert cfg["model"]["cache_excitation_bands"] is True
    assert cfg["train"]["fused_adamw"] is True
    assert cfg["train"]["ddp_gradient_as_bucket_view"] is True
    assert math.ceil(updates_per_epoch * 20) == cfg["train"]["phase1_steps"]
    assert math.ceil(updates_per_epoch * 5) == cfg["train"]["phase2_steps"]
