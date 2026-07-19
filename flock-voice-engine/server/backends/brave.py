"""B 档：midiBrave 神经音源后端。

服务层通过 ``backend_id = "brave"`` 自动收录本类（见 backends/base.py）。

设计要点
--------

* **固定长度 voice 池、行绑定。** 每个 ``voice.row`` 常驻一个 ``StreamingVoice``，
  不发声时也保留状态，绝不做动态增删（BRIEF 架构决定 2）。
* **release 由本后端补。** 上游 IMPLEMENTATION.md 写明 "The neural decoder has no
  gate, pitch bend, ADSR, onset/offset, legato, release" —— 模型只吃 (note, velocity)，
  没有松键分支。所以 gate 落下之后必须由这一层做线性 release 淡出，否则声音永远停不下来。
  这是**包络**，不是 master/混响/EQ，不违反「服务端不做 master」的约定。
* **velocity 只有两档。** 训练集只有 {50,127}，中间值是分布外。前端 0–1 连续值
  在这里量化到两档，档内差异用增益补，**绝不插值**。
* **一行一次前向。** V1 池长 1。池长 >1 时当前实现是逐行串行前向，CPU 开销线性增长；
  V2 要把 batch 维和声部维合并成一次前向（模型本身支持，见 model.decode 的 batch 用法）。
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from .base import AudioBackend

# 训练边界（config.trained.yaml: note_min/note_max/velocities）
TRAIN_NOTE_MIN = 21
TRAIN_NOTE_MAX = 109
VELOCITY_LOW = 50
VELOCITY_HIGH = 127
#: 前端 0–1 velocity 的分档阈值。<=0.55 走 v50 样本，其余走 v127。
VELOCITY_SPLIT = 0.55
#: 档内的增益补偿范围（dB）。量化损失用增益找回来，而不是给模型喂分布外的 velocity。
VELOCITY_TRIM_DB = 6.0

DEFAULT_TIMBRE_BANK = Path(__file__).resolve().parents[2] / "assets" / "timbre" / "atlas.json"

#: 进程级共享的已加载模型，按 checkpoint 路径缓存。
#:
#: 服务层给**每个 WS 连接**造一个后端实例（跨块状态不能在连接之间串，这是对的），
#: 但如果每个实例都各自 ``torch.load`` 一次权重，一个连接就要多吃约 700 MiB、
#: 多等数秒。Spark 上只有约 12 GB 可用内存，连两三次就会耗尽；而加载期间没有音频
#: 流出，客户端的停流看门狗会触发重连，重连又触发新一次加载 —— 死循环，
#: 表现为「一直连接断开」。
#:
#: 权重是只读的，**跨会话共享安全**；每会话独有的只是 StreamingVoice 里的跨块状态。
_SHARED_MODELS: dict[str, Any] = {}
#: atlas 缺失时的兜底漫游步长（每音符事件允许移动的 z 距离）。
FALLBACK_ROAM_STEP = 0.8
#: 一个音符事件的名义时长，用来把「每音符」的步长换算成 StreamingVoice 吃的「每秒」。
#: 取偏保守的估计：宁可漫游慢一点，也不要在块边界听到跳变。
NOMINAL_NOTE_SECONDS = 0.5


class BraveBackend(AudioBackend):
    """midiBrave 神经音源。"""

    backend_id = "brave"

    def __init__(
        self,
        sample_rate: int = 44_100,
        pool_size: int = 1,
        block_samples: int = 1024,
        model_path: str | None = None,
        timbre_bank: str | Path | None = None,
    ) -> None:
        super().__init__(sample_rate, pool_size, block_samples)
        self.model_path = model_path
        self.timbre_bank_path = Path(timbre_bank) if timbre_bank else DEFAULT_TIMBRE_BANK
        self._backend = None          # MidiBraveBackend
        self._voices: list = []       # 每行一个 StreamingVoice
        self._row_state: list[dict] = []
        self._bank: list[np.ndarray] = []
        self._bank_names: list[str] = []
        self._roam_step: float = FALLBACK_ROAM_STEP

    # ---- 生命周期 -------------------------------------------------------
    def load(self) -> None:
        if self.loaded:
            return
        import torch

        from .midibrave_backend import MidiBraveBackend
        from .streaming import StreamingVoice

        if self.sample_rate != 44_100:
            raise ValueError(f"midiBrave 固定 44.1 kHz，收到 {self.sample_rate}")

        # 权重全进程共享，见 _SHARED_MODELS 的说明。
        cache_key = str(self.model_path or "<default>")
        shared = _SHARED_MODELS.get(cache_key)
        if shared is None:
            kwargs = {"checkpoint_path": self.model_path} if self.model_path else {}
            shared = MidiBraveBackend(**kwargs)
            _SHARED_MODELS[cache_key] = shared
            print(f"[brave] 模型已加载并缓存: {shared.describe()}", flush=True)
        else:
            print("[brave] 复用已加载的模型（跨会话共享权重）", flush=True)
        self._backend = shared
        geom = self._backend.geometry
        if self.block_samples % geom.samples_per_latent:
            raise ValueError(
                f"block_samples 必须是 {geom.samples_per_latent} 的整数倍，"
                f"收到 {self.block_samples}"
            )

        self._load_timbre_bank(torch)
        # atlas 的步长单位是「每音符事件」，StreamingVoice 的限速单位是「每秒」。
        rate = self._roam_step / NOMINAL_NOTE_SECONDS
        self._voices = [
            StreamingVoice(self._backend, timbre_rate_per_second=rate)
            for _ in range(self.pool_size)
        ]
        self._row_state = [self._blank_row() for _ in range(self.pool_size)]
        self.loaded = True

    def _blank_row(self) -> dict:
        return {
            "active": False,      # 是否有 StreamingVoice 在跑
            "releasing": False,
            "gain": 0.0,          # 当前 release 增益
            "gain_step": 0.0,
            "trim": 1.0,          # velocity 量化的增益补偿
            "midi": None,
            "timbre": None,
        }

    def _load_timbre_bank(self, torch) -> None:
        """载入 z_timbre 锚点与实测标定的漫游步长。

        文件是 ``assets/timbre/atlas.json``（schema 1）：``anchors[].z_timbre`` 是
        128 维向量，``roaming.max_step_per_note`` 是实测标定的每音符移动上限。
        兼容旧的 ``presets[]`` 布局。缺库时退化成单一确定性音色，保证服务能起来。
        """
        self._bank, self._bank_names = [], []
        if self.timbre_bank_path.is_file():
            payload = json.loads(self.timbre_bank_path.read_text(encoding="utf-8"))
            entries = payload.get("anchors") or payload.get("presets") or []
            for entry in entries:
                self._bank.append(np.asarray(entry["z_timbre"], dtype=np.float32))
                self._bank_names.append(str(entry.get("id", "?")))
            step = (payload.get("roaming") or {}).get("max_step_per_note")
            if step:
                self._roam_step = float(step)
        if not self._bank:
            zero = torch.zeros(1, self._backend.config.model.clap_dim)
            self._bank = [self._backend.timbre_from_clap(zero).numpy()[0]]
            self._bank_names = ["fallback-zero-clap"]

    def close(self) -> None:
        """只释放本会话的状态。

        **不要销毁 ``self._backend``** —— 它是 ``_SHARED_MODELS`` 里的共享实例，
        别的会话还在用。这里置空只是断开本实例的引用。
        """
        self._voices = []
        self._row_state = []
        self._backend = None
        self.loaded = False

    def reset(self) -> None:
        for voice in self._voices:
            voice.note_off()
        self._row_state = [self._blank_row() for _ in range(self.pool_size)]

    # ---- 事件钩子 -------------------------------------------------------
    def note_on(self, voice) -> None:
        if not self.loaded:
            return
        import torch

        row = int(voice.row)
        state = self._row_state[row]

        note = int(round(float(voice.midi)))
        if not TRAIN_NOTE_MIN <= note <= TRAIN_NOTE_MAX:
            note = max(TRAIN_NOTE_MIN, min(TRAIN_NOTE_MAX, note))

        velocity, trim = self._quantize_velocity(float(voice.velocity))
        slot = int(voice.timbre) % len(self._bank)
        z = torch.from_numpy(self._bank[slot]).view(1, -1)

        # last-note-priority：直接抢占，重建该行的流式状态（含 warmup）。
        self._voices[row].note_on(z, note, velocity)
        state.update(
            active=True, releasing=False, gain=1.0, gain_step=0.0,
            trim=trim, midi=note, timbre=slot,
        )

    def note_off(self, voice) -> None:
        if not self.loaded:
            return
        row = int(voice.row)
        state = self._row_state[row]
        if not state["active"] or state["releasing"]:
            return
        release = max(1e-3, float(getattr(voice, "release_seconds", 0.4)))
        blocks = max(1.0, release * self.sample_rate / self.block_samples)
        state["releasing"] = True
        state["gain_step"] = 1.0 / blocks

    @staticmethod
    def _quantize_velocity(value: float) -> tuple[int, float]:
        """前端 0–1 → 训练档位 {50,127} + 增益补偿倍数。

        训练集只有两档 velocity，中间值是分布外，所以**不插值**：
        先落到最近的档，再用不超过 ±6 dB 的增益把档内差异找回来。
        """
        value = float(np.clip(value, 0.0, 1.0))
        if value <= VELOCITY_SPLIT:
            velocity = VELOCITY_LOW
            # 档内相对位置 → [-6, +6] dB
            ratio = value / VELOCITY_SPLIT if VELOCITY_SPLIT > 0 else 1.0
        else:
            velocity = VELOCITY_HIGH
            ratio = (value - VELOCITY_SPLIT) / max(1e-6, 1.0 - VELOCITY_SPLIT)
        gain_db = VELOCITY_TRIM_DB * (ratio - 0.5) * 2.0 * 0.5
        return velocity, float(10.0 ** (gain_db / 20.0))

    # ---- 音色漫游 -------------------------------------------------------
    def _sync_timbre(self, voice, row: int, state: dict) -> None:
        """把 ``voice.timbre`` 的变化翻译成漫游目标。

        这是 V1 的核心功能，也是「漫游」与「换音色」的分界：换音色会重起音、
        切断跨块状态；漫游必须连续，所以只设目标点，由 StreamingVoice 内部按
        实测标定的步长限速移过去。松键途中不接受新目标 —— 那会让 release
        听起来像是又活过来了。
        """
        slot = int(voice.timbre) % len(self._bank)
        if slot == state["timbre"] or state["releasing"]:
            return
        import torch

        target = torch.from_numpy(self._bank[slot]).view(1, -1)
        self._voices[row].set_timbre_target(target)
        state["timbre"] = slot

    # ---- 渲染 -----------------------------------------------------------
    def render_block(self, voices: Sequence, n_samples: int) -> np.ndarray:
        out = np.zeros(n_samples, dtype=np.float32)
        if not self.loaded:
            return out
        for voice in voices:
            row = int(voice.row)
            state = self._row_state[row]
            if not state["active"]:
                continue
            self._sync_timbre(voice, row, state)
            block = self._voices[row].render_block(n_samples)
            if state["releasing"]:
                start = state["gain"]
                end = max(0.0, start - state["gain_step"])
                ramp = np.linspace(start, end, n_samples, endpoint=False, dtype=np.float32)
                block = block * ramp
                state["gain"] = end
                if end <= 1e-5:
                    self._voices[row].note_off()
                    self._row_state[row] = self._blank_row()
            out += block * state["trim"]
        return np.clip(out, -1.0, 1.0, out=out)

    # ---- 自述 -----------------------------------------------------------
    def info(self) -> dict[str, Any]:
        meta = getattr(self._backend, "checkpoint_meta", {}) if self._backend else {}
        geom = getattr(self._backend, "geometry", None)
        return {
            **self.base_info(),
            "engine": "midibrave-phase1",
            "step": meta.get("step"),
            "configHash": meta.get("config_hash"),
            "latentSize": 128,
            "samplesPerLatent": geom.samples_per_latent if geom else None,
            "warmupLatentFrames": geom.warmup_latent_frames if geom else None,
            "noteRange": [TRAIN_NOTE_MIN, TRAIN_NOTE_MAX],
            "velocities": [VELOCITY_LOW, VELOCITY_HIGH],
            "timbrePresets": self._bank_names,
            "roamStepPerNote": self._roam_step,
            "roaming": "setParams(voice,{timbre:N}) → 连续漫游到第 N 个锚点，不重起音",
        }


def make_render(model_path: str | None = None, timbre_slot: int = 0):
    """给 ``tools/audit_notes.py`` 用的 render 回调工厂。

    用法::

        python3 tools/audit_notes.py --render server.backends.brave:make_render
    """
    from .midibrave_backend import MidiBraveBackend

    backend = MidiBraveBackend(**({"checkpoint_path": model_path} if model_path else {}))
    bank = BraveBackend(pool_size=1)
    bank._backend = backend
    import torch

    bank._load_timbre_bank(torch)
    z = torch.from_numpy(bank._bank[timbre_slot % len(bank._bank)]).view(1, -1)

    def render(midi: int, velocity: int, duration: float) -> np.ndarray:
        note = max(TRAIN_NOTE_MIN, min(TRAIN_NOTE_MAX, int(round(midi))))
        # 验收器送的是 0–127 的 MIDI velocity，这里同样量化到两档
        vel = VELOCITY_LOW if float(velocity) <= 88.5 else VELOCITY_HIGH
        return backend.render_note(z, note, vel, float(duration))

    return render


if __name__ == "__main__":
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from server.voices import VoicePool

    pool = VoicePool(size=1, sample_rate=44_100)
    backend = BraveBackend(sample_rate=44_100, pool_size=1, block_samples=1024)
    backend.load()
    print("info:", json.dumps(backend.info(), ensure_ascii=False, indent=2))

    voice = pool.voices[0]
    voice.note_on(60, 0.9)
    backend.note_on(voice)
    blocks = [backend.render_block(pool.voices, 1024) for _ in range(20)]
    audio = np.concatenate(blocks)
    print("gate on :", audio.shape, "peak", float(np.abs(audio).max()))

    # 漫游：换 timbre 槽位不应重起音，跨块状态保留，块边界不应有台阶。
    slots = len(backend._bank)
    if slots > 1:
        voice.timbre = min(4, slots - 1)
        # 必须跑够时间才能走完锚点间距（实测锚点间 z 距离 4~10，限速 1.6/秒 →
        # 最长约 6 秒）。跑太短会得到「音色几乎没变」的假警报。
        target_blocks = int(12.0 * 44_100 / 1024)
        roam = np.concatenate(
            [backend.render_block(pool.voices, 1024) for _ in range(target_blocks)]
        )
        residual = float(
            np.linalg.norm(
                (backend._voices[0].state.z_target - backend._voices[0].state.z_current)
                .cpu()
                .numpy()
            )
        )
        print(f"漫游残差: {residual:.5f} → {'已到达目标锚点' if residual < 0.01 else '未走完'}")
        jumps = np.abs(np.diff(roam))
        edges = jumps[1023::1024]
        print(
            f"漫游    : {roam.shape} peak {float(np.abs(roam).max()):.4f} "
            f"块边界最大跳变 {edges.max():.5f} / 全局 {jumps.max():.5f} "
            f"→ {'无台阶' if edges.max() <= jumps.max() * 1.05 else '疑似台阶'}"
        )
        # 漫游必须真的改变了声音，否则等于没漫游
        head = roam[: 1024 * 10]
        tail_seg = roam[-1024 * 10 :]
        import numpy.fft as _fft

        spec = lambda x: np.abs(_fft.rfft(x * np.hanning(len(x))))  # noqa: E731
        a, b = spec(head), spec(tail_seg)
        cos = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))
        print(f"漫游前后频谱余弦 {cos:.4f} → {'音色确实变了' if cos < 0.995 else '几乎没变，需排查'}")
    else:
        print("漫游    : 跳过（音色库只有 1 个锚点）")

    voice.note_off()
    backend.note_off(voice)
    tail = np.concatenate([backend.render_block(pool.voices, 1024) for _ in range(30)])
    print("release :", "peak", float(np.abs(tail).max()),
          "尾部是否归零:", float(np.abs(tail[-1024:]).max()) < 1e-4)
