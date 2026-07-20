"""固定长度 voice 池。

这个模块的形状由模型约束决定，不是随手写的:

解码的 batch 维就是声部维。神经后端跨块保持的状态(条件缓冲、上采样卷积的
padding、振荡/激励相位)都按 batch 尺寸分配,batch 尺寸一变就得重新分配并
清零 —— 结果是所有声部的状态同时被打断,听感上是一起爆一下。所以 voice 池
必须是**常驻固定长度的数组**,voice → 行的绑定永不变动;不发声的声部带
gate=0 继续跟着跑,而不是被移出池子。

程序合成后端(S 档)本身没有这个限制,但它照样遵守同一套约定 —— 它是神经
后端的演练,两者对服务层必须是可互换的。

V1 MVP 取长度 1,V2 取 4。除了这个数字以外没有区别。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


def midi_to_hz(midi: float) -> float:
    return 440.0 * 2.0 ** ((float(midi) - 69.0) / 12.0)


@dataclass
class Voice:
    """一个声部。同一时刻只有一个音 —— 复音在 pitch-only 路线上是 deferred 的。"""

    row: int                      # 在 decode batch 里的行号,绑定后永不变
    timbre: int = 0               # 音色槽位(S 档=波形编号;B 档=atlas 锚点索引)
    #: 二维音色地图坐标。给了它就**优先于 timbre 槽位** —— 槽位是地图上的
    #: 九个路标，XY 是任意位置，后者表达力更强。None = 不用 XY 直控。
    timbre_xy: tuple[float, float] | None = None
    #: XY 直控的 kNN 邻居数。k=1 是硬切到最近的 preset，k 大则把一片区域糊成
    #: 平均音色 —— 这是个有听感后果的参数，必须能从客户端调。
    timbre_k: int = 6
    #: 无约束 PCA 漫游的系数（前 N 个主成分）。给了它就**优先于 timbre_xy 与槽位** ——
    #: 这是显式的实验模式：去掉 kNN 约束层，只在主成分子空间里自由走。
    timbre_pca: tuple[float, ...] | None = None
    midi: float = 60.0
    velocity: float = 0.8
    gate: bool = False

    # 包络状态,跨块连续
    envelope: float = 0.0
    attack_seconds: float = 0.01
    release_seconds: float = 0.40

    # 振荡器相位,跨块连续。S 档自己用;B 档由模型内部的 buffer 持有。
    phase: float = 0.0

    # 映射层送来的连续参数(§4.1),全部 0–1
    gain: float = 0.8
    rich: float = 0.5
    room: float = 0.2
    dirt: float = 0.0

    # 失谐抖动的独立随机流,保证各声部的 dirt 不同步
    rng: np.random.Generator = field(default_factory=lambda: np.random.default_rng(0))

    def note_on(self, midi: float, velocity: float) -> None:
        """last-note-priority: 新音直接抢占,不等旧音释放。"""
        self.midi = float(midi)
        self.velocity = float(np.clip(velocity, 0.0, 1.0))
        self.gate = True

    def note_off(self) -> None:
        self.gate = False

    def f0_hz(self, frames: int) -> np.ndarray:
        """带 dirt 失谐的逐帧基频。dirt=0 时是恒定值。"""
        base = midi_to_hz(self.midi)
        if self.dirt <= 1e-4:
            return np.full(frames, base, dtype=np.float32)
        # 虫害 → 轻微失谐:最多 ±25 cents 的慢速游走
        cents = self.rng.normal(0.0, 1.0, frames).cumsum()
        cents = cents / max(abs(cents).max(), 1e-6) * 25.0 * self.dirt
        return (base * 2.0 ** (cents / 1200.0)).astype(np.float32)

    def envelope_curve(self, frames: int, sample_rate: int) -> np.ndarray:
        """逐样本 AR 包络,尾状态存回 self.envelope 以跨块连续。

        用闭式解而不是逐样本循环:一个块内 gate 不变,所以是纯指数趋近。
        """
        target = 1.0 if self.gate else 0.0
        seconds = self.attack_seconds if self.gate else self.release_seconds
        coefficient = float(np.exp(-1.0 / (sample_rate * max(seconds, 1e-4))))
        steps = np.arange(1, frames + 1, dtype=np.float32)
        decay = coefficient ** steps
        curve = target + (self.envelope - target) * decay
        self.envelope = float(curve[-1])
        return curve.astype(np.float32)

    def silent(self) -> bool:
        return not self.gate and self.envelope < 1e-4


class VoicePool:
    """固定长度、行绑定。size 是启动参数,运行期不变。"""

    def __init__(self, size: int, sample_rate: int, seed: int = 0x5EED) -> None:
        if size < 1:
            raise ValueError("voice pool size must be >= 1")
        self.sample_rate = sample_rate
        self.voices = [
            Voice(row=row, rng=np.random.default_rng(seed + row)) for row in range(size)
        ]

    def __len__(self) -> int:
        return len(self.voices)

    def __getitem__(self, row: int) -> Voice:
        return self.voices[row]

    def route(self, row: int) -> Voice | None:
        """把外部的声部号收敛到池内。越界丢弃而不是扩容 —— 扩容会重置全体相位。"""
        return self.voices[row] if 0 <= row < len(self.voices) else None

    def apply_params(self, row: int, params: dict) -> None:
        voice = self.route(row)
        if voice is None:
            return
        for key in ("gain", "rich", "room", "dirt"):
            if key in params:
                setattr(voice, key, float(np.clip(params[key], 0.0, 1.0)))

    def active(self) -> int:
        return sum(0 if voice.silent() else 1 for voice in self.voices)
