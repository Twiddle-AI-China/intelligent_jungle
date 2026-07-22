"""midiBrave 流式（逐块）推理。

上游仓库**没有** cached_conv / RAVE 运行时（IMPLEMENTATION.md 明确写了
"The decoder remains self-contained to avoid the incompatible RAVE runtime
dependency set"），所以这一层是自己实现的。

## 为什么这个模型可以流式

逐模块因果性审计（详见 docs/model-notes.md）：

| 模块 | 时间依赖 | 流式处理 |
|------|----------|----------|
| `fusion` (静态快路径) | 与时间无关，逐音恒定 | 每音算一次，按块 expand |
| `midi.tcn` (静态快路径) | 长度 1 序列，恒定 | 每音算一次 |
| `FiLM` (z_midi, static) | 常数 gamma/beta | 无状态 |
| `excitation_film` | Conv1d k=1，逐点 | 无状态 |
| `F.interpolate(nearest, r)` | 整数倍、块对齐 | 无状态 |
| `FixedAntiAlias` | 左 pad 30 (replicate) | 缓存左 30 |
| `projections` CausalConv1d k=3 | 左 pad 2 | 缓存左 2 |
| `ResidualBlock.conv1` k=3, d∈{1,3,9} | 左 pad 2/6/18 | 缓存左 2/6/18 |
| `ResidualBlock.conv2` k=1 | 逐点 | 无状态 |
| `output` CausalConv1d k=7 | 左 pad 6 | 缓存左 6 |
| `ExcitationDownsample` stride=r, k=2r | 左 pad 2r-1 (replicate) | 缓存左 2r-1 |
| `PQMF.synthesis` conv_transpose stride=16, 257 taps | 右溢出 241 样本 | overlap-add 尾缓冲 |
| `HarmonicExcitation` | 绝对时间相位 | 记录绝对样本偏移 |
| `PQMF.analysis`(激励) | 两侧各 128（非因果） | 激励可解析生成，多算 128 前瞻即可 |

整条链**全部因果**，唯一的非因果点在激励的 PQMF 分析上，而激励由
(note, 绝对时间) 解析决定，可以任意提前生成 —— 不构成流式障碍。

## 两个必须踩准的坑

1. **激励 RMS 归一化必须用固定标量。** `HarmonicExcitation.forward` 是按
   当前生成长度算 RMS 的；逐块各算各的会让每块增益不同 → 块边界爆音。
   这里统一复用 backend 按训练规范长度算出的 `excitation_scale`。
2. **note 频率必须用 float32 的 torch.pow 算**（见 backend 注释），
   否则相位随时间累积偏差，流式与离线对不上。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import torch
import torch.nn.functional as F
from torch import Tensor

from .midibrave_backend import MidiBraveBackend


def _causal_conv_stream(
    conv: torch.nn.Conv1d,
    x: Tensor,
    cache: Tensor | None,
    pad_mode: str,
) -> tuple[Tensor, Tensor | None]:
    """带左侧缓存的因果卷积。cache=None 表示这是本音的第一块。"""
    pad = conv.dilation[0] * (conv.kernel_size[0] - 1)
    if pad == 0:
        return conv(x), None
    if cache is None:
        if pad_mode == "replicate":
            left = x[..., :1].expand(-1, -1, pad)
        else:
            left = x.new_zeros(x.shape[0], x.shape[1], pad)
    else:
        left = cache
    padded = torch.cat((left, x), dim=-1)
    new_cache = padded[..., -pad:].contiguous()
    out = F.conv1d(
        padded, conv.weight, conv.bias,
        stride=conv.stride, dilation=conv.dilation, groups=conv.groups,
    )
    return out, new_cache


def _anti_alias_stream(
    module, x: Tensor, cache: Tensor | None
) -> tuple[Tensor, Tensor | None]:
    """FixedAntiAlias 的流式版本（左 pad replicate，taps-1 个样本）。"""
    pad = module.pad
    weight = module.kernel.expand(x.shape[1], 1, -1)
    left = x[..., :1].expand(-1, -1, pad) if cache is None else cache
    padded = torch.cat((left, x), dim=-1)
    new_cache = padded[..., -pad:].contiguous()
    return F.conv1d(padded, weight, groups=x.shape[1]), new_cache


@dataclass
class _VoiceState:
    """一个声部的全部跨块状态。"""

    note: int
    velocity: int
    # MIDI 分支逐音恒定（note/velocity 在一个音内不变），融合按帧现算
    midi_frame: Tensor = field(repr=False, default=None)     # [1, 32, 1]
    # 音色漫游：当前点与目标点，都是 [1, 128, 1]
    z_current: Tensor = field(repr=False, default=None)
    z_target: Tensor = field(repr=False, default=None)
    # 时间游标
    sample_pos: int = 0
    frame_pos: int = 0
    # 各级缓存
    anti_alias_cache: list = field(default_factory=list, repr=False)
    projection_cache: list = field(default_factory=list, repr=False)
    block_cache: list = field(default_factory=list, repr=False)
    excitation_ds_cache: list = field(default_factory=list, repr=False)
    output_cache: Tensor | None = field(default=None, repr=False)
    ola_tail: Tensor | None = field(default=None, repr=False)


class StreamingVoice:
    """单声部流式渲染器。

    用法::

        voice = StreamingVoice(backend)
        voice.note_on(z_timbre, note=60, velocity=127)
        while True:
            block = voice.render_block(1024)   # -> float32 [1024]
    """

    #: z_timbre 每秒允许移动的 L2 距离上限（音色漫游限速）。
    #: z_timbre 是 Tanh 输出，128 维，整体落在 [-1,1]^128 内，
    #: 实测两个不相干 preset 之间的 L2 距离约 8–16，所以 1.0/s 量级
    #: 意味着跨越整个音色空间需要十几秒。**具体上限待 z_timbre agent 实测标定**，
    #: 这里先给一个保守默认值并做成可配。
    DEFAULT_TIMBRE_RATE = 1.0

    def __init__(
        self,
        backend: MidiBraveBackend,
        timbre_rate_per_second: float | None = None,
    ) -> None:
        self.backend = backend
        self.model = backend.model
        self.decoder = backend.model.decoder
        self.geometry = backend.geometry
        self.state: _VoiceState | None = None
        self.timbre_rate_per_second = (
            self.DEFAULT_TIMBRE_RATE if timbre_rate_per_second is None
            else float(timbre_rate_per_second)
        )

    # -- 生命周期 ---------------------------------------------------------
    @torch.no_grad()
    def note_on(
        self,
        z_timbre: Tensor,
        note: int,
        velocity: int,
        run_warmup: bool = True,
    ) -> None:
        """开始一个新音。会重置全部跨块状态。

        run_warmup=True 时先跑掉 warmup_latent_frames(64) 帧并丢弃输出，
        与离线 decode() 的语义完全一致。64 帧 > 解码器感受野 55 帧，
        所以暖机之后逐块流式与离线一次性渲染在数值上等价。
        """
        note = int(note)
        velocity = int(velocity)
        geom = self.geometry
        n_stages = len(self.decoder.ratios)

        midi_frame = self.backend.make_z_midi(note, velocity, 1)
        z_frame = self.backend.make_z_timbre_frames(z_timbre, 1).clone()

        self.state = _VoiceState(
            note=note,
            velocity=velocity,
            midi_frame=midi_frame,
            z_current=z_frame,
            z_target=z_frame.clone(),
            anti_alias_cache=[None] * n_stages,
            projection_cache=[None] * n_stages,
            block_cache=[[None] * len(blocks) for blocks in self.decoder.blocks],
            excitation_ds_cache=[None] * len(self.decoder.excitation_downsamplers),
        )

        if run_warmup:
            # 要丢弃的样本数 = warmup 帧 + PQMF 合成的全局 128 样本偏移。
            #
            # 离线路径是 tanh(16 * wide[128 : 128+total])，再取 [warmup*128 : ...]，
            # 也就是从 wide 的第 (warmup*128 + 128) 个样本开始才是正式输出。
            # 流式的 emit 流就是 wide 本身，所以必须多丢 128 个样本。
            # 128 恰好是一个 latent frame，丢弃长度仍是 128 的整数倍。
            warm = (geom.warmup_latent_frames + 1) * geom.samples_per_latent
            self._render_samples(warm, discard=True)

    def note_off(self) -> None:
        """本模型没有 release 分支（IMPLEMENTATION.md: host owns the performance
        envelope），所以 note_off 只是丢弃状态；包络由前端总线负责。"""
        self.state = None

    # -- 音色漫游 ---------------------------------------------------------
    def set_timbre_target(self, z_timbre: Tensor) -> None:
        """设定音色漫游目标点。实际移动受 timbre_rate_per_second 限速。"""
        if self.state is None:
            raise RuntimeError("先调用 note_on()")
        self.state.z_target = self.backend.make_z_timbre_frames(z_timbre, 1).clone()

    def _timbre_trajectory(self, frames: int) -> Tensor:
        """生成本块逐 latent frame 的 z_timbre 轨迹 [1, 128, frames]。

        限速：每帧朝目标移动的 L2 距离不超过 rate/latent_rate。方向保持不变，
        只截断步长 —— 与 Latent-Cosmos 基线的 ``limited_step`` 思路一致。
        不限速的话，音色跳变会在块边界产生可闻的撕裂声。
        """
        state = self.state
        current = state.z_current
        target = state.z_target
        max_step = self.timbre_rate_per_second / self.geometry.latent_rate_hz

        delta = target - current
        distance = float(torch.linalg.vector_norm(delta))
        if distance <= 1e-9 or max_step <= 0.0:
            state.z_current = current
            return current.expand(-1, -1, frames)

        # 本块最多走 frames 步；若能在块内走到目标，则走到后保持不动。
        steps_needed = distance / max_step
        direction = delta / distance
        ramp = torch.arange(
            1, frames + 1, device=current.device, dtype=current.dtype
        ).clamp(max=steps_needed) * max_step
        traj = current + direction * ramp.view(1, 1, frames)
        traj = traj.clamp(-1.0, 1.0)   # z_timbre 是 Tanh 输出，越界即分布外
        state.z_current = traj[..., -1:].contiguous()
        return traj

    # -- 渲染 -------------------------------------------------------------
    @torch.no_grad()
    def render_block_tensor(self, samples: int) -> Tensor:
        """跟 render_block 一样，但不做 .cpu().numpy()——留在 GPU tensor 上。

        给跨行 CUDA stream 并行用（见 brave_voices.py 的 render_split）：
        每行的前向发到自己的 stream 上，全部发完才统一 synchronize + 转
        numpy，这样才有机会真的并发，而不是每行发完就等它拷回 CPU
        （.cpu() 本身就是一次同步点，逐行调用等于逐行强制串行）。
        """
        return self._render_samples(samples, discard=False)

    @torch.no_grad()
    def render_block(self, samples: int) -> np.ndarray:
        """渲染 `samples` 个样本（必须是 samples_per_latent=128 的整数倍）。"""
        out = self.render_block_tensor(samples)
        return out.squeeze(0).squeeze(0).cpu().numpy().astype(np.float32)

    def _render_samples(self, samples: int, discard: bool) -> Tensor | None:
        geom = self.geometry
        state = self.state
        if state is None:
            raise RuntimeError("先调用 note_on()")
        if samples % geom.samples_per_latent:
            raise ValueError(
                f"块长必须是 {geom.samples_per_latent} 的整数倍，收到 {samples}"
            )
        frames = samples // geom.samples_per_latent

        # 1) 激励：按绝对样本位置生成，保证相位跨块连续
        bands = self.backend.excitation_bands(
            state.note, state.sample_pos, samples
        )

        # 2) 激励金字塔（因果 stride 卷积，带缓存）
        levels = [bands]
        current = bands
        for index, downsampler in enumerate(self.decoder.excitation_downsamplers):
            if isinstance(downsampler, torch.nn.Identity):
                current = downsampler(current)
            else:
                current, state.excitation_ds_cache[index] = _causal_conv_stream(
                    downsampler, current, state.excitation_ds_cache[index],
                    downsampler.causal_pad_mode,
                )
            levels.insert(0, current)

        # 3) 融合：**逐帧**吃 z_timbre，支持音色漫游
        #
        # 注意这里必须走 static_condition=False。训练时 z_timbre 每条音频恒定，
        # 所以开了 static_condition_fast_path 只取 z_timbre[..., :1] 再 expand；
        # 漫游要求逐帧生效，走静态快路径的话除第 0 帧外全被丢掉。
        # 权重完全相同，静态路径只是恒定条件下的等价加速，关掉不影响数值正确性。
        z_traj = self._timbre_trajectory(frames)
        midi_level = state.midi_frame
        x = self.decoder.fusion(
            z_traj, midi_level.expand(-1, -1, frames), static_condition=False
        )

        for stage, (ratio, blocks, anti_alias, projection, excitation_level) in enumerate(
            zip(self.decoder.ratios, self.decoder.blocks, self.decoder.anti_alias,
                self.decoder.projections, levels)
        ):
            if ratio > 1:
                x = F.interpolate(x, scale_factor=ratio, mode="nearest")
                x, state.anti_alias_cache[stage] = _anti_alias_stream(
                    anti_alias, x, state.anti_alias_cache[stage]
                )
            x, state.projection_cache[stage] = _causal_conv_stream(
                projection, x, state.projection_cache[stage], projection.causal_pad_mode
            )
            x = F.silu(x)
            excitation_level = excitation_level.to(dtype=x.dtype)
            for bindex, block in enumerate(blocks):
                # v2 的 ResidualBlock.forward 在 conv1 前后各插了一次
                # ChannelRMSNorm（norm1/norm2）；v1 checkpoint 的 block 没有
                # 这两个属性（state_dict 里也不会有对应键——ChannelRMSNorm
                # 无可学习参数，纯逐帧归一化，两版本 key 集合看起来"相同"正是
                # 这个坑的来源）。用 getattr 兜底两边都能跑：v1 没有就跳过，
                # 语义与之前完全一致；v2 有就必须应用，否则输出与离线严重不一致
                # （已实测：关掉这两个 norm，流式与离线 render_note() 的
                # 逐样本误差从 ~1e-7 量级炸到 0.2+，不是可以忽略的近似）。
                # ChannelRMSNorm 只在 channel 维（dim=1）上逐帧归一化，
                # 不跨时间步依赖，分块调用与整段调用等价，无需额外跨块状态。
                norm1 = getattr(block, "norm1", None)
                conv1_input = norm1(x) if norm1 is not None else x
                y, state.block_cache[stage][bindex] = _causal_conv_stream(
                    block.conv1, conv1_input, state.block_cache[stage][bindex],
                    block.conv1.causal_pad_mode,
                )
                y = F.silu(y)
                norm2 = getattr(block, "norm2", None)
                if norm2 is not None:
                    y = norm2(y)
                y = block.film(block.conv2(y), midi_level, static_condition=True)
                y = block.excitation_film(y, excitation_level)
                x = (x + y) * (2.0**-0.5)

        # 4) 输出卷积 → PQMF 子带
        subbands, state.output_cache = _causal_conv_stream(
            self.decoder.output, x, state.output_cache,
            self.decoder.output.causal_pad_mode,
        )

        # 5) PQMF 综合：conv_transpose 的右溢出用 overlap-add 接到下一块
        pqmf = self.decoder.pqmf
        wide = F.conv_transpose1d(subbands, pqmf.synthesis_weight, stride=pqmf.bands)
        if state.ola_tail is not None:
            wide = wide.clone()
            tail_len = state.ola_tail.shape[-1]
            wide[..., :tail_len] += state.ola_tail
        emit = wide[..., :samples]
        state.ola_tail = wide[..., samples:].contiguous()

        state.sample_pos += samples
        state.frame_pos += frames

        if discard:
            return None
        return torch.tanh(emit * pqmf.bands)


@torch.no_grad()
def render_streaming(
    backend: MidiBraveBackend,
    z_timbre: Tensor,
    note: int,
    velocity: int,
    duration_seconds: float,
    block_samples: int = 1024,
) -> np.ndarray:
    """逐块流式渲染整段，用于与离线渲染做等价性比对。"""
    voice = StreamingVoice(backend)
    voice.note_on(z_timbre, note, velocity)
    wanted = int(round(duration_seconds * backend.geometry.sample_rate))
    chunks: list[np.ndarray] = []
    produced = 0
    while produced < wanted:
        block = voice.render_block(block_samples)
        chunks.append(block)
        produced += len(block)
    return np.concatenate(chunks)[:wanted]


if __name__ == "__main__":
    import time

    torch.set_num_threads(min(20, torch.get_num_threads()))
    backend = MidiBraveBackend()
    z = backend.timbre_from_clap(torch.randn(1, 512))

    # 1) 固定 z_timbre：逐块流式 vs 一次性离线，逐样本比较
    offline = backend.render_note(z, 60, 127, 2.0)
    stream = render_streaming(backend, z, 60, 127, 2.0, block_samples=1024)
    n = min(len(offline), len(stream))
    diff = np.abs(offline[:n] - stream[:n])
    print(f"offline {offline.shape} stream {stream.shape}")
    print(f"[固定音色] 流式 vs 离线 max abs diff = {diff.max():.3e} "
          f"(peak {np.abs(offline).max():.4f})")

    # 2) 不同块长应给出同一条流（块长不能影响结果）
    for block in (128, 512, 4096):
        alt = render_streaming(backend, z, 60, 127, 2.0, block_samples=block)
        m = min(len(offline), len(alt))
        print(f"[块长 {block:5d}] vs 离线 max abs diff = "
              f"{np.abs(offline[:m]-alt[:m]).max():.3e}")

    # 3) 音色漫游：z_timbre 逐帧移动这条路径也要跑通并保持有界
    z2 = backend.timbre_from_clap(torch.randn(1, 512))
    voice = StreamingVoice(backend, timbre_rate_per_second=2.0)
    voice.note_on(z, 60, 127)
    voice.set_timbre_target(z2)
    roam = np.concatenate([voice.render_block(1024) for _ in range(80)])
    reached = float(torch.linalg.vector_norm(voice.state.z_current - voice.state.z_target))
    print(f"[漫游] {roam.shape} peak {np.abs(roam).max():.4f} "
          f"有限值 {np.isfinite(roam).all()} 距目标残差 {reached:.4f}")
    # 块边界不应有台阶：最大逐样本跳变应与块内相当
    jumps = np.abs(np.diff(roam))
    edges = jumps[1023::1024]
    print(f"[漫游] 块边界最大跳变 {edges.max():.5f} / 全局最大 {jumps.max():.5f} "
          f"→ {'无台阶' if edges.max() <= jumps.max() * 1.05 else '疑似台阶'}")

    voice = StreamingVoice(backend)
    voice.note_on(z, 60, 127)
    times = []
    for _ in range(200):
        start = time.perf_counter()
        voice.render_block(1024)
        times.append((time.perf_counter() - start) * 1000.0)
    times = np.array(times)
    budget = 1024 / 44100 * 1000
    print(f"块推理 p50 {np.percentile(times,50):.2f} ms  "
          f"p95 {np.percentile(times,95):.2f} ms  预算 {budget:.2f} ms")
