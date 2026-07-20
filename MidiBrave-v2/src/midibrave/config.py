from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


def _section(raw: dict[str, Any], name: str) -> dict[str, Any]:
    value = raw.get(name)
    if not isinstance(value, dict):
        raise ValueError(f"missing config section: {name}")
    return value


@dataclass(frozen=True)
class DataConfig:
    manifest: str
    cache_root: str
    dataset_root: str | None
    preset_manifest: str | None
    manifest_metadata: str | None
    split: str
    sample_rate: int
    window_samples: int
    note_min: int
    note_max: int
    velocities: list[int]
    repeats: int
    num_workers: int
    pitch_hop_length: int = 128
    pitch_confidence_min: float = 0.5
    pitch_cents_tolerance: float = 50.0
    stable_edge_seconds: float = 0.15
    require_pitch_cache: bool = True
    minimum_distinct_notes_per_preset: int = 4
    prefetch_factor: int = 2
    clap_checkpoint: str | None = None
    pitch_window_valid_ratio_min: float = 0.15
    pitch_energy_floor_db: float = -60.0
    pitch_energy_dynamic_range_db: float = 40.0
    # v2 manifests are portable across machines: each record carries a
    # dataset_id and paths are resolved through this mapping. dataset_root is
    # retained for v1/fixture compatibility.
    dataset_roots: dict[str, str] | None = None
    class_name: str = "lead"
    minimum_valid_samples: int = 16384
    onset_crop_probability: float = 0.5
    active_threshold_db: float = -55.0
    require_velocity_known: bool = False


@dataclass(frozen=True)
class ModelConfig:
    clap_dim: int
    timbre_dim: int
    midi_dim: int
    capacity: int
    pqmf_bands: int
    ratios: list[int]
    pitch_backend: str
    pqmf_taps: int = 256
    anti_image_taps: int = 31
    warmup_latent_frames: int = 64
    excitation_harmonics: int = 128
    excitation_rms: float = 0.1
    static_condition_fast_path: bool = False
    cache_excitation_bands: bool = False
    excitation_cache_note_chunk: int = 8
    condition_gain_hidden: int = 0
    condition_gain_max_db: float = 12.0
    decoder_fp32_tail: bool = True
    norm_reduction_dtype: str = "fp32"
    phase_accumulation_dtype: str = "fp32"
    pqmf_dtype: str = "fp32"
    rms_norm_epsilon: float = 1e-6
    film_scale_limit: float = 0.5
    film_shift_limit: float = 1.0
    stochastic_excitation: bool = True
    stochastic_excitation_rms: float = 0.05
    stochastic_modulation_hz: float = 2.0
    stochastic_seed: int = 20260720


@dataclass(frozen=True)
class LossConfig:
    self_stft: float
    self_envelope: float
    self_pitch: float
    self_rms: float
    cross_stft: float
    cross_envelope: float
    cross_pitch: float
    cross_rms: float
    velocity_rank: float
    timbre_pair: float
    distribution: float
    pitch_adversary: float
    adversarial: float
    feature_matching: float
    pitch_temperature: float = 0.1
    pitch_target_sigma_cents: float = 25.0
    pitch_kl: float = 0.1
    pitch_activation: float = 0.0
    pitch_hard_negative: float = 0.0
    pitch_autocorrelation: float = 0.0
    pitch_negative_margin_logits: float = 1.0
    pitch_negative_exclusion_cents: float = 100.0
    pitch_negative_temperature: float = 0.25
    velocity_delta: float = 0.0
    velocity_delta_scale_db: float = 6.0
    velocity_margin_db: float = 1.0
    latent_std_floor: float = 0.2
    latent_distribution_backend: str = "gather"
    stft_dtype: str = "fp32"
    crepe_dtype: str = "fp32"
    crepe_every_until_1k: int = 2
    crepe_every_until_5k: int = 4
    crepe_train_stop: int = 5000
    crepe_gradient_norm: float = 1.0
    analytic_pitch: float = 1.0
    self_spectral_flux: float = 0.0
    cross_spectral_flux: float = 0.0
    self_band_statistics: float = 0.0
    cross_band_statistics: float = 0.0
    # A frozen LAION-CLAP audio encoder supplies a perceptual reconstruction
    # gradient on the *generated and target training windows*.  This is
    # deliberately distinct from timbre_pair, which only compares the two
    # input-derived TimbreAdapter latents.
    self_clap: float = 0.0
    cross_clap: float = 0.0
    clap_warmup_steps: int = 0
    clap_every_updates: int = 1
    clap_batch_size: int = 1
    clap_gradient_norm: float = 1.0


@dataclass(frozen=True)
class TrainConfig:
    phase1_steps: int
    phase2_steps: int
    batch_per_gpu: int
    grad_accum: int
    lr: float
    min_lr: float
    warmup_steps: int
    phase2_generator_lr: float
    phase2_condition_lr: float
    discriminator_lr: float
    pitch_adversary_start: int
    grad_clip: float
    checkpoint_every: int
    log_every: int
    output_dir: str
    run_name: str
    pitch_adversary_ramp: int = 20000
    grad_scaler_init_scale: float = 2.0
    grad_scaler_growth_interval: int = 2000
    self_full_fraction: float = 1.0
    self_probability: float = 1.0
    fused_adamw: bool = False
    ddp_gradient_as_bucket_view: bool = False
    ddp_static_graph: bool = False
    ddp_bucket_cap_mb: int = 25
    compile_decoder: bool = False
    compile_discriminator: bool = False
    compile_mode: str = "default"
    precision: str = "amp_fp16"
    lr_hold_until: int = 5000
    checkpoint_updates: list[int] | None = None
    plateau_start: int = 5000
    plateau_relative_min: float = 0.01
    plateau_patience_intervals: int = 2
    hard_example_fraction: float = 0.25
    hard_example_quantile: float = 0.75
    rolling_checkpoint_every: int = 0


@dataclass(frozen=True)
class Config:
    seed: int
    data: DataConfig
    model: ModelConfig
    loss: LossConfig
    train: TrainConfig
    source_path: str

    @classmethod
    def load(cls, path: str | Path) -> "Config":
        path = Path(path).resolve()
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("config root must be a mapping")
        return cls(
            seed=int(raw["seed"]),
            data=DataConfig(**_section(raw, "data")),
            model=ModelConfig(**_section(raw, "model")),
            loss=LossConfig(**_section(raw, "loss")),
            train=TrainConfig(**_section(raw, "train")),
            source_path=str(path),
        )
