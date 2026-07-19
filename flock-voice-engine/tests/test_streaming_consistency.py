"""midiBrave 流式推理的独立正确性判据。

本文件是**独立验证方**写的，不是实现方写的。所有「应该等于多少」的期望值都从
`/home/jyhu/MidiBrave/src/midibrave/model.py` 的结构本身推导，而不是从
`server/backends/streaming.py` 的实现反推 —— 否则实现里怎么想的、测试里就怎么
假设，PQMF 偏移、cache 预热这类对齐错误会整条漏掉。

## 被测对象与预言机（oracle）的分工

    被测：server.backends.streaming.StreamingVoice  的**跨块状态管理**
    预言机：本文件的 _ReferenceBackend —— 激励生成、PQMF 分析、离线整段渲染

`StreamingVoice` 通过 backend 拿激励和条件。这里注入的 backend 是本文件按 model.py
独立实现的参考版本，离线基准也由它算。所以被测的是「怎么切块、怎么接缝」，
预言机是「整段应该长什么样」。两边不共享任何对齐假设。

## 独立推导的关键量（详细推导见 docs/streaming-design.md）

  * `samples_per_latent = pqmf_bands(16) * prod(ratios)(8) = 128`
  * 解码器主干全部因果 → **不贡献任何延迟**
  * `PQMF.synthesis` 是唯一的非因果点：conv_transpose(stride=16, 257 taps) 之后
    切 `[taps//2 : ...]` → 输出比子带滞后 **128 样本**
  * 离线 `render_note` 还要丢掉 `warmup_latent_frames(64) * 128 = 8192` 样本
  * ⇒ 未暖机的原始 emit 流与离线输出的对齐偏移 = 8192 + 128 = **8320 样本**

第 5 条测试会把这个 8320 用「扫描对齐偏移取误差最小值」的方式反查出来，
如果实现里的暖机丢弃量算错了，argmin 就不会落在 8320 上。

## 四条判据

  1. `test_streaming_matches_offline`   逐样本一致性（含误差位置分布）
  2. `test_block_boundary_continuity`   块接缝处不能有异常跳变
  3. `test_reset_reproducibility`       reset 后重渲染必须逐位一致
  4. `test_block_size_independence`     512 / 1024 / 2048 结果必须一致

外加两条元测试：

  5. `test_latency_offset_is_independently_derivable`  交叉验证 8320
  6. `test_suite_detects_missing_state`                阴性对照：无状态实现必须挂

## 跑法

    python3 tests/test_streaming_consistency.py        # 微型 stub，秒级，无需权重
    pytest tests/test_streaming_consistency.py

stub 是按 model.py 等比缩小的**忠实微缩版**：时间轴相关的参数（pqmf_bands /
pqmf_taps / ratios / anti_image_taps / warmup_latent_frames）全部保持真值不变，
只缩小通道宽度。被测的是时间对齐，缩通道不影响结论。
"""
from __future__ import annotations

import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from scipy.signal import firwin
from torch import Tensor, nn
from torch.nn import functional as F

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


# ===========================================================================
# 1. 忠实微缩 stub 模型
#    结构逐类对应 model.py。时间轴参数保持真值，只缩通道。
# ===========================================================================


class CausalConv1d(nn.Conv1d):
    """左侧 pad `dilation*(k-1)`，右侧不 pad —— 真因果。"""

    def __init__(self, *args, causal_pad_mode: str = "constant", **kwargs):
        super().__init__(*args, **kwargs)
        self.causal_pad_mode = causal_pad_mode

    def forward(self, x: Tensor) -> Tensor:
        pad = self.dilation[0] * (self.kernel_size[0] - 1)
        if not pad:
            return super().forward(x)
        return super().forward(F.pad(x, (pad, 0), mode=self.causal_pad_mode)
                               if self.causal_pad_mode != "constant"
                               else F.pad(x, (pad, 0)))


class FiLM(nn.Module):
    def __init__(self, condition_dim: int, channels: int):
        super().__init__()
        self.affine = nn.Conv1d(condition_dim, channels * 2, 1)

    def forward(self, x: Tensor, condition: Tensor, static_condition: bool = False) -> Tensor:
        if condition.ndim == 2:
            condition = condition.unsqueeze(-1)
        if static_condition:
            condition = condition[..., :1]
            gamma, beta = self.affine(condition).chunk(2, dim=1)
            gamma = gamma.expand(-1, -1, x.shape[-1])
            beta = beta.expand(-1, -1, x.shape[-1])
            return x * (1.0 + gamma) + beta
        if condition.shape[-1] != x.shape[-1]:
            condition = F.interpolate(condition, size=x.shape[-1], mode="nearest")
        gamma, beta = self.affine(condition).chunk(2, dim=1)
        return x * (1.0 + gamma) + beta


