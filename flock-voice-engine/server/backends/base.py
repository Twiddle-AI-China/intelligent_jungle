"""音源后端抽象。

服务层只认这个接口,不知道背后是神经模型还是程序合成。两个后端:

- ``synth.SynthBackend``  —— S 档程序合成兜底,numpy 实现,无外部依赖。
- ``brave.BraveBackend``  —— B 档 midiBrave 神经音源(另一路 agent 负责)。

三条契约,两个后端都必须满足:

1. **干声、单声道。** ``render_block`` 返回 mono float32,幅度约定在 ±1 以内。
   master / 混响 / EQ / 昼夜宏都在前端,服务端一律不做(见 BRIEF.md 架构决定 3)。
2. **固定长度 voice 池。** 每次 ``render_block`` 传进来的 ``voices`` 长度恒定、
   顺序恒定,``voice.row`` 就是它在池子里的行号。后端可以按 row 预分配跨块状态,
   并且可以假定这个数组永远不会变长变短。
3. **跨块连续。** 相位、包络、滤波器状态都必须存活到下一块。块边界上不允许有
   不连续 —— 这是 S 档最重要的验收点,也是神经后端同款约束的演练。

``note_on`` / ``note_off`` 是可选钩子。程序合成用它重置 decay 段;神经后端用它
生成逐帧 MIDI 条件里的 ``onset_pulse`` / ``offset_pulse``。服务层无条件调用,
后端不需要就留空实现。

接新后端(给模型侧的对接说明)
------------------------------

服务层用 ``discover_backends()`` 扫描本包,自动收录所有 ``AudioBackend`` 子类,
按 ``backend_id`` 建表。**接进来只需要两件事**,服务层一行都不用改::

    class MidiBraveAudioBackend(AudioBackend):
        backend_id = "brave"          # ← `--backend brave` 就能选中

        def __init__(self, sample_rate, pool_size, block_samples, model_path=None):
            super().__init__(sample_rate, pool_size, block_samples)
            ...

构造签名必须吃 ``sample_rate`` / ``pool_size`` / ``block_samples`` 三个关键字参数;
``model_path`` 可选(命令行给了 ``--model-path`` 才会传)。签名不匹配、模块导入
失败(比如没装 torch)、名字没注册 —— 三种情况都会打一行 warn 然后回落到程序
合成兜底,不会让服务起不来。

模型本身的加载放在 ``load()`` 里,不要放在 ``__init__``:服务启动时会先造一个
实例探信息,每个 WS 连接再各造一个。``render_block`` 必须是**纯增量**的 ——
它只能看 ``voices`` 的当前状态加自己的跨块缓冲,不能回看历史块。
"""
from __future__ import annotations

import abc
from typing import TYPE_CHECKING, Any, Sequence

import numpy as np

if TYPE_CHECKING:  # 避免运行期循环导入
    from ..voices import Voice


