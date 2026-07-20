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

#: 响度增益每块朝目标移动的比例。1024 样本/块 → 时间常数约 0.35 s。
LOUDNESS_SMOOTH = 0.065
#: 输出总配平。响度标定把各点拉到同一目标，但那个目标（-23 dBFS K 加权）
#: 叠上 velocity trim 之后仍会逼近削顶（实测 RMS 0.62）。这里统一降一档，
#: 给包络峰值和未来的多声部叠加留余量。
OUTPUT_TRIM = 0.28
#: 软限幅阈值。**这不是用来抹平音色差异的** —— 那件事已经由离线逐点标定做完了。
#: 它只是安全网：kNN 混合可能落在标定网格之间、包络峰值可能超出稳态测量，
#: 硬削顶会产生刺耳的谐波失真，软拐点则听不出来。
SOFT_LIMIT = 0.85
#: XY 直控的漫游限速（每秒 z 距离）。远高于自动漫游的 1.6 —— 这是两种不同的交互：
#: 自动漫游要「慢到能听出是同一个音在变形」，直接操纵要「拖到哪立刻响到哪」。
#: 仍然限速而不是瞬间跳变，是为了避免块边界的可闻撕裂；20/秒 下典型的
#: preset 间距(5–10)约 0.3–0.5 秒走完，手感上就是即时的。
XY_RATE_PER_SECOND = 20.0