class ResidualBlock(nn.Module):
    def __init__(self, channels: int, midi_dim: int, excitation_dim: int, dilation: int):
        super().__init__()
        self.conv1 = CausalConv1d(channels, channels, 3, dilation=dilation)
        self.conv2 = CausalConv1d(channels, channels, 1)
        self.film = FiLM(midi_dim, channels)
        self.excitation_film = FiLM(excitation_dim, channels)

    def forward(self, x: Tensor, z_midi: Tensor, excitation: Tensor,
                static_midi: bool = False) -> Tensor:
        y = F.silu(self.conv1(x))
        y = self.film(self.conv2(y), z_midi, static_condition=static_midi)
        y = self.excitation_film(y, excitation)
        return (x + y) * (2.0**-0.5)


class PQMF(nn.Module):
    """与 model.py 逐行相同 —— PQMF 是本次验证的核心，一个系数都不能改。"""

    def __init__(self, bands: int = 16, taps: int = 256, beta: float = 9.0):
        super().__init__()
        prototype = firwin(taps + 1, 0.56592 / bands, window=("kaiser", beta))
        n = np.arange(taps + 1, dtype=np.float64) - taps / 2
        analysis, synthesis = [], []
        for k in range(bands):
            carrier = (2 * k + 1) * np.pi * n / (2 * bands)
            phase = ((-1) ** k) * np.pi / 4
            analysis.append(2 * prototype * np.cos(carrier + phase))
            synthesis.append(2 * prototype * np.cos(carrier - phase))
        self.register_buffer("analysis_weight",
                             torch.tensor(np.stack(analysis)[:, ::-1].copy(),
                                          dtype=torch.float32).unsqueeze(1))
        self.register_buffer("synthesis_weight",
                             torch.tensor(np.stack(synthesis), dtype=torch.float32).unsqueeze(1))
        self.bands = bands
        self.taps = taps

    def analysis(self, waveform: Tensor) -> Tensor:
        waveform = F.pad(waveform, (self.taps // 2, self.taps // 2))
        return F.conv1d(waveform, self.analysis_weight, stride=self.bands)

    def synthesis(self, subbands: Tensor, output_samples: int | None = None) -> Tensor:
        waveform = F.conv_transpose1d(subbands, self.synthesis_weight, stride=self.bands)
        start = self.taps // 2
        if output_samples is None:
            output_samples = subbands.shape[-1] * self.bands
        waveform = waveform[..., start:start + output_samples] * self.bands
        if waveform.shape[-1] < output_samples:
            waveform = F.pad(waveform, (0, output_samples - waveform.shape[-1]))
        return waveform


class FixedAntiAlias(nn.Module):
    def __init__(self, ratio: int, taps: int):
        super().__init__()
        kernel = firwin(taps, 1.0 / ratio, window=("kaiser", 8.6)).astype(np.float32)
        self.register_buffer("kernel", torch.from_numpy(kernel).view(1, 1, -1))
        self.pad = taps - 1

    def forward(self, x: Tensor) -> Tensor:
        weight = self.kernel.expand(x.shape[1], 1, -1)
        return F.conv1d(F.pad(x, (self.pad, 0), mode="replicate"), weight, groups=x.shape[1])


class HarmonicExcitation(nn.Module):
    def __init__(self, sample_rate: int, max_harmonics: int, target_rms: float,
                 chunk_size: int = 16):
        super().__init__()
        self.sample_rate = sample_rate
        self.target_rms = target_rms
        self.chunk_size = chunk_size
        self.register_buffer("harmonics",
                             torch.arange(1, max_harmonics + 1, dtype=torch.float32))

    @torch.no_grad()
    def forward(self, note: Tensor, samples: int) -> Tensor:
        frequency = 440.0 * torch.pow(2.0, (note.float() - 69.0) / 12.0)
        time = torch.arange(1, samples + 1, device=note.device, dtype=torch.float32)
        phase = (2.0 * math.pi / self.sample_rate) * frequency[:, None] * time[None, :]
        excitation = torch.zeros_like(phase)
        for harmonics in self.harmonics.split(self.chunk_size):
            harmonic = harmonics.view(1, -1, 1)
            keep = (frequency[:, None, None] * harmonic <= self.sample_rate / 2.0)
            excitation.add_(((torch.sin(phase[:, None, :] * harmonic) / harmonic)
                             * keep).sum(dim=1))
        measured = excitation.square().mean(dim=-1, keepdim=True).sqrt().clamp_min(1e-6)
        return (excitation * (self.target_rms / measured)).unsqueeze(1)


class ExcitationDownsample(CausalConv1d):
    def __init__(self, bands: int, ratio: int):
        super().__init__(bands, bands, 2 * ratio, stride=ratio, causal_pad_mode="replicate")


class MidiConditioner(nn.Module):
    def __init__(self, output_dim: int = 32):
        super().__init__()
        self.note = nn.Embedding(128, 16)
        self.continuous = nn.Sequential(nn.Linear(2, 32), nn.SiLU(), nn.Linear(32, 16))
        self.tcn = nn.Sequential(
            CausalConv1d(32, 32, 3, dilation=1, causal_pad_mode="replicate"), nn.SiLU(),
            CausalConv1d(32, 32, 3, dilation=2, causal_pad_mode="replicate"), nn.SiLU(),
            CausalConv1d(32, 32, 3, dilation=4, causal_pad_mode="replicate"),
        )

    def forward(self, note: Tensor, velocity: Tensor, frames: int,
                static_condition: bool = False) -> Tensor:
        note = note.long().clamp(0, 127)
        velocity = velocity.float().clamp(0, 127)
        continuous = torch.stack(((note.float() - 69.0) / 48.0, velocity / 127.0), dim=-1)
        z = torch.cat((self.note(note), self.continuous(continuous)), dim=-1)
        if static_condition:
            return self.tcn(z.unsqueeze(-1)).expand(-1, -1, frames)
        return self.tcn(z.unsqueeze(-1).expand(-1, -1, frames))


class FusionProjection(nn.Module):
    def __init__(self, input_dim: int, output_dim: int):
        super().__init__()
        self.net = nn.Sequential(nn.Conv1d(input_dim, output_dim, 1), nn.SiLU(),
                                 nn.Conv1d(output_dim, output_dim, 1))

    def forward(self, z_timbre: Tensor, z_midi: Tensor, static_condition: bool = False) -> Tensor:
        if static_condition:
            fused = self.net(torch.cat((z_timbre[..., :1], z_midi[..., :1]), dim=1))
            return fused.expand(-1, -1, z_midi.shape[-1])
        return self.net(torch.cat((z_timbre, z_midi), dim=1))


class BraveDecoder(nn.Module):
    def __init__(self, cfg: "StubConfig"):
        super().__init__()
        self.ratios = cfg.ratios
        channels = [cfg.capacity * 16, cfg.capacity * 8, cfg.capacity * 4,
                    cfg.capacity * 2, cfg.capacity]
        self.fusion = FusionProjection(cfg.timbre_dim + cfg.midi_dim, channels[0])
        self.blocks = nn.ModuleList()
        self.projections = nn.ModuleList()
        self.anti_alias = nn.ModuleList()
        for index, ratio in enumerate(self.ratios):
            self.blocks.append(nn.ModuleList([
                ResidualBlock(channels[index + 1], cfg.midi_dim, cfg.pqmf_bands, 1),
                ResidualBlock(channels[index + 1], cfg.midi_dim, cfg.pqmf_bands, 3),
                ResidualBlock(channels[index + 1], cfg.midi_dim, cfg.pqmf_bands, 9),
            ]))
            self.anti_alias.append(FixedAntiAlias(ratio, cfg.anti_image_taps)
                                   if ratio > 1 else nn.Identity())
            self.projections.append(CausalConv1d(channels[index], channels[index + 1], 3))
        self.excitation_downsamplers = nn.ModuleList([
            ExcitationDownsample(cfg.pqmf_bands, ratio) if ratio > 1 else nn.Identity()
            for ratio in reversed(self.ratios[1:])
        ])
        self.output = CausalConv1d(channels[-1], cfg.pqmf_bands, 7)
        self.pqmf = PQMF(cfg.pqmf_bands, cfg.pqmf_taps)
        self.static_condition_fast_path = cfg.static_condition_fast_path

    def conditioning_levels(self, excitation: Tensor) -> list[Tensor]:
        levels = [excitation]
        current = excitation
        for downsampler in self.excitation_downsamplers:
            current = downsampler(current)
            levels.insert(0, current)
        return levels

    def forward(self, z_timbre: Tensor, z_midi: Tensor, excitation: Tensor,
                output_samples: int) -> Tensor:
        levels = self.conditioning_levels(excitation)
        x = self.fusion(z_timbre, z_midi, self.static_condition_fast_path)
        for ratio, blocks, anti_alias, projection, level in zip(
                self.ratios, self.blocks, self.anti_alias, self.projections, levels):
            if ratio > 1:
                x = F.interpolate(x, scale_factor=ratio, mode="nearest")
                x = anti_alias(x)
            x = F.silu(projection(x))
            assert level.shape[-1] == x.shape[-1], "激励金字塔与上采样级不匹配"
            for block in blocks:
                x = block(x, z_midi[..., :1] if self.static_condition_fast_path else z_midi,
                          level, static_midi=self.static_condition_fast_path)
        return torch.tanh(self.pqmf.synthesis(self.output(x), output_samples))


@dataclass(frozen=True)
class StubConfig:
    """时间轴参数 = 真值（full_c9_optimized.yaml），通道 = 缩小。"""

    # —— 保持真值：这些决定时间对齐 ——
    sample_rate: int = 44_100
    pqmf_bands: int = 16
    pqmf_taps: int = 256
    ratios: tuple[int, ...] = (2, 2, 2, 1)
    anti_image_taps: int = 31
    warmup_latent_frames: int = 64
    window_samples: int = 49_152
    excitation_rms: float = 0.1
    static_condition_fast_path: bool = True
    midi_dim: int = 32                    # MidiConditioner 强制 32
    # —— 缩小：只影响算力，不影响时间轴 ——
    capacity: int = 4
    timbre_dim: int = 16
    excitation_harmonics: int = 16


class StubMidiBrave(nn.Module):
    def __init__(self, cfg: StubConfig):
        super().__init__()
        self.config = cfg
        self.samples_per_latent = cfg.pqmf_bands * int(np.prod(cfg.ratios))
        self.latent_frames = cfg.window_samples // self.samples_per_latent
        self.tail_latent_frames = math.ceil((cfg.pqmf_taps // 2) / self.samples_per_latent)
        self.total_latent_frames = (self.latent_frames + cfg.warmup_latent_frames
                                    + self.tail_latent_frames)
        self.midi = MidiConditioner(cfg.midi_dim)
        self.decoder = BraveDecoder(cfg)
        self.excitation = HarmonicExcitation(cfg.sample_rate, cfg.excitation_harmonics,
                                             cfg.excitation_rms)


def build_stub_model(seed: int = 20260720) -> StubMidiBrave:
    """构造带随机权重的 stub。

    **关键**：真模型里 `FiLM.affine` 和 `ExcitationDownsample` 都是零/恒等初始化。
    如果照搬，FiLM 就是恒等映射 → 激励条件对输出毫无影响 → 激励相位连续性、
    excitation 下采样器的 cache 全都测不到，静态条件下输出还会在时间上恒定，
    接缝测试直接退化成平凡通过。所以这里必须把它们随机化。
    """
    torch.manual_seed(seed)
    model = StubMidiBrave(StubConfig())
    with torch.no_grad():
        for module in model.modules():
            if isinstance(module, FiLM):
                module.affine.weight.normal_(0.0, 0.05)
                module.affine.bias.normal_(0.0, 0.02)
            elif isinstance(module, ExcitationDownsample):
                kernel_size = module.kernel_size[0]
                module.weight.normal_(0.0, 0.05)
                module.bias.zero_()
                for band in range(module.weight.shape[0]):
                    module.weight[band, band] += 1.0 / kernel_size
    return model.eval().requires_grad_(False)


# ===========================================================================
# 2. 参考 backend（预言机）
#    激励生成 / PQMF 分析 / 离线整段渲染，全部按 model.py 独立推导。
# ===========================================================================


@dataclass(frozen=True)
class _Geometry:
    sample_rate: int
    pqmf_bands: int
    pqmf_taps: int
    ratios: tuple[int, ...]
    samples_per_latent: int
    warmup_latent_frames: int
    tail_latent_frames: int
    total_latent_frames: int


class ReferenceBackend:
    """`StreamingVoice` 需要的 backend 契约的独立实现。

    这是预言机，不是被测对象。三个职责：

    1. `excitation_bands(note, start, n)` —— 支持任意绝对起点的激励子带。
       `HarmonicExcitation` 的时间轴是 `arange(1, samples+1)`，这里换成
       `arange(start+1, start+n+1)`，其余算式与求和顺序逐字照抄，保证流式与
       离线走的是同一串浮点运算。
    2. RMS 归一化用**训练规范长度**算一次并按 note 缓存。原始 forward 是按当次
       生成长度算 RMS 的 —— 逐块各算各的会让每块增益不同，块边界必爆音。
    3. `render_note` —— 离线整段基准。
    """

    def __init__(self, model: StubMidiBrave) -> None:
        self.model = model
        cfg = model.config
        self.geometry = _Geometry(
            sample_rate=cfg.sample_rate,
            pqmf_bands=cfg.pqmf_bands,
            pqmf_taps=cfg.pqmf_taps,
            ratios=cfg.ratios,
            samples_per_latent=model.samples_per_latent,
            warmup_latent_frames=cfg.warmup_latent_frames,
            tail_latent_frames=model.tail_latent_frames,
            total_latent_frames=model.total_latent_frames,
        )
        self._canonical = model.total_latent_frames * model.samples_per_latent
        self._scale: dict[int, Tensor] = {}

    # -- 条件 --------------------------------------------------------------

    def make_z_midi(self, note: int, velocity: int, frames: int) -> Tensor:
        return self.model.midi(
            torch.tensor([int(note)], dtype=torch.long),
            torch.tensor([float(velocity)], dtype=torch.float32),
            frames,
            static_condition=self.model.config.static_condition_fast_path,
        )

    def make_z_timbre_frames(self, z_timbre: Tensor, frames: int) -> Tensor:
        return z_timbre.view(1, -1, 1).expand(-1, -1, frames)

    # -- 激励 --------------------------------------------------------------

    def _raw_excitation(self, note: int, start: int, samples: int) -> Tensor:
        exc = self.model.excitation
        note_t = torch.tensor([float(note)], dtype=torch.float32)
        frequency = 440.0 * torch.pow(2.0, (note_t - 69.0) / 12.0)
        time = torch.arange(start + 1, start + samples + 1, dtype=torch.float32)
        phase = (2.0 * math.pi / exc.sample_rate) * frequency[:, None] * time[None, :]
        out = torch.zeros_like(phase)
        for harmonics in exc.harmonics.split(exc.chunk_size):
            harmonic = harmonics.view(1, -1, 1)
            keep = (frequency[:, None, None] * harmonic <= exc.sample_rate / 2.0)
            out.add_(((torch.sin(phase[:, None, :] * harmonic) / harmonic) * keep).sum(dim=1))
        return out

    def excitation_scale(self, note: int) -> Tensor:
        key = int(note)
        cached = self._scale.get(key)
        if cached is None:
            raw = self._raw_excitation(key, 0, self._canonical)
            measured = raw.square().mean(dim=-1, keepdim=True).sqrt().clamp_min(1e-6)
            cached = self.model.config.excitation_rms / measured
            self._scale[key] = cached
        return cached

    def excitation_bands(self, note: int, start_sample: int, samples: int) -> Tensor:
        """任意绝对起点的激励 PQMF 子带 `[1, bands, samples//bands]`。

        `PQMF.analysis` 两侧各 pad `taps//2 = 128`，是**非因果**的。但激励由
        (note, 绝对时间) 解析决定，多生成 128 个前瞻样本即可 —— 不产生延迟。
        绝对原点之前补零，与离线整段分析的零填充语义一致。
        """
        half = self.geometry.pqmf_taps // 2
        low = start_sample - half
        total = samples + 2 * half
        scale = self.excitation_scale(note)
        if low < 0:
            head = -low
            body = self._raw_excitation(note, 0, total - head) * scale
            wide = F.pad(body.unsqueeze(0), (head, 0))
        else:
            wide = (self._raw_excitation(note, low, total) * scale).unsqueeze(0)
        return F.conv1d(wide, self.model.decoder.pqmf.analysis_weight,
                        stride=self.geometry.pqmf_bands)

    # -- 离线基准 ----------------------------------------------------------

    @torch.no_grad()
    def render_frames(self, z_timbre: Tensor, note: int, velocity: int,
                      body_frames: int) -> np.ndarray:
        """一次性离线渲染 `body_frames` 个 latent frame 的正式输出。"""
        geom = self.geometry
        total_frames = body_frames + geom.warmup_latent_frames + geom.tail_latent_frames
        total_samples = total_frames * geom.samples_per_latent
        waveform = self.model.decoder(
            self.make_z_timbre_frames(z_timbre, total_frames),
            self.make_z_midi(note, velocity, total_frames),
            self.excitation_bands(note, 0, total_samples),
            total_samples,
        )
        start = geom.warmup_latent_frames * geom.samples_per_latent
        return waveform[..., start:].squeeze(0).squeeze(0).numpy().astype(np.float32)

    @torch.no_grad()
    def render_note(self, z_timbre: Tensor, note: int, velocity: int,
                    duration_seconds: float) -> np.ndarray:
        geom = self.geometry
        frames = max(1, math.ceil(duration_seconds * geom.sample_rate / geom.samples_per_latent))
        wanted = int(round(duration_seconds * geom.sample_rate))
        return self.render_frames(z_timbre, note, velocity, frames)[:wanted]


# ===========================================================================
# 3. 独立推导出来的常量
# ===========================================================================

SAMPLES_PER_LATENT = 16 * 2 * 2 * 2 * 1          # pqmf_bands * prod(ratios) = 128
PQMF_SYNTHESIS_LATENCY = 256 // 2                # taps//2 = 128（唯一的非因果点）
WARMUP_DISCARD = 64 * SAMPLES_PER_LATENT         # warmup_latent_frames * spl = 8192
PREDICTED_RAW_OFFSET = WARMUP_DISCARD + PQMF_SYNTHESIS_LATENCY   # = 8320


def decoder_receptive_field_frames(decoder: nn.Module) -> int:
    """解码器主干的左侧感受野，换算到 latent frame。

    从输出层往回推，每跨过一级上采样就把「当前速率下的左依赖」除以 ratio。
    真模型上的结果是 **55 帧**，小于 `warmup_latent_frames=64` —— 这正是离线
    暖机 64 帧足够、且流式暖机后与离线等价的前提。
    """
    left = decoder.output.dilation[0] * (decoder.output.kernel_size[0] - 1)
    for index in reversed(range(len(decoder.ratios))):
        for block in decoder.blocks[index]:
            left += block.conv1.dilation[0] * (block.conv1.kernel_size[0] - 1)
        projection = decoder.projections[index]
        left += projection.dilation[0] * (projection.kernel_size[0] - 1)
        ratio = decoder.ratios[index]
        if ratio > 1:
            left += decoder.anti_alias[index].pad
            left = math.ceil(left / ratio)
    return left


# ===========================================================================
# 4. 测试夹具
# ===========================================================================

NOTE = 60
VELOCITY = 127
BLOCK = 1024
BLOCKS = 10
MARGIN_FRAMES = 8      # 离线右边界（PQMF 右溢出 + 激励右侧零填充）的隔离带
TOLERANCE = 2e-5       # float32 + tanh 下的可接受逐样本误差


def _fixture():
    model = build_stub_model()
    backend = ReferenceBackend(model)
    torch.manual_seed(7)
    z_timbre = torch.randn(1, model.config.timbre_dim).tanh()
    return model, backend, z_timbre


def _import_streaming():
    from server.backends import streaming  # noqa: PLC0415
    return streaming


def _stream(backend, z_timbre, *, block: int = BLOCK, blocks: int = BLOCKS,
            run_warmup: bool = True) -> np.ndarray:
    streaming = _import_streaming()
    voice = streaming.StreamingVoice(backend)
    voice.note_on(z_timbre, NOTE, VELOCITY, run_warmup=run_warmup)
    return np.concatenate([voice.render_block(block) for _ in range(blocks)])


def _offline(backend, z_timbre, samples: int) -> np.ndarray:
    frames = samples // SAMPLES_PER_LATENT + MARGIN_FRAMES
    return backend.render_frames(z_timbre, NOTE, VELOCITY, frames)[:samples]


# ===========================================================================
# 5. 判据
# ===========================================================================


def test_geometry_matches_independent_derivation():
    """先确认 stub 的时间轴几何与手推的一致，后面的期望值才站得住。"""
    model, backend, _ = _fixture()
    assert model.samples_per_latent == SAMPLES_PER_LATENT
    assert backend.geometry.pqmf_taps // 2 == PQMF_SYNTHESIS_LATENCY
    assert backend.geometry.tail_latent_frames == 1     # ceil(128/128)

    receptive_field = decoder_receptive_field_frames(model.decoder)
    assert receptive_field == 55, f"感受野推导对不上: {receptive_field}"
    assert receptive_field < backend.geometry.warmup_latent_frames, (
        "暖机帧数必须大于感受野，否则流式暖机后与离线不等价"
    )
    print(f"  几何: spl={SAMPLES_PER_LATENT} 感受野={receptive_field} 帧 "
          f"warmup=64 帧 PQMF 延迟={PQMF_SYNTHESIS_LATENCY} 样本")


def test_streaming_matches_offline():
    """判据 1：逐块流式 vs 一次性离线，逐样本比较。"""
    _, backend, z_timbre = _fixture()
    stream = _stream(backend, z_timbre)
    offline = _offline(backend, z_timbre, len(stream))

    error = np.abs(stream - offline)
    peak = float(np.abs(offline).max())
    worst = int(error.argmax())

    # 误差在块内的位置分布 —— 如果错都堆在块头，就是 cache 预热问题
    within = worst % BLOCK
    per_block = error.reshape(-1, BLOCK).max(axis=1)
    head = float(error.reshape(-1, BLOCK)[:, :32].max())
    body = float(error.reshape(-1, BLOCK)[:, 32:].max())

    print(f"  峰值 {peak:.4f} 最大误差 {error.max():.3e} @ 样本 {worst} (块内 {within})")
    print(f"  块头 32 样本内最大误差 {head:.3e} / 其余 {body:.3e}")
    print(f"  逐块最大误差: {np.array2string(per_block, precision=1, max_line_width=100)}")

    assert error.max() < TOLERANCE, (
        f"流式与离线不一致：最大误差 {error.max():.3e} @ 样本 {worst}（块内偏移 {within}）"
    )
    # 误差不该系统性地集中在块头 —— 那是 cache 没接好的指纹
    assert head < TOLERANCE and body < TOLERANCE


HEAD_SAMPLES = 64      # 「块头」的宽度：cache 预热错误的瞬态就落在这里


def _head_body_ratio(error: np.ndarray, block: int) -> tuple[float, float, float]:
    """误差在块头 / 块内其余部分的能量比。cache 没接好的指纹就是这个比值 >> 1。"""
    framed = error.reshape(-1, block)
    head = float(np.sqrt((framed[:, :HEAD_SAMPLES] ** 2).mean()))
    body = float(np.sqrt((framed[:, HEAD_SAMPLES:] ** 2).mean()))
    return head, body, head / max(body, 1e-12)


def test_block_boundary_continuity():
    """判据 2：接缝处不能有块头局部化的瞬态。

    ⚠️ 这条判据的形式是踩过坑才定下来的。最直觉的写法 ——「看接缝处
    `|y[n+1]-y[n]|` 是不是显著大于块内分布」—— 在这个模型上**没有区分力**：
    输出是宽带谐波信号，相邻样本天然就能差 1.3；而 cache 预热错误产生的是一段
    幅度约 0.07、按感受野长度衰减的**瞬态**，不是阶跃，整个埋在信号自身的
    步长分布底下。判据 6 的变异体实测接缝/块内跳变比只有 0.2x，纯自参照的
    接缝指标一次都没抓住。

    所以这里改成：拿流式误差（相对离线基准）按块折叠，看误差能量是否**局部
    集中在块头**。这才是跨块状态没接好的真正指纹。纯自参照的接缝跳变仍然打印
    出来，但只作参考，不作断言 —— 它太松，当判据会给假绿。
    """
    _, backend, z_timbre = _fixture()
    stream = _stream(backend, z_timbre)
    offline = _offline(backend, z_timbre, len(stream))
    error = np.abs(stream - offline)

    head, body, ratio = _head_body_ratio(error, BLOCK)

    # 仅供参考的自参照指标（不作断言，理由见 docstring）
    step = np.abs(np.diff(stream))
    seam = np.arange(1, BLOCKS) * BLOCK - 1
    seam_ratio = float(step[seam].max() / np.percentile(np.delete(step, seam), 99.99))

    print(f"  块头 RMS 误差 {head:.3e} / 块内其余 {body:.3e} → 比值 {ratio:.2f}x")
    print(f"  （参考，不作判据）接缝/块内跳变比 {seam_ratio:.2f}x")

    assert ratio < 4.0, (
        f"误差集中在块头（{ratio:.1f}x）—— 卷积 cache 或 overlap-add 尾巴没接好"
    )
    assert head < TOLERANCE, f"块头误差 {head:.3e} 超出容差"


def test_reset_reproducibility():
    """判据 3：重建会话后渲染同一段，必须逐位一致。"""
    _, backend, z_timbre = _fixture()
    first = _stream(backend, z_timbre)
    second = _stream(backend, z_timbre)
    error = float(np.abs(first - second).max())
    print(f"  两次渲染最大差 {error:.3e}")
    assert error == 0.0, f"reset 后不可复现，残留状态未清干净：{error:.3e}"


def test_block_size_independence():
    """判据 4：512 / 1024 / 2048 渲染同一段必须一致 —— 最能抓状态管理的错。"""
    _, backend, z_timbre = _fixture()
    total = BLOCK * BLOCKS
    results = {}
    for block in (512, 1024, 2048):
        assert total % block == 0
        results[block] = _stream(backend, z_timbre, block=block, blocks=total // block)

    baseline = results[1024]
    for block, audio in results.items():
        error = float(np.abs(audio - baseline).max())
        print(f"  block={block:5d} vs 1024: 最大差 {error:.3e}")
        assert error < TOLERANCE, (
            f"块大小 {block} 与 1024 结果不一致（{error:.3e}）—— 跨块状态与块长耦合了"
        )


def test_latency_offset_is_independently_derivable():
    """判据 5（交叉验证）：不靠试，直接验证对齐偏移就是推导出来的 8320。

    关掉暖机拿到**原始 emit 流**，与离线输出做偏移扫描。按 model.py 推导：

        原始偏移 = warmup_latent_frames * samples_per_latent  (8192)
                 + PQMF.synthesis 的 taps//2 切片             (128)
                 = 8320

    argmin 落在别处，说明实现里的暖机丢弃量或 PQMF 偏移算错了。
    """
    _, backend, z_timbre = _fixture()
    probe = 4096
    raw = _stream(backend, z_timbre, block=BLOCK,
                  blocks=(PREDICTED_RAW_OFFSET + probe) // BLOCK + 1, run_warmup=False)
    offline = _offline(backend, z_timbre, probe)

    candidates = range(PREDICTED_RAW_OFFSET - 4 * SAMPLES_PER_LATENT,
                       PREDICTED_RAW_OFFSET + 4 * SAMPLES_PER_LATENT + 1, 16)
    scores = {shift: float(np.abs(raw[shift:shift + probe] - offline).max())
              for shift in candidates}
    best = min(scores, key=scores.__getitem__)

    print(f"  推导偏移 {PREDICTED_RAW_OFFSET} = warmup {WARMUP_DISCARD} + PQMF "
          f"{PQMF_SYNTHESIS_LATENCY}；扫描 argmin = {best} (误差 {scores[best]:.3e})")
    assert best == PREDICTED_RAW_OFFSET, (
        f"对齐偏移实测 {best}，推导值 {PREDICTED_RAW_OFFSET}；"
        "暖机丢弃量或 PQMF 合成偏移有一处算错了"
    )
    assert scores[PREDICTED_RAW_OFFSET] < TOLERANCE

    # 偏移哪怕只错一个 latent frame，误差也必须炸开 —— 证明这条判据是紧的
    neighbour = scores[PREDICTED_RAW_OFFSET + SAMPLES_PER_LATENT]
    assert neighbour > scores[best] * 100, (
        f"偏移敏感度不足（邻点误差 {neighbour:.3e}），本条判据不具区分力"
    )


def test_suite_detects_injected_bugs():
    """判据 6（变异测试）：故意注入的三种典型 bug 必须被上面的判据抓住。

    没有这条，「全部通过」可能只是因为判据本身太松。三个变异体对应三类真实错误：

      A. **卷积 cache 丢失** —— 每块用零/replicate 重新起 padding。
         经典的「忘了保存左上文」，表现为块头瞬态。
      B. **PQMF 合成偏移少算 128** —— 只丢 `warmup*128`，没算
         `PQMF.synthesis` 的 `taps//2` 切片。这正是实现方自述卡住的那个坑，
         判据 1 必须能直接指出来。
      C. **overlap-add 尾巴丢失** —— 每块的 conv_transpose 右溢出不接到下一块。

    同时记录每条判据对每个变异体的灵敏度：判据 2 只对 A / C 这类块头局部化的
    错误敏感，对 B（整体偏移）无能为力 —— 这不是缺陷，是分工，写进文档备查。
    """
    streaming = _import_streaming()
    _, backend, z_timbre = _fixture()
    reference = _offline(backend, z_timbre, BLOCK * BLOCKS)

    def score(audio: np.ndarray) -> tuple[float, float]:
        error = np.abs(audio - reference)
        return float(error.max()), _head_body_ratio(error, BLOCK)[2]

    results: dict[str, tuple[float, float]] = {}

    # -- A: 卷积 cache 丢失 --------------------------------------------
    original = streaming._causal_conv_stream
    try:
        streaming._causal_conv_stream = (
            lambda conv, x, cache, pad_mode: (original(conv, x, None, pad_mode)[0], None)
        )
        results["A 卷积 cache 丢失"] = score(_stream(backend, z_timbre))
    finally:
        streaming._causal_conv_stream = original

    # -- B: PQMF 合成偏移少算 128（只用公开接口构造）----------------------
    raw = _stream(backend, z_timbre, blocks=BLOCKS + 8, run_warmup=False)
    results["B PQMF 偏移少 128"] = score(
        raw[WARMUP_DISCARD:WARMUP_DISCARD + BLOCK * BLOCKS]
    )

    # -- C: overlap-add 尾巴丢失 ----------------------------------------
    original_render = streaming.StreamingVoice._render_samples

    def no_tail(self, samples, discard):
        out = original_render(self, samples, discard)
        self.state.ola_tail = None
        return out

    try:
        streaming.StreamingVoice._render_samples = no_tail
        results["C overlap-add 丢失"] = score(_stream(backend, z_timbre))
    finally:
        streaming.StreamingVoice._render_samples = original_render

    for name, (peak, ratio) in results.items():
        caught_1 = peak > TOLERANCE * 100
        caught_2 = ratio > 4.0
        print(f"  {name}: 最大误差 {peak:.3e} → 判据1 {'抓到' if caught_1 else '漏掉'}"
              f" / 块头比 {ratio:.1f}x → 判据2 {'抓到' if caught_2 else '漏掉'}")
        assert caught_1, f"变异体「{name}」没被判据 1 抓住（{peak:.3e}），容差太松"

    # 判据 2 的适用范围：只吃块头局部化的错误
    assert results["A 卷积 cache 丢失"][1] > 4.0, "判据 2 应当抓住 cache 丢失"
    assert results["C overlap-add 丢失"][1] > 4.0, "判据 2 应当抓住 overlap-add 丢失"


# ===========================================================================
# 6. 真模型冒烟（有权重时才跑；Mac 上默认跳过）
# ===========================================================================


def main_real_model() -> int:
    """在 Spark 上对真 checkpoint 跑同样的四条判据。"""
    try:
        from server.backends.midibrave_backend import MidiBraveBackend  # noqa: PLC0415
        backend = MidiBraveBackend()
    except Exception as error:  # noqa: BLE0001
        print(f"跳过真模型（{type(error).__name__}: {error}）")
        return 0

    streaming = _import_streaming()
    z_timbre = backend.timbre_from_clap(torch.zeros(1, backend.config.model.clap_dim))
    seconds = 1.0
    offline = backend.render_note(z_timbre, NOTE, VELOCITY, seconds)

    ok = True
    for block in (512, 1024, 2048):
        stream = streaming.render_streaming(backend, z_timbre, NOTE, VELOCITY, seconds,
                                            block_samples=block)
        length = min(len(offline), len(stream))
        error = float(np.abs(offline[:length] - stream[:length]).max())
        status = "PASS" if error < 1e-4 else "FAIL"
        ok &= error < 1e-4
        print(f"  [{status}] 真模型 block={block:5d} 最大误差 {error:.3e} "
              f"(峰值 {np.abs(offline).max():.4f})")
    return 0 if ok else 1


# ===========================================================================
# 7. 入口
# ===========================================================================

TESTS = (
    test_geometry_matches_independent_derivation,
    test_streaming_matches_offline,
    test_block_boundary_continuity,
    test_reset_reproducibility,
    test_block_size_independence,
    test_latency_offset_is_independently_derivable,
    test_suite_detects_injected_bugs,
)


if __name__ == "__main__":
    torch.set_num_threads(min(8, torch.get_num_threads()))
    failures = 0
    for test in TESTS:
        print(f"\n=== {test.__name__} ===")
        print(f"    {(test.__doc__ or '').strip().splitlines()[0]}")
        try:
            test()
        except AssertionError as error:
            failures += 1
            print(f"  [FAIL] {error}")
        except Exception as error:  # noqa: BLE0001
            failures += 1
            print(f"  [ERROR] {type(error).__name__}: {error}")
        else:
            print("  [PASS]")

    print("\n=== 真模型冒烟 ===")
    failures += main_real_model()

    print(f"\n{'全部通过' if not failures else f'{failures} 项未通过'}"
          f"（{len(TESTS)} 条判据）")
    sys.exit(1 if failures else 0)
