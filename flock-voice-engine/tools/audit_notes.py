"""midiBrave 验收器 —— 判定音源「是不是真的对」。

本项目最大的质量风险不是「不出声」,而是**出声了但错了**:条件张量拼错一维、
note embedding 查错行、velocity 走错档、FiLM 条件没对齐时间轴 —— 模型照样输出
一段听上去像乐器的波形,只是音高偏了、包络塌了、力度反了。裸耳在单音上很难当场
判断,所以要有一把尺。

这个模块就是那把尺。给一个 render 回调,批量渲染测试点,量四件事:

    音高准确度   跨音域网格实测 f0,cents 误差 median / p90 + 八度错误率
    力度单调性   v127 的响度必须高于 v50(训练只有这两档,中间值禁止插值)
    包络合理性   起音时间 / 800 ms 留存比例,与 dashboard 画像对照
    数值健康     NaN / Inf / 削顶 / 直流偏置

**刻意不依赖模型能加载。** 入口接受任意 `render(midi, velocity, duration)` 回调,
自带一个正弦波假 render 用来自测:正弦波应当在音高一项上**完美通过**(误差 < 1 cent)。
这一步验的不是模型,是**检测器自己**——如果正弦都测不准,后面所有结论都不能信。

f0 检测用 YIN(纯 numpy 实现,含抛物线插值),librosa 在场时改用 `librosa.pyin`。
不引入重依赖:numpy 必需,librosa / soundfile 可选,WAV 落盘走标准库 `wave`。

用法::

    # 自测:验证检测器本身(正弦波应当音高满分)
    python3 tools/audit_notes.py --self-test

    # 接真模型:render 回调从模块里取
    python3 tools/audit_notes.py --render server.backends.brave:make_render \\
        --out-dir staging/audit_brave --profile s001434
"""
from __future__ import annotations

import argparse
import importlib
import math
import statistics
import sys
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Protocol, Sequence

import numpy as np

# --------------------------------------------------------------------------
# 常量:训练边界与判据门槛
# --------------------------------------------------------------------------

SAMPLE_RATE = 44_100
"""midiBrave 输出采样率(BRIEF.md:44.1 kHz mono float)。"""

MIDI_MIN = 31
MIDI_MAX = 95
"""训练音域。越界即分布外,网格必须踩住这两个边界 —— 分布外的塌陷往往先从边界开始。"""

TRAIN_VELOCITIES: tuple[int, int] = (50, 127)
"""训练里 velocity 只有这两档。中间值是插出来的,不在被测契约内。"""

DEFAULT_NOTE_GRID: tuple[int, ...] = (31, 36, 48, 60, 72, 84, 95)
"""默认测试音网格:中间五个八度点 + 两个边界。"""

# 参考门槛来自评测报告实测值(median ≈7 cents / p90 ≈17 cents / 八度错 0)。
# 这里的**闸门**在参考值上留了余量:测试点更少(7 个 vs 全量)、f0 检测器也不是
# 同一个,复现到小数位没有意义。判据说明见 docs/audit.md。
REFERENCE_MEDIAN_CENTS = 7.0
REFERENCE_P90_CENTS = 17.0
GATE_MEDIAN_CENTS = 15.0
GATE_P90_CENTS = 35.0
GATE_OCTAVE_ERROR_RATE = 0.0

GATE_VELOCITY_MIN_DB = 0.5
"""v127 相对 v50 的 RMS 增量下限。低于此值说明力度条件基本没进模型。"""

GATE_ATTACK_REL_TOL = 0.40
"""起音时间相对画像的容差(±40%)。包络是软判据,不卡死。"""

GATE_RETENTION_ABS_TOL = 0.15
"""800 ms 留存比例相对画像的绝对容差。"""

GATE_CLIP_RATIO = 1e-3
GATE_DC_OFFSET = 0.01
GATE_PEAK_MIN = 0.01
"""数值健康门槛:削顶样本占比 / 直流偏置 / 峰值下限(低于此值等于没出声)。"""

#: dashboard 上已知的音色包络画像:名称 → (起音 ms, 800 ms 留存比例)。
KNOWN_PROFILES: dict[str, tuple[float, float]] = {
    "s001434": (485.0, 0.50),
    "s048091": (313.0, 0.73),
}

RETENTION_AT_MS = 800.0
"""留存比例的取样时刻,与 dashboard 画像口径一致。"""


class RenderFn(Protocol):
    """被测渲染回调。

    约定:返回 44.1 kHz mono、float、幅度大致在 [-1, 1] 的一维数组。
    长度允许与 `duration` 有出入(模型按 latent 帧对齐),验收器不苛求。
    """

    def __call__(self, midi: int, velocity: int, duration: float) -> np.ndarray: ...


# --------------------------------------------------------------------------
# 基础工具:音高换算、WAV 落盘
# --------------------------------------------------------------------------


def midi_to_hz(midi: float) -> float:
    """MIDI note number → 频率(Hz),A4 = 69 = 440 Hz。"""
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


def hz_to_cents(measured: float, target: float) -> float:
    """两个频率之间的 cents 差。正数表示实测偏高。"""
    return 1200.0 * math.log2(measured / target)


def split_octave_error(cents: float) -> tuple[int, float]:
    """把 cents 误差拆成「整八度部分」和「八度内残差」。

    八度错和几 cents 的失准是**两种性质完全不同的故障**:前者多半是条件张量
    查错了行或频率算错了底,后者是精度问题。混在一个平均值里会互相掩盖 ——
    一个八度错(1200 cents)能把中位数拖到毫无意义,所以必须分开统计。
    """
    octaves = int(round(cents / 1200.0))
    return octaves, cents - octaves * 1200.0