DEFAULT_TIMBRE_BANK = Path(__file__).resolve().parents[2] / "assets" / "timbre" / "atlas.json"
DEFAULT_LATENT_MAP = Path(__file__).resolve().parents[2] / "assets" / "timbre" / "latent_map.json"
#: XY 直控的 kNN 邻居数。太小会在稀疏区跳变，太大会把整张图糊成平均音色。
LATENT_MAP_K = 6

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
        self._bank_gain: list[float] = []
        self._roam_step: float = FALLBACK_ROAM_STEP
        # 二维音色地图：平面坐标 + 对应的真实 preset z（kNN 混合用）
        self._map_xy: np.ndarray | None = None
        self._map_z: np.ndarray | None = None
        self._map_gain: np.ndarray | None = None
        # 无约束 PCA 漫游：前 N 个主成分的基与中心
        self._pca_basis: np.ndarray | None = None
        self._pca_mean: np.ndarray | None = None
        self._pca_ranges: list[dict] | None = None

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
        self._load_latent_map()
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
            "loud": 1.0,          # 响度归一化增益（当前值，逐块平滑）
            "loud_target": 1.0,   # 目标值，换锚点时设定
            "midi": None,
            "timbre": None,
            "xy": None,
            "k": None,
            "pca": None,
        }

    def _load_timbre_bank(self, torch) -> None:
        """载入 z_timbre 锚点与实测标定的漫游步长。

        文件是 ``assets/timbre/atlas.json``（schema 1）：``anchors[].z_timbre`` 是
        128 维向量，``roaming.max_step_per_note`` 是实测标定的每音符移动上限。
        兼容旧的 ``presets[]`` 布局。缺库时退化成单一确定性音色，保证服务能起来。
        """
        self._bank, self._bank_names, self._bank_gain = [], [], []
        if self.timbre_bank_path.is_file():
            payload = json.loads(self.timbre_bank_path.read_text(encoding="utf-8"))
            entries = payload.get("anchors") or payload.get("presets") or []
            for entry in entries:
                self._bank.append(np.asarray(entry["z_timbre"], dtype=np.float32))
                self._bank_names.append(str(entry.get("id", "?")))
                # 响度归一化增益（tools/calibrate_loudness.py 标定）。
                # 锚点之间裸电平差近 10 倍（K 加权 21.8 dB），不补的话漫游听起来
                # 就是忽大忽小而不是音色变化。缺字段时取 1.0，退化成不做归一化。
                self._bank_gain.append(float((entry.get("loudness") or {}).get("gain", 1.0)))
            step = (payload.get("roaming") or {}).get("max_step_per_note")
            if step:
                self._roam_step = float(step)
        if not self._bank:
            zero = torch.zeros(1, self._backend.config.model.clap_dim)
            self._bank = [self._backend.timbre_from_clap(zero).numpy()[0]]
            self._bank_names = ["fallback-zero-clap"]
            self._bank_gain = [1.0]

    def latent_from_pca(self, coeffs) -> np.ndarray | None:
        """前 N 个主成分的系数 → z_timbre。**无约束合成，不做 kNN。**

            z = mean + Σ coeff[i] * basis[i]

        与 ``latent_from_xy`` 的取舍完全相反：

        * kNN 混合真实 preset —— 安全（永远在凸包内），但稀疏区会「黏」，过渡不连续。
        * PCA 子空间自由漫游 —— 连续、无黏滞，但**不保证落在流形上**。
          主成分是线性方向，真实的 z 流形未必线性；子空间里的点可能落到流形外，
          听感上表现为失真、怪音或不发声。

        前 10 个主成分累计解释 79.4% 的方差 —— 这是「大概率仍在合理区域」的依据，
        但它是**方差论据不是流形论据**，不能替代实听验证。这正是本实验要听的。

        z_timbre 是 Tanh 输出，落在 [-1,1]^128；这里仍然 clamp 一次，
        越界即分布外，硬拉回来至少不会喂给 decoder 一个它没见过的量级。
        """
        if self._pca_basis is None or self._pca_mean is None:
            return None
        n = self._pca_basis.shape[0]
        vector = np.zeros(n, dtype=np.float32)
        for index in range(min(n, len(coeffs))):
            vector[index] = float(coeffs[index])
        latent = self._pca_mean + vector @ self._pca_basis
        return np.clip(latent, -1.0, 1.0).astype(np.float32)

    def _nearest_anchor_gain(self, latent: np.ndarray) -> float:
        """按 z 距离取最近锚点的响度增益。

        XY 直控可以落在 1239 个 preset 之间的任意位置，逐点标定响度成本太高
        （每点要渲染 3 秒）。kNN 混合本身落在真实 preset 的凸包内，用最近锚点的
        增益近似，误差有限 —— 比完全不做归一化好得多。
        """
        if not self._bank_gain:
            return 1.0
        bank = np.asarray(self._bank, dtype=np.float32)
        distances = np.linalg.norm(bank - latent.reshape(1, -1), axis=1)
        return float(self._bank_gain[int(np.argmin(distances))])

    def _load_latent_map(self) -> None:
        """载入二维音色地图。缺失不致命 —— XY 直控降级为不可用，锚点仍能用。"""
        path = DEFAULT_LATENT_MAP
        if not path.is_file():
            print("[brave] 无 latent_map.json，XY 直控不可用", flush=True)
            return
        data = json.loads(path.read_text(encoding="utf-8"))
        self._map_xy = np.asarray(
            [[p["x"], p["y"]] for p in data["points"]], dtype=np.float32
        )
        self._map_z = np.asarray(data["z"], dtype=np.float32)
        # 逐点响度增益（tools/calibrate_map_loudness.py 标定）。跨点极差 42.6 dB ——
        # 比锚点间的 21.8 dB 还大一倍，所以「取最近锚点的增益」近似是不够的。
        if "gain" in (data["points"][0] if data["points"] else {}):
            self._map_gain = np.asarray([p["gain"] for p in data["points"]], dtype=np.float32)
        pca = data.get("pca_basis")
        if pca:
            self._pca_basis = np.asarray(pca["basis"], dtype=np.float32)
            self._pca_mean = np.asarray(pca["mean"], dtype=np.float32)
            self._pca_ranges = pca.get("ranges")
        print(f"[brave] 音色地图: {len(self._map_xy)} 点，布局 {data.get('layout')}，"
              f"逐点响度 {'已标定' if self._map_gain is not None else '缺失'}，"
              f"PCA 基 {self._pca_basis.shape[0] if self._pca_basis is not None else 0} 维", flush=True)

    def latent_from_xy(
        self, x: float, y: float, k: int = LATENT_MAP_K
    ) -> tuple[np.ndarray, float] | None:
        """平面坐标 → z_timbre，用最近 k 个**真实 preset** 的距离加权混合。

        **刻意不做反投影。** 布局是 t-SNE（没有可逆的基），而即便用 PCA，
        去重后前二主成分也只解释约 45% 的方差 —— 反投影出来的点会落在流形之外，
        听感上是失真或干脆不发声。混合真实 preset 则永远落在它们的凸包内。

        代价：preset 稀疏的区域会「黏」在最近的几个点上而不是平滑过渡。
        这是真实的、该在界面上画出来的缺陷，不该用插值假装抹平。

        返回 ``(z_timbre, 响度增益)``，两者用同一组 kNN 权重混合。
        """
        if self._map_xy is None or self._map_z is None:
            return None
        query = np.asarray([x, y], dtype=np.float32)
        distances = np.linalg.norm(self._map_xy - query, axis=1)
        k = max(1, min(int(k), len(distances)))
        idx = np.argpartition(distances, k - 1)[:k]
        local = distances[idx]
        # 反平方距离加权。加 eps 防止正好落在某个点上时除零 —— 那种情况下
        # 该点权重压倒性大，等价于直接取它，符合预期。
        weights = 1.0 / np.square(local + 0.02)
        weights = (weights / max(float(weights.sum()), 1e-9)).astype(np.float32)
        latent = (self._map_z[idx].T @ weights).astype(np.float32)
        # 增益用**同一组权重**混合 —— 与 z 同步，平面上的响度才连续。
        gain = float(self._map_gain[idx] @ weights) if self._map_gain is not None else 1.0
        return latent, gain

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

        # XY 直控时起音必须直接落在 XY 对应的 z 上。
        # 若仍从锚点起音再漫游过去，每按一个新音都会把音色拉回锚点，
        # 拖动地图听起来就「几乎没有变化」—— 因为听到的一直是锚点附近。
        coeffs = getattr(voice, "timbre_pca", None)
        pca_latent = self.latent_from_pca(coeffs) if coeffs is not None else None
        xy = getattr(voice, "timbre_xy", None)
        xy_result = (self.latent_from_xy(xy[0], xy[1], getattr(voice, 'timbre_k', LATENT_MAP_K))
                     if (xy is not None and pca_latent is None) else None)
        if pca_latent is not None:
            z = torch.from_numpy(pca_latent).view(1, -1)
            xy_gain = self._nearest_anchor_gain(pca_latent)
            xy_result = True   # 走下面「用 xy_gain」那条分支
        elif xy_result is not None:
            latent, xy_gain = xy_result
            z = torch.from_numpy(latent).view(1, -1)
        else:
            z = torch.from_numpy(self._bank[slot]).view(1, -1)

        # last-note-priority：直接抢占，重建该行的流式状态（含 warmup）。
        self._voices[row].note_on(z, note, velocity)
        if xy_result is not None:
            loud = xy_gain
        else:
            loud = self._bank_gain[slot] if slot < len(self._bank_gain) else 1.0
        state.update(
            active=True, releasing=False, gain=1.0, gain_step=0.0,
            trim=trim, midi=note, timbre=slot, xy=xy,
            # 起音直接落到目标增益：这一刻没有「上一个音色」，不需要过渡
            loud=loud, loud_target=loud,
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
        if state["releasing"]:
            return
        import torch

        # 无约束 PCA 漫游优先级最高：它是显式的实验模式，给了就以它为准。
        coeffs = getattr(voice, "timbre_pca", None)
        if coeffs is not None:
            key = tuple(round(float(c), 4) for c in coeffs)
            if key == state.get("pca"):
                return
            latent = self.latent_from_pca(coeffs)
            if latent is None:
                return
            stream = self._voices[row]
            stream.timbre_rate_per_second = XY_RATE_PER_SECOND
            stream.set_timbre_target(torch.from_numpy(latent).view(1, -1))
            state["pca"] = key
            # 无约束模式下没有逐点标定的响度可用，退回最近锚点近似。
            # 残差会比 kNN 模式大 —— 这是这条路线的已知代价之一。
            state["loud_target"] = self._nearest_anchor_gain(latent)
            return

        # XY 直控优先于锚点槽位：槽位只是地图上的九个路标，XY 是任意位置。
        xy = getattr(voice, "timbre_xy", None)
        if xy is not None:
            k = int(getattr(voice, "timbre_k", LATENT_MAP_K))
            if xy == state.get("xy") and k == state.get("k"):
                return
            result = self.latent_from_xy(xy[0], xy[1], getattr(voice, 'timbre_k', LATENT_MAP_K))
            if result is None:
                return
            latent, gain = result
            stream = self._voices[row]
            stream.timbre_rate_per_second = XY_RATE_PER_SECOND
            stream.set_timbre_target(torch.from_numpy(latent).view(1, -1))
            state["xy"] = xy
            state["k"] = k
            state["loud_target"] = gain
            return

        slot = int(voice.timbre) % len(self._bank)
        if slot == state["timbre"]:
            return
        stream = self._voices[row]
        # 回到锚点模式 = 回到「自动漫游」的慢速，那是听音色连续变形用的
        stream.timbre_rate_per_second = self._roam_step / NOMINAL_NOTE_SECONDS
        stream.set_timbre_target(torch.from_numpy(self._bank[slot]).view(1, -1))
        state["timbre"] = slot
        state["xy"] = None
        # 增益跟着音色一起走。若瞬间切换，漫游过程中会听到音量台阶 ——
        # 那正是「响度差异」被误当成「音色变化」的来源。
        state["loud_target"] = self._bank_gain[slot] if slot < len(self._bank_gain) else 1.0

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
            # 响度增益逐块指数趋近目标。时间常数取 ~0.35 s，比漫游(4–6 s)快得多，
            # 所以增益不会滞后于音色；又足够慢，不会在块边界产生可闻台阶。
            start_loud = state["loud"]
            end_loud = start_loud + (state["loud_target"] - start_loud) * LOUDNESS_SMOOTH
            state["loud"] = end_loud
            loud_ramp = np.linspace(start_loud, end_loud, n_samples,
                                    endpoint=False, dtype=np.float32)
            out += block * state["trim"] * loud_ramp
        out *= OUTPUT_TRIM
        # 软限幅：阈值以下完全线性（不碰动态），以上用 tanh 拐点。
        # 硬 clip 会产生刺耳的高次谐波，这个拐点听不出来。
        over = np.abs(out) > SOFT_LIMIT
        if over.any():
            sign = np.sign(out[over])
            excess = (np.abs(out[over]) - SOFT_LIMIT) / (1.0 - SOFT_LIMIT)
            out[over] = sign * (SOFT_LIMIT + (1.0 - SOFT_LIMIT) * np.tanh(excess))
        return out

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
            "timbreGains": [round(g, 4) for g in self._bank_gain],
            "pcaRoam": {
                "available": self._pca_basis is not None,
                "dims": 0 if self._pca_basis is None else int(self._pca_basis.shape[0]),
                "ranges": self._pca_ranges,
                "note": "无约束子空间漫游，不做 kNN；可能落到流形外",
            },
            "latentMap": {
                "available": self._map_xy is not None,
                "points": 0 if self._map_xy is None else int(len(self._map_xy)),
                "k": LATENT_MAP_K,
            },
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
