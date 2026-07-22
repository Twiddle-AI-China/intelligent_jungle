from __future__ import annotations

from dataclasses import dataclass, field
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
    dataset_root: str
    cache_root: str
    expected_manifest_sha256: str = ""
    sample_rate: int = 44100
    render_samples: int = 220500
    window_samples: int = 49152
    note_on_sample: int = 4410
    note_off_sample: int = 114660
    trajectory_hop: int = 2048
    feature_hop: int = 512
    repeats: int = 16
    num_workers: int = 4
    prefetch_factor: int = 2
    seed: int = 20260721
    validation_notes: tuple[int, ...] = (43, 52, 61, 70)
    test_notes: tuple[int, ...] = (39, 48, 57, 66)

    def __post_init__(self) -> None:
        if self.sample_rate != 44100:
            raise ValueError("Pad V1 is fixed to 44.1 kHz")
        if self.trajectory_hop % 128:
            raise ValueError("trajectory_hop must be divisible by 128")
        if self.window_samples % 128:
            raise ValueError("window_samples must be divisible by 128")
        if not 0 <= self.note_on_sample < self.note_off_sample < self.render_samples:
            raise ValueError("invalid strict Serum event positions")


@dataclass(frozen=True)
class ModelConfig:
    feature_dim: int = 96
    acoustic_dim: int = 128
    decoder_timbre_dim: int = 256
    control_dim: int = 8
    temporal_channels: int = 128
    expander_channels: int = 128
    expander_blocks: int = 4
    num_presets: int = 50
    midi_dim: int = 32
    capacity: int = 64
    pqmf_bands: int = 16
    pqmf_taps: int = 256
    ratios: tuple[int, ...] = (2, 2, 2, 1)
    anti_image_taps: int = 31
    warmup_latent_frames: int = 64
    excitation_harmonics: int = 128
    excitation_rms: float = 0.1
    stochastic_excitation: bool = True
    stochastic_excitation_rms: float = 0.05
    stochastic_modulation_hz: float = 2.0
    film_scale_limit: float = 0.5
    film_shift_limit: float = 1.0

    def __post_init__(self) -> None:
        if self.acoustic_dim != 128:
            raise ValueError("Pad V1 acoustic trajectory is fixed to 128D")
        if self.control_dim != 8:
            raise ValueError("Pad V1 public control coordinate is fixed to 8D")
        if self.decoder_timbre_dim != 256:
            raise ValueError("old Pad BRAVE decoder interface is fixed to 256D")
        if self.midi_dim != 32:
            raise ValueError("BRAVE note conditioner is fixed to 32D")
        if self.pqmf_bands * _product(self.ratios) != 128:
            raise ValueError("BRAVE compression must remain 128 samples/latent")

    def brave(self):
        from midibrave.config import ModelConfig as BraveModelConfig

        return BraveModelConfig(
            clap_dim=512,
            timbre_dim=self.decoder_timbre_dim,
            midi_dim=self.midi_dim,
            capacity=self.capacity,
            pqmf_bands=self.pqmf_bands,
            ratios=list(self.ratios),
            pitch_backend="spectral",
            pqmf_taps=self.pqmf_taps,
            anti_image_taps=self.anti_image_taps,
            warmup_latent_frames=self.warmup_latent_frames,
            excitation_harmonics=self.excitation_harmonics,
            excitation_rms=self.excitation_rms,
            static_condition_fast_path=False,
            cache_excitation_bands=False,
            decoder_fp32_tail=True,
            norm_reduction_dtype="fp32",
            phase_accumulation_dtype="fp32",
            pqmf_dtype="fp32",
            rms_norm_epsilon=1e-6,
            film_scale_limit=self.film_scale_limit,
            film_shift_limit=self.film_shift_limit,
            stochastic_excitation=self.stochastic_excitation,
            stochastic_excitation_rms=self.stochastic_excitation_rms,
            stochastic_modulation_hz=self.stochastic_modulation_hz,
            stochastic_seed=20260721,
        )


@dataclass(frozen=True)
class LossConfig:
    self_audio: float = 1.0
    cross_audio: float = 1.0
    self_pitch: float = 0.5
    cross_pitch: float = 1.0
    trajectory_same: float = 0.1
    trajectory_usage: float = 0.1
    pitch_adversary: float = 0.05
    distribution: float = 0.01
    distill_point: float = 1.0
    distill_speed: float = 0.5
    distill_curvature: float = 0.1
    neighbor: float = 0.05
    runtime_audio: float = 1.0
    runtime_distill: float = 0.5
    runtime_self_pitch: float = 0.25
    runtime_cross_pitch: float = 0.5
    stft: float = 1.0
    multiband_stft: float = 0.25
    envelope: float = 0.05
    rms: float = 0.1
    usage_margin_fraction: float = 0.05
    latent_std_floor: float = 0.2