def write_wav(path: Path, audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> None:
    """落盘 16-bit PCM mono WAV,供人耳复核。

    **不做归一化**:削顶要能听见。归一化会把「输出过载」这个故障洗掉,
    而那正是我们要抓的东西之一。NaN / Inf 用 0 顶替,否则整数转换会炸。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    clean = np.nan_to_num(np.asarray(audio, dtype=np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    pcm = np.clip(clean, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())


# --------------------------------------------------------------------------
# f0 检测
# --------------------------------------------------------------------------

F0_SEARCH_MIN_HZ = 40.0
F0_SEARCH_MAX_HZ = 4200.0
"""f0 搜索区间。**刻意开得比训练音域宽**(note 31 ≈ 48.6 Hz,note 95 ≈ 1975 Hz):
搜索窗如果贴着目标音开,八度错会被窗口本身挡在外面测不出来,而八度错恰恰是
条件接错时最典型的症状。宁可放宽搜索、让八度错暴露出来。"""

_YIN_FRAME = 4096
_YIN_HOP = 1024
_YIN_THRESHOLD = 0.15
"""YIN 的绝对阈值。0.1 是原论文取值,合成音谐波丰富、CMND 谷底略浅,放到 0.15。"""


def _yin_frame_f0(frame: np.ndarray, sample_rate: int) -> tuple[float, float]:
    """单帧 YIN,返回 (f0_hz, 谷底深度)。谷底深度越小越可信,无解返回 (0.0, 1.0)。

    实现是标准 YIN 的前四步:差分函数 → 累积均值归一化 → 阈值取首个局部极小 →
    抛物线插值。差分函数用 FFT 自相关算,避免 O(N·tau) 的双重循环。
    """
    window = len(frame) // 2
    tau_min = max(2, int(sample_rate / F0_SEARCH_MAX_HZ))
    tau_max = min(window, int(sample_rate / F0_SEARCH_MIN_HZ) + 1)
    if tau_max <= tau_min + 2:
        return 0.0, 1.0

    x = frame.astype(np.float64)
    # d(tau) = Σ(x[j] - x[j+tau])² = Σx[j]² + Σx[j+tau]² - 2·Σx[j]x[j+tau]
    power = np.concatenate(([0.0], np.cumsum(x * x)))
    head = power[window] - power[0]                        # Σ_{j<window} x[j]²
    tail = power[window : window + tau_max] - power[0:tau_max]  # 滑动窗的能量

    size = 1 << (len(x) + window).bit_length()
    spectrum = np.fft.rfft(x, size)
    kernel = np.fft.rfft(x[:window][::-1], size)
    correlation = np.fft.irfft(spectrum * kernel, size)[window - 1 : window - 1 + tau_max]

    diff = head + tail - 2.0 * correlation
    diff[0] = 0.0

    # 累积均值归一化:抵消掉 d(tau) 随 tau 单调上升的趋势
    cumulative = np.cumsum(diff[1:])
    taus = np.arange(1, tau_max, dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        cmnd = np.where(cumulative > 0, diff[1:] * taus / cumulative, 1.0)
    cmnd = np.concatenate(([1.0], cmnd))

    band = cmnd[tau_min:tau_max]
    if band.size == 0:
        return 0.0, 1.0

    # 取**首个**跌破阈值的局部极小,而不是全局最小 —— 全局最小常落在
    # 真实周期的整数倍上(降八度错),首个谷底才是基频。
    tau = -1
    below = np.flatnonzero(band < _YIN_THRESHOLD)
    if below.size:
        start = int(below[0])
        tau = start
        while tau + 1 < band.size and band[tau + 1] < band[tau]:
            tau += 1
        tau += tau_min
    else:
        tau = int(np.argmin(band)) + tau_min

    depth = float(cmnd[tau])

    # 抛物线插值:整数 tau 的分辨率在高音区不够(1975 Hz 时相邻 tau 差 ~50 cents),
    # 不插值的话精度门槛根本无从谈起。
    if 0 < tau < len(diff) - 1:
        a, b, c = diff[tau - 1], diff[tau], diff[tau + 1]
        denom = a + c - 2.0 * b
        shift = 0.5 * (a - c) / denom if abs(denom) > 1e-12 else 0.0
        shift = float(np.clip(shift, -1.0, 1.0))
    else:
        shift = 0.0

    refined = tau + shift
    if refined <= 0:
        return 0.0, 1.0
    return sample_rate / refined, depth


def estimate_f0(
    audio: np.ndarray,
    sample_rate: int = SAMPLE_RATE,
    *,
    prefer_librosa: bool = True,
) -> float:
    """估计一段单音的基频(Hz),取有声帧的中位数。测不出返回 0.0。

    中位数而非均值:起音段和尾音的个别帧容易跳到谐波上,中位数对这种离群值免疫。
    只统计能量高于峰值 20% 的帧,并跳过前 15% —— 起音瞬态的音高本来就不稳,
    把它算进去是在惩罚模型本该有的行为。
    """
    signal = np.nan_to_num(np.asarray(audio, dtype=np.float64).reshape(-1), nan=0.0,
                           posinf=0.0, neginf=0.0)
    if signal.size < _YIN_FRAME:
        return 0.0

    start = int(signal.size * 0.15)
    signal = signal[start:]
    if signal.size < _YIN_FRAME:
        return 0.0

    if prefer_librosa:
        measured = _f0_via_librosa(signal, sample_rate)
        if measured > 0.0:
            return measured

    frames: list[tuple[float, float, float]] = []  # (f0, 谷底深度, 帧 RMS)
    for offset in range(0, signal.size - _YIN_FRAME + 1, _YIN_HOP):
        frame = signal[offset : offset + _YIN_FRAME]
        rms = float(np.sqrt(np.mean(frame * frame)))
        if rms <= 0.0:
            continue
        f0, depth = _yin_frame_f0(frame, sample_rate)
        if f0 > 0.0:
            frames.append((f0, depth, rms))

    if not frames:
        return 0.0

    peak_rms = max(item[2] for item in frames)
    voiced = [f0 for f0, depth, rms in frames if depth < 0.5 and rms >= 0.2 * peak_rms]
    if not voiced:
        return 0.0
    return float(statistics.median(voiced))


def _f0_via_librosa(signal: np.ndarray, sample_rate: int) -> float:
    """librosa.pyin 路径。装了就用(概率化,比裸 YIN 更稳),没装就静默退回。"""
    try:
        import librosa  # type: ignore
    except ImportError:
        return 0.0
    try:
        f0, voiced_flag, _ = librosa.pyin(
            signal.astype(np.float32),
            fmin=F0_SEARCH_MIN_HZ,
            fmax=F0_SEARCH_MAX_HZ,
            sr=sample_rate,
            frame_length=_YIN_FRAME,
        )
    except Exception:  # noqa: BLE001 — 检测器故障不该让整轮验收挂掉
        return 0.0
    valid = f0[np.isfinite(f0) & voiced_flag.astype(bool)] if f0 is not None else None
    if valid is None or valid.size == 0:
        return 0.0
    return float(np.median(valid))


# --------------------------------------------------------------------------
# 包络与数值健康
# --------------------------------------------------------------------------

_ENV_WINDOW_MS = 30.0
_ENV_HOP_MS = 5.0


def rms_envelope(
    audio: np.ndarray, sample_rate: int = SAMPLE_RATE
) -> tuple[np.ndarray, np.ndarray]:
    """滑窗 RMS 包络,返回 (时间轴秒, 包络值)。30 ms 窗 / 5 ms 跳。

    窗口取 30 ms:短于此值会被最低音(48.6 Hz,周期 20.6 ms)的单个周期波动带偏,
    长于此值则测不准几百毫秒量级的起音。
    """
    signal = np.nan_to_num(np.asarray(audio, dtype=np.float64).reshape(-1), nan=0.0,
                           posinf=0.0, neginf=0.0)
    window = max(1, int(sample_rate * _ENV_WINDOW_MS / 1000.0))
    hop = max(1, int(sample_rate * _ENV_HOP_MS / 1000.0))
    if signal.size < window:
        return np.zeros(0), np.zeros(0)

    squared = np.concatenate(([0.0], np.cumsum(signal * signal)))
    starts = np.arange(0, signal.size - window + 1, hop)
    energy = squared[starts + window] - squared[starts]
    envelope = np.sqrt(energy / window)
    times = (starts + window / 2.0) / sample_rate
    return times, envelope


def measure_envelope(
    audio: np.ndarray, sample_rate: int = SAMPLE_RATE
) -> tuple[float, float]:
    """返回 (起音时间 ms, 800 ms 留存比例)。

    起音时间 = 包络首次到达峰值的时刻;留存比例 = 800 ms 处包络 / 峰值包络。
    这两个量对齐 dashboard 画像的口径(如 s001434:485 ms / 0.50)。
    留存比例大于 1 是允许的 —— 说明峰值出现在 800 ms 之后,属于慢起音 pad 的正常形态。
    """
    times, envelope = rms_envelope(audio, sample_rate)
    if envelope.size == 0:
        return 0.0, 0.0
    peak = float(envelope.max())
    if peak <= 0.0:
        return 0.0, 0.0
    attack_index = int(np.argmax(envelope))
    attack_ms = float(times[attack_index] * 1000.0)

    target = RETENTION_AT_MS / 1000.0
    if times[-1] < target:
        # 音比 800 ms 还短,拿最后一帧顶,并在报告里靠 duration 自证
        retention = float(envelope[-1] / peak)
    else:
        retention = float(np.interp(target, times, envelope) / peak)
    return attack_ms, retention


@dataclass(frozen=True)
class HealthStats:
    """一段音频的数值健康快照。"""

    samples: int
    nan_count: int
    inf_count: int
    peak: float
    rms: float
    dc_offset: float
    clip_ratio: float

    @property
    def ok(self) -> bool:
        return (
            self.nan_count == 0
            and self.inf_count == 0
            and self.clip_ratio <= GATE_CLIP_RATIO
            and abs(self.dc_offset) <= GATE_DC_OFFSET
            and self.peak >= GATE_PEAK_MIN
        )

    def problems(self) -> list[str]:
        issues: list[str] = []
        if self.nan_count:
            issues.append(f"NaN×{self.nan_count}")
        if self.inf_count:
            issues.append(f"Inf×{self.inf_count}")
        if self.clip_ratio > GATE_CLIP_RATIO:
            issues.append(f"削顶 {self.clip_ratio:.2%}")
        if abs(self.dc_offset) > GATE_DC_OFFSET:
            issues.append(f"直流 {self.dc_offset:+.4f}")
        if self.peak < GATE_PEAK_MIN:
            issues.append(f"电平过低 peak={self.peak:.4f}")
        return issues


def check_health(audio: np.ndarray) -> HealthStats:
    """数值健康检查。**在 nan_to_num 之前统计** —— 否则等于把病人治好了再验血。"""
    raw = np.asarray(audio, dtype=np.float64).reshape(-1)
    nan_count = int(np.count_nonzero(np.isnan(raw)))
    inf_count = int(np.count_nonzero(np.isinf(raw)))
    finite = raw[np.isfinite(raw)]
    if finite.size == 0:
        return HealthStats(raw.size, nan_count, inf_count, 0.0, 0.0, 0.0, 1.0)
    peak = float(np.max(np.abs(finite)))
    rms = float(np.sqrt(np.mean(finite * finite)))
    dc = float(np.mean(finite))
    clip_ratio = float(np.count_nonzero(np.abs(finite) >= 0.999) / finite.size)
    return HealthStats(raw.size, nan_count, inf_count, peak, rms, dc, clip_ratio)


def rms_db(audio: np.ndarray) -> float:
    """RMS 转 dBFS。全零返回 -inf 的替身 -120 dB。"""
    finite = np.asarray(audio, dtype=np.float64).reshape(-1)
    finite = finite[np.isfinite(finite)]
    if finite.size == 0:
        return -120.0
    value = float(np.sqrt(np.mean(finite * finite)))
    return 20.0 * math.log10(value) if value > 1e-6 else -120.0


# --------------------------------------------------------------------------
# 测试点与报告数据结构
# --------------------------------------------------------------------------


@dataclass
class NoteResult:
    """一个测试点的全部实测量。"""

    midi: int
    velocity: int
    duration: float
    target_hz: float
    measured_hz: float
    cents_error: float
    octave_error: int
    residual_cents: float
    attack_ms: float
    retention: float
    rms_db_value: float
    health: HealthStats
    wav_path: Path | None = None

    @property
    def pitch_ok(self) -> bool:
        return self.measured_hz > 0.0 and self.octave_error == 0


@dataclass
class AuditReport:
    """一轮验收的汇总结论。"""

    notes: list[NoteResult] = field(default_factory=list)
    velocity_pairs: list[tuple[int, float, float, float]] = field(default_factory=list)
    profile_name: str | None = None
    expected_attack_ms: float | None = None
    expected_retention: float | None = None
    label: str = "unnamed"

    # --- 音高 ---
    @property
    def detected(self) -> list[NoteResult]:
        return [n for n in self.notes if n.measured_hz > 0.0]

    @property
    def median_cents(self) -> float:
        values = [abs(n.residual_cents) for n in self.detected]
        return float(statistics.median(values)) if values else float("nan")

    @property
    def p90_cents(self) -> float:
        values = sorted(abs(n.residual_cents) for n in self.detected)
        if not values:
            return float("nan")
        return float(np.percentile(values, 90))

    @property
    def octave_error_rate(self) -> float:
        if not self.notes:
            return float("nan")
        return sum(1 for n in self.notes if n.octave_error != 0) / len(self.notes)

    @property
    def undetected_count(self) -> int:
        return sum(1 for n in self.notes if n.measured_hz <= 0.0)

    @property
    def pitch_pass(self) -> bool:
        if not self.detected or self.undetected_count:
            return False
        return (
            self.median_cents <= GATE_MEDIAN_CENTS
            and self.p90_cents <= GATE_P90_CENTS
            and self.octave_error_rate <= GATE_OCTAVE_ERROR_RATE
        )

    # --- 力度 ---
    @property
    def velocity_pass(self) -> bool:
        if not self.velocity_pairs:
            return False
        return all(delta >= GATE_VELOCITY_MIN_DB for _, _, _, delta in self.velocity_pairs)

    @property
    def min_velocity_delta_db(self) -> float:
        if not self.velocity_pairs:
            return float("nan")
        return min(delta for _, _, _, delta in self.velocity_pairs)

    # --- 包络 ---
    @property
    def mean_attack_ms(self) -> float:
        values = [n.attack_ms for n in self.notes]
        return float(statistics.mean(values)) if values else float("nan")

    @property
    def mean_retention(self) -> float:
        values = [n.retention for n in self.notes]
        return float(statistics.mean(values)) if values else float("nan")

    @property
    def envelope_pass(self) -> bool | None:
        """没给画像就返回 None(不判定,只报数)。"""
        if self.expected_attack_ms is None or self.expected_retention is None:
            return None
        attack_ok = abs(self.mean_attack_ms - self.expected_attack_ms) <= (
            self.expected_attack_ms * GATE_ATTACK_REL_TOL
        )
        retention_ok = abs(self.mean_retention - self.expected_retention) <= GATE_RETENTION_ABS_TOL
        return bool(attack_ok and retention_ok)

    # --- 数值 ---
    @property
    def health_pass(self) -> bool:
        return bool(self.notes) and all(n.health.ok for n in self.notes)

    @property
    def overall_pass(self) -> bool:
        gates = [self.pitch_pass, self.velocity_pass, self.health_pass]
        envelope = self.envelope_pass
        if envelope is not None:
            gates.append(envelope)
        return all(gates)


# --------------------------------------------------------------------------
# 验收主流程
# --------------------------------------------------------------------------


def audit(
    render: RenderFn,
    *,
    note_grid: Sequence[int] = DEFAULT_NOTE_GRID,
    duration: float = 1.5,
    velocity: int = 127,
    velocity_notes: Sequence[int] = (48, 60, 72),
    out_dir: Path | None = None,
    profile: str | None = None,
    expected_attack_ms: float | None = None,
    expected_retention: float | None = None,
    label: str = "unnamed",
    sample_rate: int = SAMPLE_RATE,
    verbose: bool = True,
) -> AuditReport:
    """跑一整轮验收,返回报告对象。out_dir 非空时同时落盘每个测试点的 WAV。"""
    if profile and (expected_attack_ms is None or expected_retention is None):
        if profile not in KNOWN_PROFILES:
            raise KeyError(f"未知画像 {profile!r},已知:{sorted(KNOWN_PROFILES)}")
        expected_attack_ms, expected_retention = KNOWN_PROFILES[profile]

    report = AuditReport(
        profile_name=profile,
        expected_attack_ms=expected_attack_ms,
        expected_retention=expected_retention,
        label=label,
    )

    for midi in note_grid:
        if not (MIDI_MIN <= midi <= MIDI_MAX):
            # 不直接拒绝:测分布外行为本身是合法诉求,但要在报告里说清楚
            if verbose:
                print(f"  [warn] note {midi} 在训练音域 {MIDI_MIN}–{MIDI_MAX} 之外,结果仅供参考")
        audio = np.asarray(render(midi, velocity, duration), dtype=np.float64).reshape(-1)
        result = _measure_note(audio, midi, velocity, duration, sample_rate)
        if out_dir is not None:
            path = Path(out_dir) / f"note_{midi:03d}_v{velocity:03d}.wav"
            write_wav(path, audio, sample_rate)
            result.wav_path = path
        report.notes.append(result)
        if verbose:
            mark = "ok " if result.pitch_ok else "BAD"
            print(
                f"  [{mark}] note {midi:>3}  目标 {result.target_hz:8.2f} Hz  "
                f"实测 {result.measured_hz:8.2f} Hz  "
                f"误差 {result.residual_cents:+7.1f} cents"
                + (f"  八度错 {result.octave_error:+d}" if result.octave_error else "")
            )

    low, high = TRAIN_VELOCITIES
    for midi in velocity_notes:
        quiet = np.asarray(render(midi, low, duration), dtype=np.float64).reshape(-1)
        loud = np.asarray(render(midi, high, duration), dtype=np.float64).reshape(-1)
        quiet_db, loud_db = rms_db(quiet), rms_db(loud)
        report.velocity_pairs.append((midi, quiet_db, loud_db, loud_db - quiet_db))
        if out_dir is not None:
            write_wav(Path(out_dir) / f"vel_{midi:03d}_v{low:03d}.wav", quiet, sample_rate)
            write_wav(Path(out_dir) / f"vel_{midi:03d}_v{high:03d}.wav", loud, sample_rate)
        if verbose:
            delta = loud_db - quiet_db
            mark = "ok " if delta >= GATE_VELOCITY_MIN_DB else "BAD"
            print(
                f"  [{mark}] note {midi:>3}  v{low} {quiet_db:6.1f} dB → "
                f"v{high} {loud_db:6.1f} dB  (Δ {delta:+.1f} dB)"
            )

    return report


def _measure_note(
    audio: np.ndarray, midi: int, velocity: int, duration: float, sample_rate: int
) -> NoteResult:
    """把一段渲染结果压成一条 NoteResult。"""
    target = midi_to_hz(midi)
    health = check_health(audio)
    measured = estimate_f0(audio, sample_rate)
    if measured > 0.0:
        cents = hz_to_cents(measured, target)
        octaves, residual = split_octave_error(cents)
    else:
        cents, octaves, residual = float("nan"), 0, float("nan")
    attack_ms, retention = measure_envelope(audio, sample_rate)
    return NoteResult(
        midi=midi,
        velocity=velocity,
        duration=duration,
        target_hz=target,
        measured_hz=measured,
        cents_error=cents,
        octave_error=octaves,
        residual_cents=residual,
        attack_ms=attack_ms,
        retention=retention,
        rms_db_value=rms_db(audio),
        health=health,
    )


# --------------------------------------------------------------------------
# Markdown 报告
# --------------------------------------------------------------------------


def _verdict(passed: bool | None) -> str:
    if passed is None:
        return "— 未判定"
    return "✅ PASS" if passed else "❌ FAIL"


def render_markdown(report: AuditReport) -> str:
    """把报告渲染成 markdown。结论写在最前面 —— 报告是给人扫一眼用的。"""
    lines: list[str] = []
    add = lines.append

    add(f"# midiBrave 验收报告 — {report.label}")
    add("")
    add(f"**总体结论:{_verdict(report.overall_pass)}**")
    add("")
    add("| 项目 | 结论 | 关键数字 |")
    add("| --- | --- | --- |")
    add(
        f"| 音高准确度 | {_verdict(report.pitch_pass)} | "
        f"median {report.median_cents:.1f} / p90 {report.p90_cents:.1f} cents, "
        f"八度错 {report.octave_error_rate:.0%} |"
    )
    add(
        f"| 力度单调性 | {_verdict(report.velocity_pass)} | "
        f"最小 Δ {report.min_velocity_delta_db:+.1f} dB |"
    )
    envelope_detail = (
        f"起音 {report.mean_attack_ms:.0f} ms / 留存 {report.mean_retention:.2f}"
    )
    if report.expected_attack_ms is not None:
        envelope_detail += (
            f"(画像 {report.profile_name or 'custom'}:"
            f"{report.expected_attack_ms:.0f} ms / {report.expected_retention:.2f})"
        )
    add(f"| 包络合理性 | {_verdict(report.envelope_pass)} | {envelope_detail} |")
    bad_health = sum(1 for n in report.notes if not n.health.ok)
    add(f"| 数值健康 | {_verdict(report.health_pass)} | {bad_health}/{len(report.notes)} 个测试点异常 |")
    add("")

    add("## 1. 音高准确度")
    add("")
    add(
        f"门槛:median ≤ {GATE_MEDIAN_CENTS:.0f} cents、p90 ≤ {GATE_P90_CENTS:.0f} cents、"
        f"八度错 = 0。参考值(评测报告实测):median ≈ {REFERENCE_MEDIAN_CENTS:.0f} / "
        f"p90 ≈ {REFERENCE_P90_CENTS:.0f} cents。"
    )
    add("")
    add("| note | 目标 Hz | 实测 Hz | cents 误差 | 八度错 | 八度内残差 |")
    add("| --- | --- | --- | --- | --- | --- |")
    for note in report.notes:
        if note.measured_hz <= 0.0:
            add(f"| {note.midi} | {note.target_hz:.2f} | — | — | — | **测不出 f0** |")
            continue
        octave = f"**{note.octave_error:+d}**" if note.octave_error else "0"
        add(
            f"| {note.midi} | {note.target_hz:.2f} | {note.measured_hz:.2f} | "
            f"{note.cents_error:+.1f} | {octave} | {note.residual_cents:+.1f} |"
        )
    add("")
    if report.undetected_count:
        add(
            f"> ⚠️ {report.undetected_count} 个测试点测不出 f0。这**不是**检测器的宽容问题——"
            f"要么输出无调性(噪声/静音),要么基频落在 {F0_SEARCH_MIN_HZ:.0f}–"
            f"{F0_SEARCH_MAX_HZ:.0f} Hz 之外。先听 WAV 再下结论。"
        )
        add("")

    add("## 2. 力度单调性")
    add("")
    add(
        f"训练 velocity 只有 {TRAIN_VELOCITIES[0]} / {TRAIN_VELOCITIES[1]} 两档。"
        f"v{TRAIN_VELOCITIES[1]} 的 RMS 必须至少高出 {GATE_VELOCITY_MIN_DB:.1f} dB;"
        "若接近 0 或为负,说明 velocity 没有真正进入条件张量。"
    )
    add("")
    add(f"| note | v{TRAIN_VELOCITIES[0]} RMS (dB) | v{TRAIN_VELOCITIES[1]} RMS (dB) | Δ (dB) | 结论 |")
    add("| --- | --- | --- | --- | --- |")
    for midi, quiet, loud, delta in report.velocity_pairs:
        mark = "✅" if delta >= GATE_VELOCITY_MIN_DB else "❌"
        add(f"| {midi} | {quiet:.1f} | {loud:.1f} | {delta:+.1f} | {mark} |")
    add("")

    add("## 3. 包络合理性")
    add("")
    add(
        f"起音时间 = RMS 包络(30 ms 窗)到达峰值的时刻;留存比例 = "
        f"{RETENTION_AT_MS:.0f} ms 处包络 / 峰值包络。容差:起音 ±"
        f"{GATE_ATTACK_REL_TOL:.0%}、留存 ±{GATE_RETENTION_ABS_TOL:.2f}。"
    )
    add("")
    add("| note | 起音 (ms) | 800 ms 留存 | RMS (dB) |")
    add("| --- | --- | --- | --- |")
    for note in report.notes:
        add(
            f"| {note.midi} | {note.attack_ms:.0f} | {note.retention:.2f} | "
            f"{note.rms_db_value:.1f} |"
        )
    add("")
    if report.expected_attack_ms is not None:
        add(
            f"对照画像 `{report.profile_name or 'custom'}`:起音 "
            f"{report.expected_attack_ms:.0f} ms / 留存 {report.expected_retention:.2f};"
            f"实测均值 {report.mean_attack_ms:.0f} ms / {report.mean_retention:.2f}。"
        )
        add("")
        add(
            "> ⚠️ **这是一道弱闸门,别拿它当音色匹配的证据。** 包络本身随音高/音色"
            "波动很大,容差必须开得宽才不误报;而已知的两个画像(485 ms/0.50 与 "
            "313 ms/0.73)相距不远,容差带是重叠的 —— 同一段音频可能同时「通过」两个"
            "画像。它能抓住的是**量级级别的错**(起音塌成 0、留存掉到 0.05),"
            "抓不住「像不像这个音色」。后者只能靠听。"
        )
    else:
        add("> 未指定对照画像,本项只报数不判定。用 `--profile s001434` 打开判定。")
    add("")

    add("## 4. 数值健康")
    add("")
    add(
        f"门槛:无 NaN / Inf、削顶样本占比 ≤ {GATE_CLIP_RATIO:.1%}、"
        f"|直流偏置| ≤ {GATE_DC_OFFSET}、峰值 ≥ {GATE_PEAK_MIN}。"
    )
    add("")
    add("| note | 样本数 | 峰值 | RMS | 直流 | 削顶占比 | 问题 |")
    add("| --- | --- | --- | --- | --- | --- | --- |")
    for note in report.notes:
        health = note.health
        problems = ", ".join(health.problems()) or "—"
        add(
            f"| {note.midi} | {health.samples} | {health.peak:.4f} | {health.rms:.4f} | "
            f"{health.dc_offset:+.5f} | {health.clip_ratio:.3%} | {problems} |"
        )
    add("")

    wavs = [n.wav_path for n in report.notes if n.wav_path]
    if wavs:
        add("## 5. 人耳复核")
        add("")
        add("数字只能证伪,不能证明「好听」。以下 WAV 请实际听一遍:")
        add("")
        for path in wavs:
            add(f"- `{path}`")
        add("")

    add("---")
    add("")
    add("判据说明与门槛来源见 `docs/audit.md`。")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 假 render:自测用
# --------------------------------------------------------------------------


def make_sine_render(sample_rate: int = SAMPLE_RATE) -> RenderFn:
    """正弦波假 render —— **用来验检测器,不是用来验模型**。

    正弦的基频是精确已知的,所以音高一项必须**满分通过**(残差 < 1 cent)。
    如果这里都不满分,那么真模型跑出来的任何 cents 数字都不可信。

    velocity 走两档增益(v50 约 -8 dB),让力度单调性一项也有东西可测;
    包络给一个慢起音 + 缓降,免得留存比例退化成常数 1.0 而失去区分度。
    """

    def render(midi: int, velocity: int, duration: float) -> np.ndarray:
        count = max(1, int(sample_rate * duration))
        t = np.arange(count, dtype=np.float64) / sample_rate
        wave_ = np.sin(2.0 * np.pi * midi_to_hz(midi) * t)

        attack = min(0.35, duration * 0.4)
        envelope = np.ones(count, dtype=np.float64)
        rise = int(attack * sample_rate)
        if rise > 1:
            envelope[:rise] = np.linspace(0.0, 1.0, rise)
        envelope[rise:] = np.exp(-1.2 * (t[rise:] - t[rise - 1 if rise else 0]))

        gain = 0.45 if velocity >= 100 else 0.18
        return (wave_ * envelope * gain).astype(np.float32)

    return render


def load_render(spec: str) -> RenderFn:
    """从 ``module:attr`` 取 render 回调。attr 是可调用工厂时先调用一次取回调。"""
    if ":" not in spec:
        raise ValueError(f"render 规格应为 module:attr,收到 {spec!r}")
    module_name, attr_name = spec.split(":", 1)
    module = importlib.import_module(module_name)
    target = getattr(module, attr_name)
    try:
        candidate = target(1, 1, 0.05)  # 试作为 render 直接调用
    except TypeError:
        return target()  # 签名不匹配 → 当工厂用
    if isinstance(candidate, np.ndarray):
        return target
    return target()


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="midiBrave 音源验收器")
    parser.add_argument(
        "--render", default=None,
        help="render 回调,格式 module:attr(不给则用正弦波假 render)",
    )
    parser.add_argument("--self-test", action="store_true", help="用正弦波验证检测器本身")
    parser.add_argument(
        "--notes", default=",".join(str(n) for n in DEFAULT_NOTE_GRID),
        help="测试音网格,逗号分隔",
    )
    parser.add_argument("--duration", type=float, default=1.5, help="每个测试点的时长(秒)")
    parser.add_argument("--velocity", type=int, default=127, help="音高网格使用的 velocity")
    parser.add_argument("--profile", default=None, help=f"包络对照画像:{sorted(KNOWN_PROFILES)}")
    parser.add_argument("--expect-attack-ms", type=float, default=None)
    parser.add_argument("--expect-retention", type=float, default=None)
    parser.add_argument("--out-dir", default="staging/audit", help="WAV 与报告的落盘目录")
    parser.add_argument("--label", default=None, help="报告标题里的被测对象名")
    parser.add_argument("--no-wav", action="store_true", help="只出报告,不落 WAV")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    # 让 `--render server.backends.x:y` 这类项目内路径可导入
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

    if args.render:
        render = load_render(args.render)
        label = args.label or args.render
    else:
        render = make_sine_render()
        label = args.label or "sine(自测基准)"

    note_grid = tuple(int(x) for x in args.notes.split(",") if x.strip())
    out_dir = None if args.no_wav else Path(args.out_dir)

    print(f"验收对象:{label}")
    print(f"音网格:{note_grid}  时长 {args.duration}s  velocity {args.velocity}")
    print("-" * 68)

    report = audit(
        render,
        note_grid=note_grid,
        duration=args.duration,
        velocity=args.velocity,
        out_dir=out_dir,
        profile=args.profile,
        expected_attack_ms=args.expect_attack_ms,
        expected_retention=args.expect_retention,
        label=label,
    )

    markdown = render_markdown(report)
    if out_dir is not None:
        report_path = out_dir / "report.md"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(markdown, encoding="utf-8")
        print("-" * 68)
        print(f"报告:{report_path}")
        print(f"WAV :{out_dir}/")

    print("-" * 68)
    print(f"音高 {_verdict(report.pitch_pass)}  "
          f"(median {report.median_cents:.1f} / p90 {report.p90_cents:.1f} cents, "
          f"八度错 {report.octave_error_rate:.0%})")
    print(f"力度 {_verdict(report.velocity_pass)}  (最小 Δ {report.min_velocity_delta_db:+.1f} dB)")
    print(f"包络 {_verdict(report.envelope_pass)}  "
          f"(起音 {report.mean_attack_ms:.0f} ms / 留存 {report.mean_retention:.2f})")
    print(f"数值 {_verdict(report.health_pass)}")
    print(f"总体 {_verdict(report.overall_pass)}")

    if args.self_test:
        return _self_test_assertions(report)
    return 0 if report.overall_pass else 1


def _self_test_assertions(report: AuditReport) -> int:
    """自测断言:正弦波必须在音高一项上接近完美。

    这里断言的是**检测器的正确性**,不是被测模型的质量 —— 所以门槛比正式判据
    严得多(残差 < 1 cent 而非 15 cents)。松了就失去意义。
    """
    print("-" * 68)
    print("自测断言(验证检测器本身):")
    failures: list[str] = []

    if report.undetected_count:
        failures.append(f"有 {report.undetected_count} 个正弦测不出 f0")
    if report.octave_error_rate:
        failures.append(f"正弦出现八度错({report.octave_error_rate:.0%})")

    worst = max((abs(n.residual_cents) for n in report.detected), default=float("inf"))
    print(f"  正弦最大 cents 残差:{worst:.3f}")
    if not (worst < 1.0):
        failures.append(f"正弦 cents 残差 {worst:.3f} ≥ 1.0,f0 检测器不可信")

    if not report.velocity_pass:
        failures.append("正弦的力度单调性没通过,力度检查逻辑有问题")
    if not report.health_pass:
        failures.append("正弦的数值健康没通过,健康检查逻辑有问题")

    # 包络检测器也要自证:正弦的慢起音应当落在 300–400 ms(make_sine_render 给的 350 ms)
    if not (250.0 <= report.mean_attack_ms <= 450.0):
        failures.append(f"正弦起音实测 {report.mean_attack_ms:.0f} ms,不在预期的 350 ms 附近")

    if failures:
        for item in failures:
            print(f"  ❌ {item}")
        print("自测未通过 —— 在修好检测器之前,不要拿它去判模型。")
        return 1

    print("  ✅ f0 检测、力度、包络、健康检查全部自洽")

    failures.extend(_fault_injection_assertions())
    if failures:
        for item in failures:
            print(f"  ❌ {item}")
        print("自测未通过 —— 检测器抓不到已知故障,拿它去判模型只会得到虚假的绿灯。")
        return 1

    print("自测通过 —— 检测器可用。")
    return 0


def _fault_injection_assertions() -> list[str]:
    """故障注入:**证明检测器抓得住错**,而不只是「好输入能通过」。

    这才是本模块存在的理由。一个永远返回 PASS 的验收器比没有验收器更危险 ——
    它会给「看起来在工作但其实是错的」发一张通行证。所以这里手工造出每一种
    已知故障形态,逐个断言对应的闸门必须亮红灯:

        降八度      note embedding 查错行 / 频率算错底 → 音高闸门
        整体失谐    条件时间轴没对齐 / 采样率假设错   → 音高闸门
        力度无效    velocity 压根没进条件张量         → 力度闸门
        力度反向    两档 velocity 接反                → 力度闸门
        NaN/削顶/直流  数值通路故障                    → 健康闸门
        纯噪声      条件全错、解码器输出崩掉           → 音高闸门

    任何一条漏网,就说明对应的闸门是摆设。
    """
    base = make_sine_render()
    sr = SAMPLE_RATE

    def octave_down(midi: int, velocity: int, duration: float) -> np.ndarray:
        return base(midi - 12, velocity, duration)

    def detuned(midi: int, velocity: int, duration: float) -> np.ndarray:
        count = int(sr * duration)
        t = np.arange(count, dtype=np.float64) / sr
        hz = midi_to_hz(midi) * (2.0 ** (40.0 / 1200.0))  # 全局偏高 40 cents
        return (np.sin(2.0 * np.pi * hz * t) * 0.4).astype(np.float32)

    def velocity_ignored(midi: int, velocity: int, duration: float) -> np.ndarray:
        return base(midi, 127, duration)

    def velocity_inverted(midi: int, velocity: int, duration: float) -> np.ndarray:
        return base(midi, 50 if velocity >= 100 else 127, duration)

    def has_nan(midi: int, velocity: int, duration: float) -> np.ndarray:
        audio = base(midi, velocity, duration).astype(np.float64)
        audio[1000:1010] = np.nan
        return audio

    def clipped(midi: int, velocity: int, duration: float) -> np.ndarray:
        return np.clip(base(midi, velocity, duration) * 8.0, -1.0, 1.0)

    def dc_offset(midi: int, velocity: int, duration: float) -> np.ndarray:
        return base(midi, velocity, duration) + 0.05

    def pure_noise(midi: int, velocity: int, duration: float) -> np.ndarray:
        rng = np.random.default_rng(0)
        return (rng.standard_normal(int(sr * duration)) * 0.2).astype(np.float32)

    # (名称, 假 render, 必须亮红灯的闸门名)
    cases: list[tuple[str, RenderFn, str]] = [
        ("降八度", octave_down, "pitch"),
        ("整体失谐 40 cents", detuned, "pitch"),
        ("velocity 未生效", velocity_ignored, "velocity"),
        ("velocity 接反", velocity_inverted, "velocity"),
        ("输出含 NaN", has_nan, "health"),
        ("输出削顶", clipped, "health"),
        ("直流偏置", dc_offset, "health"),
        ("纯噪声", pure_noise, "pitch"),
    ]

    print("故障注入(验证检测器抓得住错):")
    problems: list[str] = []
    for name, broken, gate in cases:
        report = audit(broken, verbose=False, duration=1.5)
        gate_value = {
            "pitch": report.pitch_pass,
            "velocity": report.velocity_pass,
            "health": report.health_pass,
        }[gate]
        caught = (not gate_value) and (not report.overall_pass)
        print(f"  {'✅' if caught else '❌'} {name:<20} → {gate} 闸门 "
              f"{'拦下' if not gate_value else '**放行**'}")
        if not caught:
            problems.append(f"故障「{name}」没被 {gate} 闸门拦下")
    return problems


if __name__ == "__main__":
    raise SystemExit(main())
