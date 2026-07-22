"""midiBrave 神经音源后端（CPU 推理）。

本模块是「共享核心」：离线单音渲染与流式实时推理共用这里的模型加载、
z_timbre 处理、MIDI 条件构造与激励信号生成。

关键事实（均由实测确认，详见 docs/model-notes.md）：
  * 权重是 state_dict（非 TorchScript），必须配 v0.8.0-phase1-autotune 的模型类。
  * 模型条件只有 (z_timbre 128D, note, velocity) 三项，**没有** gate/onset/duration。
    时长由「跑多少个 latent frame」决定，不是网络输入。
  * static_condition_fast_path=True → MIDI 条件在时间轴上恒定，FiLM 系数是常数。
  * samples_per_latent = pqmf_bands(16) * prod(ratios)(8) = 128 samples ≈ 2.902 ms。
  * warmup_latent_frames=64 > 感受野 55 帧，因此暖机后逐块流式与离线一次性渲染等价。
"""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from torch import Tensor

# ---------------------------------------------------------------------------
# 默认路径（Spark）。权重目录是 jyhu 的，**只读**，任何情况下都不要写入。
# ---------------------------------------------------------------------------
DEFAULT_CHECKPOINT = "/data/model_weights/midiBrave/midibrave-full-c9-phase1-step-000075365.pt"
_HERE = Path(__file__).resolve()
DEFAULT_VENDOR = _HERE.parents[2] / "vendor" / "midibrave"
DEFAULT_CONFIG = DEFAULT_VENDOR / "config.trained.yaml"

# 训练时锁定的 config / manifest 指纹。加载时校验，防止悄悄换了权重却不换代码。
EXPECTED_CONFIG_SHA256 = "8f43c6ecf78467a3485ba2184ae13df995e650168fc0a865c22c19b330e7e0fc"
EXPECTED_MANIFEST_SHA256 = "043d5f434dc41537cc31dfbe7d103e7db3b7a367198ff126a3e7639b66d4df49"
EXPECTED_TENSOR_COUNT = 141

# 训练数据边界。越界即分布外，调用方应当先 clamp 再送进来。
TRAIN_NOTE_MIN = 21
TRAIN_NOTE_MAX = 109
TRAIN_VELOCITIES = (50, 127)


def _add_vendor_to_path(vendor_root: Path) -> None:
    src = vendor_root / "src"
    if not (src / "midibrave" / "model.py").is_file():
        raise FileNotFoundError(f"vendored midibrave 源码缺失: {src}")
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))


@dataclass(frozen=True)
class ModelGeometry:
    """从 config 推导出来的时间轴几何，流式调度全靠这几个数。"""

    sample_rate: int
    pqmf_bands: int
    ratios: tuple[int, ...]
    samples_per_latent: int      # 128
    warmup_latent_frames: int    # 64
    tail_latent_frames: int      # 1
    train_output_samples: int    # 49152
    train_latent_frames: int     # 384
    train_total_latent_frames: int  # 449
    pqmf_taps: int               # 256

    @property
    def latent_rate_hz(self) -> float:
        return self.sample_rate / self.samples_per_latent

    def frames_for_seconds(self, seconds: float) -> int:
        return max(1, math.ceil(seconds * self.sample_rate / self.samples_per_latent))


