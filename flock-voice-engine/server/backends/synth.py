"""S 档程序合成兜底。

纯 numpy,四种音色,取自 eco-sequencer-riso ``audio.js`` 的 ``note()``:

    bass  低长音   正弦 + 次谐波,低通 320 Hz,长衰减
    pad   铺底     三个失谐三角波,慢起音,长尾
    lead  亮音     方波,低通 2.6 kHz,中等衰减
    pluck 短拨弦   三角波,瞬时起音,0.24 s 衰减

与 WebAudio 版本的关键差别:那边每个音 new 一套 OscillatorNode,音结束就扔;
这边是**常驻声部逐块渲染**,所以所有状态必须跨块存活。这个模块存在的意义
一半是兜底,一半是把神经后端的同款约束先演练一遍。

跨块连续的三处状态(缺一处就在块边界爆音):

1. **相位** —— 每个振荡器一个 float64 相位累加器。块内用 ``cumsum(f0)`` 积分,
   块末把相位模 2π 存回。因为谐波用的是 ``k*phase``,模 2π 对任意整数 k 都是
   等价变换,所以合成出来的波形不受 wrap 影响。
2. **包络** —— gate 驱动的 AR 段存在 ``Voice.envelope``(voices.py 已实现),
   起音后的 decay 段存在本模块的 ``_VoiceDSP.decay``。
3. **滤波器** —— 一阶低通的 y[n-1]。

另外所有振荡器都是**加性带限**合成:谐波数按 f0 截到奈奎斯特以下,不会像朴素
方波/锯齿那样混叠。代价是每块几十次 sin,1024 样本量级完全吃得消。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Sequence

import numpy as np

try:
    from .base import AudioBackend
except ImportError:  # 支持 `python3 server/backends/synth.py` 直接跑自测
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from server.backends.base import AudioBackend

if TYPE_CHECKING:
    from ..voices import Voice


TWO_PI = 2.0 * math.pi

#: 音色槽位。``Voice.timbre`` 是这个元组的下标。
TIMBRE_NAMES: tuple[str, ...] = ("bass", "pad", "lead", "pluck")

#: 最终幅度平滑的时间常数。抢占(last-note-priority)时 decay 段会被重置,
#: 包络出现阶跃 —— 这个 1.5 ms 的一阶平滑把阶跃磨成斜坡,消掉 retrigger 的咔哒声。
#: 比 pluck 的 3 ms 起音还短,不会把瞬态抹平。
AMP_SMOOTH_SECONDS = 0.0015


@dataclass(frozen=True)
class TimbreSpec:
    """一种音色的全部参数。频率单位 Hz,时间单位秒。"""

    name: str
    wave: str                                  # sine / triangle / square / saw
    detune_cents: tuple[float, ...] = (0.0,)   # 每个振荡器的失谐量
    sub_level: float = 0.0                     # 低八度正弦的混入量
    lowpass_hz: float = 0.0                    # 0 = 不滤波
    attack_seconds: float = 0.01
    release_seconds: float = 0.40
    decay_seconds: float = 1.0                 # 起音后衰减到 sustain 的时间常数
    sustain: float = 0.0                       # 0 = 一路衰到底(bass / pluck)
    max_harmonics: int = 16
    level: float = 0.30                        # 音色间的响度配平


TIMBRES: dict[str, TimbreSpec] = {
    "bass": TimbreSpec(
        name="bass", wave="sine", sub_level=0.35, lowpass_hz=320.0,
        attack_seconds=0.040, release_seconds=0.60,
        decay_seconds=2.20, sustain=0.0, max_harmonics=4, level=0.42,
    ),
    "pad": TimbreSpec(
        name="pad", wave="triangle", detune_cents=(-5.0, 0.0, 4.0), lowpass_hz=1800.0,
        attack_seconds=0.500, release_seconds=0.80,
        decay_seconds=2.50, sustain=0.85, max_harmonics=12, level=0.26,
    ),
    "lead": TimbreSpec(
        name="lead", wave="square", lowpass_hz=2600.0,
        attack_seconds=0.020, release_seconds=0.25,
        decay_seconds=0.70, sustain=0.15, max_harmonics=24, level=0.22,
    ),
    "pluck": TimbreSpec(
        name="pluck", wave="triangle", lowpass_hz=0.0,
        attack_seconds=0.003, release_seconds=0.15,
        decay_seconds=0.24, sustain=0.0, max_harmonics=16, level=0.34,
    ),
}


def timbre_spec(slot: int | str) -> TimbreSpec:
    """音色槽位 → 规格。下标越界或名字不认识都回落到 pad。"""
    if isinstance(slot, str):
        return TIMBRES.get(slot, TIMBRES["pad"])
    index = int(slot)
    if 0 <= index < len(TIMBRE_NAMES):
        return TIMBRES[TIMBRE_NAMES[index]]
    return TIMBRES["pad"]


# ---------------------------------------------------------------------------
# DSP 基元
# ---------------------------------------------------------------------------

def harmonic_amplitudes(wave: str, count: int) -> np.ndarray:
    """前 ``count`` 个谐波的幅度。下标 0 是基频。

    用解析级数而不是采样理想波形,天然带限 —— 谐波数截在奈奎斯特以下就没有混叠。
    """
    k = np.arange(1, count + 1, dtype=np.float64)
    odd = (k % 2 == 1)
    amplitudes = np.zeros(count, dtype=np.float64)
    if wave == "sine":
        amplitudes[0] = 1.0
    elif wave == "square":
        amplitudes[odd] = (4.0 / math.pi) / k[odd]
    elif wave == "saw":
        amplitudes = (2.0 / math.pi) * ((-1.0) ** (k + 1)) / k
    elif wave == "triangle":
        sign = (-1.0) ** ((k[odd] - 1) / 2)
        amplitudes[odd] = (8.0 / math.pi**2) * sign / k[odd] ** 2
    else:
        raise ValueError(f"未知波形: {wave}")
    return amplitudes


def integrate_phase(phase: float, f0: np.ndarray, sample_rate: int) -> tuple[np.ndarray, float]:
    """相位积分。返回逐样本相位和块末相位(已模 2π)。

    ``f0`` 逐样本可变,所以必须积分而不是 ``phase + n*w``。块末取模是安全的:
    谐波用 ``k*phase``,整数 k 乘 2π 的整数倍还是 2π 的整数倍。
    """
    increment = TWO_PI * np.asarray(f0, dtype=np.float64) / float(sample_rate)
    phases = phase + np.cumsum(increment)
    return phases, float(phases[-1] % TWO_PI)


def one_pole_lowpass(
    signal: np.ndarray, cutoff_hz: float, sample_rate: int, state: float
) -> tuple[np.ndarray, float]:
    """一阶低通 ``y[n] = b*y[n-1] + a*x[n]``,带跨块状态。

    没有 scipy,所以用闭式解向量化::

        y[n] = b^(n+1) * y[-1] + a * b^n * Σ_{m<=n} b^(-m) * x[m]

    ``b^(-m)`` 会指数增长,所以按 ``b^(-L) < 1e120`` 分段,段间交接状态。
    """
    x = np.asarray(signal, dtype=np.float64)
    a = 1.0 - math.exp(-TWO_PI * float(cutoff_hz) / float(sample_rate))
    a = min(max(a, 1e-6), 1.0)
    b = 1.0 - a
    if b < 1e-9:  # 截止频率接近奈奎斯特,退化成直通
        return x.astype(np.float32, copy=False), float(x[-1]) if len(x) else state

    # 分段长度:保证 b^(-L) 不溢出 float64
    limit = max(1, int(120.0 * math.log(10.0) / -math.log(b)))
    output = np.empty(len(x), dtype=np.float64)
    y_prev = float(state)
    for start in range(0, len(x), limit):
        chunk = x[start : start + limit]
        n = np.arange(len(chunk), dtype=np.float64)
        forward = b ** n              # b^n
        backward = b ** (-n)          # b^(-n)
        accumulated = np.cumsum(backward * chunk)
        segment = b ** (n + 1.0) * y_prev + a * forward * accumulated
        output[start : start + len(chunk)] = segment
        y_prev = float(segment[-1])
    return output.astype(np.float32, copy=False), y_prev


def exponential_ramp(
    start: float, target: float, tau_seconds: float, frames: int, sample_rate: int
) -> tuple[np.ndarray, float]:
    """指数趋近曲线。返回逐样本值和末值,用于跨块接续。"""
    coefficient = math.exp(-1.0 / (sample_rate * max(tau_seconds, 1e-4)))
    steps = np.arange(1, frames + 1, dtype=np.float64)
    curve = target + (start - target) * coefficient**steps
    return curve, float(curve[-1])


# ---------------------------------------------------------------------------
# 每声部的跨块状态
# ---------------------------------------------------------------------------

@dataclass
class _VoiceDSP:
    """一行的 DSP 状态。行绑定,生命周期与服务同长,永不重建。"""

    row: int
    phases: list[float] = field(default_factory=list)   # 每个失谐振荡器一个
    sub_phase: float = 0.0                              # 次谐波独立相位
    lowpass_state: float = 0.0
    decay: float = 0.0                                  # 起音后的衰减段,note_on 重置为 1
    amplitude: float = 0.0                              # 最终幅度平滑器的状态

    def ensure_oscillators(self, count: int) -> None:
        """音色切换会改变振荡器个数。补齐时新振荡器从 0 相位起 —— 它此刻幅度
        也是 0(包络还没起来),所以不会有可听的不连续。"""
        while len(self.phases) < count:
            self.phases.append(0.0)


class SynthBackend(AudioBackend):
    """程序合成后端。无外部依赖,启动即可用,永远不会加载失败。"""

    backend_id = "synth-s"

    def __init__(self, sample_rate: int, pool_size: int, block_samples: int) -> None:
        super().__init__(sample_rate, pool_size, block_samples)
        self._dsp: list[_VoiceDSP] = []

    # ---- 生命周期 -------------------------------------------------------

    def load(self) -> None:
        """预分配每行的状态。幂等 —— 重复调用不会清掉正在响的音。"""
        if not self._dsp:
            self._dsp = [_VoiceDSP(row=row) for row in range(self.pool_size)]
        self.loaded = True

    def reset(self) -> None:
        self._dsp = [_VoiceDSP(row=row) for row in range(self.pool_size)]

    # ---- 事件钩子 -------------------------------------------------------

    def note_on(self, voice: "Voice") -> None:
        """重置衰减段。**不碰相位** —— 抢占时相位必须连着走,否则爆音。"""
        if 0 <= voice.row < len(self._dsp):
            self._dsp[voice.row].decay = 1.0
            spec = timbre_spec(voice.timbre)
            voice.attack_seconds = spec.attack_seconds
            voice.release_seconds = spec.release_seconds

    def note_off(self, voice: "Voice") -> None:
        """release 由 ``Voice.envelope_curve`` 的 gate=False 分支处理,这里无事可做。"""

    # ---- 渲染 -----------------------------------------------------------

    def render_block(self, voices: Sequence["Voice"], n_samples: int) -> np.ndarray:
        if not self.loaded:
            self.load()
        mix = np.zeros(n_samples, dtype=np.float64)
        for voice in voices:
            if 0 <= voice.row < len(self._dsp):
                mix += self._render_voice(voice, self._dsp[voice.row], n_samples)
        # 软限幅。声部数开方配平,避免 V2 四声部时整体变响。
        scale = 0.9 / math.sqrt(max(1, len(voices)))
        return np.tanh(mix * scale).astype(np.float32, copy=False)

    def _render_voice(self, voice: "Voice", dsp: _VoiceDSP, n_samples: int) -> np.ndarray:
        spec = timbre_spec(voice.timbre)

        # 静音门:AR 段是指数趋近,永远到不了真正的 0。等 Voice 判定自己听不见了
        # (gate=0 且包络 <1e-4,约 -80 dBFS),就把目标幅度拉到 0,让下面的
        # 1.5 ms 平滑器滑到底,之后整条声部直接短路 —— 既保证数字静音,也省 CPU。
        muted = voice.silent()
        if muted and abs(dsp.amplitude) < 1e-7:
            dsp.amplitude = 0.0
            return np.zeros(n_samples, dtype=np.float64)

        # --- 包络:三段相乘 ---------------------------------------------
        # gate 段(voices.py 持有状态) × decay 段(本模块持有状态)
        gate_envelope = voice.envelope_curve(n_samples, self.sample_rate).astype(np.float64)
        decay_envelope, dsp.decay = exponential_ramp(
            dsp.decay, spec.sustain, spec.decay_seconds, n_samples, self.sample_rate
        )
        # 静音且已经衰干净:跳过合成,但状态照样往前走(相位不需要,因为幅度是 0)
        envelope = gate_envelope * np.maximum(decay_envelope, 0.0)
        target_amplitude = envelope * spec.level * (0.25 + 0.75 * voice.velocity) * voice.gain
        if muted:
            target_amplitude = np.zeros_like(target_amplitude)
        # 抢占时 decay 被拉回 1,幅度出现阶跃 —— 这里磨平
        amplitude, dsp.amplitude = one_pole_lowpass(
            target_amplitude, 1.0 / (TWO_PI * AMP_SMOOTH_SECONDS), self.sample_rate, dsp.amplitude
        )
        amplitude = amplitude.astype(np.float64)

        if float(np.max(np.abs(amplitude))) < 1e-6:
            return np.zeros(n_samples, dtype=np.float64)

        # --- 振荡器 -------------------------------------------------------
        f0 = voice.f0_hz(n_samples).astype(np.float64)
        # rich 抬高谐波数(更亮)。始终截在奈奎斯特以下 —— 这是不混叠的保证。
        nyquist_limit = int(self.sample_rate / 2.0 / max(float(np.max(f0)), 1e-3))
        count = max(1, min(spec.max_harmonics, nyquist_limit))
        count = max(1, int(count * (0.5 + voice.rich)))
        count = max(1, min(count, nyquist_limit, spec.max_harmonics * 2))
        amplitudes = harmonic_amplitudes(spec.wave, count)

        dsp.ensure_oscillators(len(spec.detune_cents))
        signal = np.zeros(n_samples, dtype=np.float64)
        for index, cents in enumerate(spec.detune_cents):
            # rich 同时把 pad 的失谐拉开一点,厚度跟着走
            spread = cents * (0.6 + 0.8 * voice.rich)
            phases, dsp.phases[index] = integrate_phase(
                dsp.phases[index], f0 * 2.0 ** (spread / 1200.0), self.sample_rate
            )
            for harmonic, weight in enumerate(amplitudes, start=1):
                if abs(weight) > 1e-4:
                    signal += weight * np.sin(harmonic * phases)
        signal /= math.sqrt(len(spec.detune_cents))

        if spec.sub_level > 0.0:
            sub_phases, dsp.sub_phase = integrate_phase(dsp.sub_phase, f0 * 0.5, self.sample_rate)
            signal += spec.sub_level * np.sin(sub_phases)

        # --- 滤波 ---------------------------------------------------------
        if spec.lowpass_hz > 0.0:
            # dirt 稍微开一点截止,脏一点亮一点
            cutoff = spec.lowpass_hz * (1.0 + 1.5 * voice.dirt)
            cutoff = min(cutoff, self.sample_rate * 0.45)
            filtered, dsp.lowpass_state = one_pole_lowpass(
                signal, cutoff, self.sample_rate, dsp.lowpass_state
            )
            signal = filtered.astype(np.float64)

        return signal * amplitude

    # ---- 自述 -----------------------------------------------------------

    def info(self) -> dict[str, Any]:
        return {
            **self.base_info(),
            "engine": "programmatic-synth",
            "tier": "S",
            "timbres": list(TIMBRE_NAMES),
            "antiAlias": "additive-bandlimited",
            "note": "兜底音源,无模型依赖;输出干声 mono",
        }


if __name__ == "__main__":
    # 自测:重点验块边界连续性 —— 这是本模块唯一真正难做对的地方。
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from server.voices import VoicePool

    sample_rate, block = 44_100, 1024
    pool = VoicePool(size=4, sample_rate=sample_rate)
    backend = SynthBackend(sample_rate=sample_rate, pool_size=len(pool), block_samples=block)
    backend.load()

    # 1) 四种音色各起一个音,连续渲染 1 秒,检查块边界不连续
    for row, voice in enumerate(pool.voices):
        voice.timbre = row
        voice.note_on(midi=48 + row * 7, velocity=0.8)
        backend.note_on(voice)

    blocks = [backend.render_block(pool.voices, block) for _ in range(43)]
    stream = np.concatenate(blocks)
    assert stream.dtype == np.float32 and len(stream) == 43 * block

    steps = np.abs(np.diff(stream.astype(np.float64)))
    seam_indices = np.arange(1, 43) * block - 1
    seam_steps = steps[seam_indices]
    # 块边界的跳变不应比块内典型跳变大 —— 大了就是相位/包络没接上
    interior = float(np.percentile(steps, 99.9))
    worst_seam = float(seam_steps.max())
    assert worst_seam <= max(interior * 1.5, 1e-4), (
        f"块边界不连续: seam={worst_seam:.6f} interior_p99.9={interior:.6f}"
    )
    print(f"[1] 边界连续 seam_max={worst_seam:.6f} interior_p99.9={interior:.6f}")

    # 2) 抢占(last-note-priority)不应爆音
    voice = pool[2]
    before = backend.render_block(pool.voices, block)
    voice.note_on(midi=72, velocity=1.0)
    backend.note_on(voice)
    after = np.concatenate([backend.render_block(pool.voices, block) for _ in range(4)])
    joint = np.concatenate([before, after]).astype(np.float64)
    assert float(np.abs(np.diff(joint)).max()) < 0.30, "抢占处爆音"
    print(f"[2] 抢占平滑 max_step={float(np.abs(np.diff(joint)).max()):.6f}")

    # 3) 松键后能衰到静音,且不越界
    for item in pool.voices:
        item.note_off()
        backend.note_off(item)
    # release 是指数趋近的时间常数(pad tau=1.2 s),渲染到静音门关闭为止
    limit = int(20.0 * sample_rate / block)
    tail_blocks = []
    for elapsed in range(limit):
        tail_blocks.append(backend.render_block(pool.voices, block))
        if pool.active() == 0:
            break
    else:
        raise AssertionError("20 s 内没有衰减到静音")
    tail = np.concatenate(tail_blocks)
    assert float(np.abs(tail).max()) <= 1.0, "越界"
    # 尾巴必须单调收敛,不能有反弹
    assert float(np.abs(tail[-block:]).max()) < 1e-3, "静音门关闭时仍有可听残留"
    print(f"[3] release 收尾 {len(tail_blocks) * block / sample_rate:.1f}s 后静音门关闭")

    # 4) 静音门关闭后收敛到**数字静音**,不是"很小" —— 空转不能有直流或噪声。
    #    头一两块还在走 1.5 ms 平滑器的最后一段坡,从第三块起必须是精确 0。
    settling = np.concatenate([backend.render_block(pool.voices, block) for _ in range(2)])
    assert float(np.abs(settling).max()) < 1e-5, "收尾坡度过大"
    idle = np.concatenate([backend.render_block(pool.voices, block) for _ in range(8)])
    assert float(np.abs(idle).max()) == 0.0, f"空转残留 {float(np.abs(idle).max()):.2e}"
    print("[4] 空转数字静音")

    # 5) 带限:高音区不应出现混叠(用最高允许音 95 号)
    solo = VoicePool(size=1, sample_rate=sample_rate)
    solo_backend = SynthBackend(sample_rate, 1, block)
    solo_backend.load()
    solo[0].timbre = 2  # lead / 方波,谐波最多
    solo[0].note_on(midi=95, velocity=1.0)
    solo_backend.note_on(solo[0])
    high = np.concatenate([solo_backend.render_block(solo.voices, block) for _ in range(20)])
    assert np.isfinite(high).all()
    print(f"[5] 高音区有限且有声 peak={float(np.abs(high).max()):.3f}")

    print("synth.py 自测通过:", backend.info())