class AudioBackend(abc.ABC):
    """音源后端。实现类必须是可重入的:一个实例服务一个 WS 会话。"""

    #: 后端标识,进 ``/api/decoder-status`` 的 models 列表
    backend_id: str = "base"

    def __init__(self, sample_rate: int, pool_size: int, block_samples: int) -> None:
        self.sample_rate = int(sample_rate)
        self.pool_size = int(pool_size)
        self.block_samples = int(block_samples)
        self.loaded: bool = False

    # ---- 生命周期 -------------------------------------------------------

    @abc.abstractmethod
    def load(self) -> None:
        """准备好一切耗时的东西(读权重、预分配缓冲)。必须幂等。

        服务启动时调用一次。调用后 ``self.loaded`` 应为 True。
        """

    def close(self) -> None:
        """释放资源。默认无操作。"""
        self.loaded = False

    # ---- 渲染 -----------------------------------------------------------

    @abc.abstractmethod
    def render_block(self, voices: Sequence["Voice"], n_samples: int) -> np.ndarray:
        """渲染一块干声。

        Args:
            voices: 固定长度的 voice 池,顺序即行号。**不要缓存这个序列本身**,
                但可以按 ``voice.row`` 缓存自己的状态。
            n_samples: 本块样本数。通常等于 ``self.block_samples``。

        Returns:
            形状 ``(n_samples,)`` 的 mono float32。所有声部已混好,未做任何
            master 处理。静音时返回全零而不是 None —— 池子是常驻的,
            流不能断。
        """

    def render_split(self, voices: Sequence["Voice"], n_samples: int) -> np.ndarray:
        """逐轨渲染,返回 ``(pool_size, n_samples)`` —— 不求和。

        分轨是为了让前端能做 per-voice EQ / 按声部的混响发送 / 频段占位
        (``protocol.md`` §7 的分工:服务端只出干声,声像混响 EQ 全在前端)。
        服务端一旦把四轨加成一路,这些就都做不了。

        默认实现是**降级兜底**:把混合结果放进第 0 轨,其余轨静音。
        只出干声、不分轨的后端(synth 兜底档、silent)照此即可;
        真正支持分轨的后端应该覆写它,并让 ``render_block`` 变成它的求和包装。
        """
        out = np.zeros((self.pool_size, n_samples), dtype=np.float32)
        out[0] = self.render_block(voices, n_samples)
        return out

    #: 覆写了 ``render_split`` 的后端把这个置 True,服务层据此决定是否宣告分轨能力。
    supports_split: bool = False

    # ---- 事件钩子(可选) -----------------------------------------------

    def note_on(self, voice: "Voice") -> None:
        """某个声部起音。此时 ``voice.midi`` / ``velocity`` / ``gate`` 已更新。"""

    def note_off(self, voice: "Voice") -> None:
        """某个声部松键,进入 release。"""

    def panic_voice(self, voice: "Voice") -> None:
        """立即丢弃一个声部的状态。

        正常松键应该走 ``note_off`` 保留尾音；模型切换需要硬静音，
        否则旧模型的 release 会和新模型同时占用推理预算。
        无状态后端默认退化为普通松键。
        """
        self.note_off(voice)

    def reset(self) -> None:
        """清空全部跨块状态。仅在会话重建时调用,运行期不要碰。"""

    # ---- 自述 -----------------------------------------------------------

    @abc.abstractmethod
    def info(self) -> dict[str, Any]:
        """给 ``/api/decoder-status`` 和 WS ``ready`` 帧用的自述。

        约定至少包含 ``id`` / ``engine`` / ``sampleRate`` / ``poolSize`` /
        ``blockSamples`` / ``loaded``,其余字段后端自便。
        """

    def base_info(self) -> dict[str, Any]:
        """公共字段。实现类的 ``info()`` 直接 ``{**self.base_info(), ...}``。"""
        return {
            "id": self.backend_id,
            "sampleRate": self.sample_rate,
            "poolSize": self.pool_size,
            "blockSamples": self.block_samples,
            "loaded": self.loaded,
        }


class SilentBackend(AudioBackend):
    """全零后端。神经后端还没就绪时占位,保证服务层能独立跑起来。"""

    backend_id = "silent"

    def load(self) -> None:
        self.loaded = True

    def render_block(self, voices: Sequence["Voice"], n_samples: int) -> np.ndarray:
        return np.zeros(n_samples, dtype=np.float32)

    def info(self) -> dict[str, Any]:
        return {**self.base_info(), "engine": "silent-placeholder"}


if __name__ == "__main__":
    # 自测:接口契约本身 —— 形状、dtype、静音流不断。
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from server.voices import VoicePool

    pool = VoicePool(size=4, sample_rate=44_100)
    backend = SilentBackend(sample_rate=44_100, pool_size=len(pool), block_samples=1024)
    backend.load()
    assert backend.loaded

    block = backend.render_block(pool.voices, 1024)
    assert block.shape == (1024,), block.shape
    assert block.dtype == np.float32, block.dtype

    # 钩子必须可无条件调用
    backend.note_on(pool[0])
    backend.note_off(pool[0])
    backend.reset()

    print("base.py 自测通过:", backend.info())