class MidiBraveBackend:
    """加载 checkpoint 并提供离线单音渲染。流式见 streaming.StreamingVoice。"""

    def __init__(
        self,
        checkpoint_path: str | Path = DEFAULT_CHECKPOINT,
        config_path: str | Path = DEFAULT_CONFIG,
        vendor_root: str | Path = DEFAULT_VENDOR,
        device: str = "cpu",
        verify_hashes: bool = True,
    ) -> None:
        vendor_root = Path(vendor_root).resolve()
        _add_vendor_to_path(vendor_root)

        from midibrave.config import Config  # noqa: PLC0415  vendored
        from midibrave.model import MidiBrave  # noqa: PLC0415  vendored

        config_path = Path(config_path).resolve()
        if verify_hashes:
            digest = _sha256_file(config_path)
            if digest != EXPECTED_CONFIG_SHA256:
                raise ValueError(
                    f"config 指纹不符：{digest} != {EXPECTED_CONFIG_SHA256}；"
                    "这份 config 与 checkpoint 不是同一次训练的产物。"
                )

        self.config = Config.load(config_path)
        self.device = torch.device(device)
        self.checkpoint_path = Path(checkpoint_path)

        model_cfg = self.config.model
        data_cfg = self.config.data
        self.model = MidiBrave(
            model_cfg,
            output_samples=data_cfg.window_samples,
            sample_rate=data_cfg.sample_rate,
        )

        payload = torch.load(self.checkpoint_path, map_location="cpu", weights_only=False)
        self._verify_payload(payload, verify_hashes)

        state = payload["model"]
        # 严格加载：任何 missing / unexpected key 都必须炸出来，绝不吞掉。
        result = self.model.load_state_dict(state, strict=True)
        missing = list(getattr(result, "missing_keys", []))
        unexpected = list(getattr(result, "unexpected_keys", []))
        if missing or unexpected:
            raise RuntimeError(
                f"state_dict 不匹配 — missing={missing} unexpected={unexpected}"
            )
        self.loaded_tensor_count = len(state)

        self.model.eval().to(self.device)
        for parameter in self.model.parameters():
            parameter.requires_grad_(False)

        self.geometry = ModelGeometry(
            sample_rate=data_cfg.sample_rate,
            pqmf_bands=model_cfg.pqmf_bands,
            ratios=tuple(model_cfg.ratios),
            samples_per_latent=self.model.samples_per_latent,
            warmup_latent_frames=model_cfg.warmup_latent_frames,
            tail_latent_frames=self.model.tail_latent_frames,
            train_output_samples=data_cfg.window_samples,
            train_latent_frames=self.model.latent_frames,
            train_total_latent_frames=self.model.total_latent_frames,
            pqmf_taps=model_cfg.pqmf_taps,
        )

        # 激励 RMS 归一化标量按训练时的规范长度算一次，之后任意长度复用。
        # 若按每次生成的实际长度重算，流式逐块会得到不同缩放 → 块边界跳变。
        self._excitation_scale: dict[int, Tensor] = {}
        self._canonical_excitation_samples = (
            self.geometry.train_total_latent_frames * self.geometry.samples_per_latent
        )

    # -- 校验 -------------------------------------------------------------
    def _verify_payload(self, payload: dict, verify_hashes: bool) -> None:
        if not isinstance(payload, dict) or "model" not in payload:
            raise ValueError("checkpoint 不是训练器保存的 dict 格式")
        state = payload["model"]
        if len(state) != EXPECTED_TENSOR_COUNT:
            raise ValueError(
                f"checkpoint 张量数 {len(state)} != 预期 {EXPECTED_TENSOR_COUNT}"
            )
        if payload.get("phase") != 1:
            raise ValueError(f"预期 phase=1，实际 {payload.get('phase')}")
        if verify_hashes:
            if payload.get("config_hash") != EXPECTED_CONFIG_SHA256:
                raise ValueError("checkpoint 的 config_hash 与本仓库 config 不一致")
            if payload.get("manifest_hash") != EXPECTED_MANIFEST_SHA256:
                raise ValueError("checkpoint 的 manifest_hash 与预期不一致")
        self.checkpoint_meta = {
            key: value
            for key, value in payload.items()
            if key not in ("model", "optimizer", "scaler", "rng_by_rank")
        }

    # -- 条件构造 ---------------------------------------------------------
    def make_z_midi(self, note: int, velocity: int, frames: int) -> Tensor:
        """构造 MIDI 条件张量 [1, 32, frames]。

        注意：这是模型接受的**全部**时序条件。没有 gate / onset / pitch_bend /
        legato —— MidiConditioner 的 docstring 明确写了 "no event or envelope fields"。
        static_condition_fast_path=True 时 TCN 只在单帧上跑再 expand，
        所以 32 维在时间轴上逐帧相同。
        """
        note_tensor = torch.tensor([note], dtype=torch.long, device=self.device)
        velocity_tensor = torch.tensor([velocity], dtype=torch.float32, device=self.device)
        with torch.no_grad():
            return self.model.midi(
                note_tensor,
                velocity_tensor,
                frames,
                static_condition=self.config.model.static_condition_fast_path,
            )

    def make_z_timbre_frames(self, z_timbre: Tensor, frames: int) -> Tensor:
        """把 [1,128] 的 z_timbre 展开成 [1,128,frames]（时间轴恒定）。"""
        return z_timbre.to(self.device).view(1, -1, 1).expand(-1, -1, frames)

    def timbre_from_clap(self, clap_embedding: np.ndarray | Tensor) -> Tensor:
        """CLAP 512D → z_timbre 128D，走 checkpoint 里的 timbre.net。

        TimbreAdapter 内部会先做 F.normalize，所以传入是否已归一化都可以。
        """
        if isinstance(clap_embedding, np.ndarray):
            clap_embedding = torch.from_numpy(clap_embedding)
        clap_embedding = clap_embedding.to(self.device, dtype=torch.float32).reshape(1, -1)
        if clap_embedding.shape[-1] != self.config.model.clap_dim:
            raise ValueError(
                f"CLAP 维度应为 {self.config.model.clap_dim}，实际 {clap_embedding.shape[-1]}"
            )
        with torch.no_grad():
            return self.model.timbre(clap_embedding)

    # -- 激励信号 ---------------------------------------------------------
    def excitation_scale(self, note: int) -> Tensor:
        """按训练规范长度算出的激励 RMS 归一化标量（每个 note 缓存一次）。"""
        note = int(note)
        cached = self._excitation_scale.get(note)
        if cached is not None:
            return cached
        raw = self._raw_excitation(note, 0, self._canonical_excitation_samples)
        measured = raw.square().mean(dim=-1, keepdim=True).sqrt().clamp_min(1e-6)
        scale = (self.config.model.excitation_rms / measured).squeeze(0)
        self._excitation_scale[note] = scale
        return scale

    def _raw_excitation(self, note: int, start_sample: int, samples: int) -> Tensor:
        """未归一化的谐波激励，支持任意起始样本偏移（流式续相位的关键）。

        复刻 HarmonicExcitation.forward 的公式，但把 arange(1, samples+1)
        换成 arange(start+1, start+samples+1)，使相位在块之间连续。

        精度提示：frequency 必须用 torch.pow 在 **float32** 下算，和训练时
        一模一样。若改用 Python float64 计算，~1e-8 的相对差会随相位斜坡
        （57k 样本时可达 2.7e5 rad）放大到 ~2.6e-3 rad，输出波形出现 1e-3
        量级偏差。这不是「更准」，而是与 checkpoint 不一致。
        """
        excite = self.model.excitation
        frequency = 440.0 * torch.pow(
            torch.tensor(2.0, device=self.device, dtype=torch.float32),
            (torch.tensor(float(note), device=self.device, dtype=torch.float32) - 69.0) / 12.0,
        )
        time = torch.arange(
            start_sample + 1,
            start_sample + samples + 1,
            device=self.device,
            dtype=torch.float32,
        )
        phase = (2.0 * math.pi / excite.sample_rate) * frequency * time
        out = torch.zeros(1, samples, device=self.device, dtype=torch.float32)
        nyquist = excite.sample_rate / 2.0
        for harmonics in excite.harmonics.split(excite.chunk_size):
            harmonic = harmonics.to(self.device).view(-1, 1)
            keep = (frequency * harmonic <= nyquist)
            out.add_(((torch.sin(phase.view(1, -1) * harmonic) / harmonic) * keep).sum(dim=0, keepdim=True))
        return out

    def excitation_waveform(self, note: int, start_sample: int, samples: int) -> Tensor:
        """归一化后的激励波形 [1, 1, samples]，相位随 start_sample 连续。"""
        raw = self._raw_excitation(note, start_sample, samples)
        return (raw * self.excitation_scale(note)).unsqueeze(0)

    def excitation_bands(self, note: int, start_sample: int, samples: int) -> Tensor:
        """激励的 PQMF 子带 [1, 16, samples/16]。

        PQMF.analysis 两侧各 pad taps//2=128，是**非因果**的（有 128 样本前瞻）。
        但激励完全由 (note, 绝对时间) 决定，多生成 128 样本即可，不构成流式障碍。

        边界语义与模型保持一致：绝对起点 (start_sample==0) 处左侧补零，
        因为 PQMF.analysis 对整段做的就是零填充；start_sample>0 时用真实的
        相位延续信号，这与离线整段分析的「内部帧」完全等价。
        """
        bands = self.geometry.pqmf_bands
        taps = self.geometry.pqmf_taps
        half = taps // 2
        if start_sample == 0:
            body = self.excitation_waveform(note, 0, samples + half)
            wide = torch.nn.functional.pad(body, (half, 0))
        else:
            wide = self.excitation_waveform(note, start_sample - half, samples + 2 * half)
        with torch.no_grad():
            analysed = torch.nn.functional.conv1d(
                wide, self.model.decoder.pqmf.analysis_weight, stride=bands
            )
        return analysed[..., : samples // bands]

    # -- 离线渲染 ---------------------------------------------------------
    @torch.no_grad()
    def render_note(
        self,
        z_timbre: Tensor,
        note: int,
        velocity: int,
        duration_seconds: float,
    ) -> np.ndarray:
        """离线渲染单音 → 44.1 kHz mono float32。

        duration 不是网络输入：它换算成 latent frame 数，解码器是全卷积因果网络，
        可以跑任意长度。
        """
        geom = self.geometry
        note = int(note)
        velocity = int(velocity)
        if not TRAIN_NOTE_MIN <= note <= TRAIN_NOTE_MAX:
            raise ValueError(f"note {note} 超出训练范围 {TRAIN_NOTE_MIN}-{TRAIN_NOTE_MAX}")

        body_frames = geom.frames_for_seconds(duration_seconds)
        total_frames = body_frames + geom.warmup_latent_frames + geom.tail_latent_frames
        total_samples = total_frames * geom.samples_per_latent

        z_midi = self.make_z_midi(note, velocity, total_frames)
        z_timbre_frames = self.make_z_timbre_frames(z_timbre, total_frames)
        bands = self.excitation_bands(note, 0, total_samples)

        waveform = self.model.decoder(z_timbre_frames, z_midi, bands, total_samples)

        start = geom.warmup_latent_frames * geom.samples_per_latent
        wanted = int(round(duration_seconds * geom.sample_rate))
        waveform = waveform[..., start : start + wanted]
        return waveform.squeeze(0).squeeze(0).cpu().numpy().astype(np.float32)

    def describe(self) -> str:
        geom = self.geometry
        return (
            f"midiBrave phase1 step={self.checkpoint_meta.get('step')} "
            f"tensors={self.loaded_tensor_count} "
            f"sr={geom.sample_rate} samples/latent={geom.samples_per_latent} "
            f"latent_rate={geom.latent_rate_hz:.2f}Hz warmup={geom.warmup_latent_frames}"
        )


def _sha256_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    torch.set_num_threads(min(20, torch.get_num_threads()))
    backend = MidiBraveBackend()
    print(backend.describe())
    print("checkpoint meta:", backend.checkpoint_meta)
    print("geometry:", backend.geometry)

    # 无参考音频时用零向量过 timbre.net，只验证通路能出声。
    zero_clap = torch.zeros(1, backend.config.model.clap_dim)
    z = backend.timbre_from_clap(zero_clap)
    print("z_timbre:", tuple(z.shape), "range", float(z.min()), float(z.max()))

    audio = backend.render_note(z, note=60, velocity=127, duration_seconds=1.0)
    print("audio:", audio.shape, audio.dtype, "peak", float(np.abs(audio).max()))