@dataclass(frozen=True)
class StageConfig:
    minimum_steps: int
    target_steps: int
    maximum_steps: int
    lr: float
    min_lr: float
    warmup_steps: int


@dataclass(frozen=True)
class TrainConfig:
    output_dir: str
    run_name: str
    precision: str = "amp_fp16"
    batch_per_gpu: int = 4
    grad_accum: int = 4
    global_pair_batch: int = 64
    reference_world_size: int = 4
    grad_clip: float = 1.0
    grad_scaler_init_scale: float = 2.0
    grad_scaler_growth_interval: int = 2000
    max_consecutive_nonfinite: int = 8
    maximum_skip_fraction: float = 0.005
    checkpoint_every: int = 5000
    validation_every: int = 5000
    log_every: int = 20
    ddp_bucket_cap_mb: int = 16
    teacher: StageConfig = field(
        default_factory=lambda: StageConfig(40000, 50000, 60000, 1e-4, 2e-5, 1000)
    )
    distill: StageConfig = field(
        default_factory=lambda: StageConfig(10000, 20000, 30000, 2e-4, 2e-5, 500)
    )
    joint: StageConfig = field(
        default_factory=lambda: StageConfig(25000, 35000, 40000, 2e-5, 5e-6, 500)
    )

    def __post_init__(self) -> None:
        if self.precision != "amp_fp16":
            raise ValueError("V100 training requires amp_fp16")
        if self.reference_world_size < 1:
            raise ValueError("reference_world_size must be positive")
        effective = self.batch_per_gpu * self.grad_accum * self.reference_world_size
        if effective != self.global_pair_batch:
            raise ValueError(
                f"reference batch contract mismatch: {self.batch_per_gpu}*"
                f"{self.grad_accum}*{self.reference_world_size}={effective}, "
                f"expected {self.global_pair_batch}"
            )


@dataclass(frozen=True)
class GateConfig:
    overfit_reduction: float = 0.50
    qualification_reduction: float = 0.10
    maximum_pitch_cents_qualification: float = 100.0
    maximum_pitch_cents_teacher: float = 50.0
    maximum_pitch_cents_final: float = 15.0
    minimum_midi_following_qualification: float = 0.90
    minimum_midi_following_final: float = 0.95
    minimum_teacher_usage_improvement: float = 0.05
    minimum_control_effective_rank: int = 6
    minimum_latent_cosine: float = 0.95
    maximum_runtime_audio_gap: float = 0.05
    minimum_gpu_utilization: float = 85.0
    maximum_gpu_memory_gib: float = 15.0
    maximum_rank_utilization_gap: float = 10.0
    maximum_data_wait_fraction: float = 0.05
    minimum_trajectory_dynamic_improvement_qualification: float = 0.03
    minimum_trajectory_dynamic_improvement_teacher: float = 0.05
    minimum_dynamic_preset_fraction: float = 0.70
    maximum_distill_audio_gap: float = 0.10
    maximum_teacher_same_different_ratio: float = 0.70
    maximum_24h_training_eta_hours: float = 18.5


@dataclass(frozen=True)
class Config:
    data: DataConfig
    model: ModelConfig
    loss: LossConfig
    train: TrainConfig
    gates: GateConfig
    seed: int = 20260721

    @classmethod
    def load(cls, path: str | Path) -> "Config":
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("configuration root must be a mapping")

        data_raw = _section(raw, "data")
        for key in ("validation_notes", "test_notes"):
            if key in data_raw:
                data_raw[key] = tuple(data_raw[key])

        model_raw = _section(raw, "model")
        if "ratios" in model_raw:
            model_raw["ratios"] = tuple(model_raw["ratios"])

        train_raw = _section(raw, "train")
        for stage in ("teacher", "distill", "joint"):
            if stage in train_raw:
                train_raw[stage] = StageConfig(**train_raw[stage])

        return cls(
            data=DataConfig(**data_raw),
            model=ModelConfig(**model_raw),
            loss=LossConfig(**_section(raw, "loss")),
            train=TrainConfig(**train_raw),
            gates=GateConfig(**_section(raw, "gates")),
            seed=int(raw.get("seed", 20260721)),
        )


def _product(values: tuple[int, ...]) -> int:
    result = 1
    for value in values:
        result *= value
    return result
