"""B2 档：四音色 midiBrave v2 后端——每一行绑定一个专用 checkpoint。

与 ``brave.BraveBackend``（v1，单一共享模型 + atlas/latent_map 做 XY 音色漫游）
的根本区别：这里**没有共享模型**，四行各自加载自己的 checkpoint
（pad/bass/lead/pluck），彼此独立、互不影响。**每一行有自己独立的漫游地图**
（``assets/timbre/voice_maps/{voice}.json``，256D，2026-07-21 建）——v1 的
128D atlas/latent_map 是全语料共享的一张图，这里是每个 checkpoint 各一张，
互不通用（维度都不一样）。地图取自该 checkpoint 训练集里实际用过的 50 个
preset（不是全语料随便挑的，越界即分布外），XY 直控与 v1 同样走 kNN 混合，
不做反投影（见 ``latent_from_xy``）。

XY 直控既服务人工拖拽也服务 agent 程序化控制——两者走同一条协议
（``timbreXY`` 字段），后端不区分调用方是谁，PRD 的「一轨人控、其余
agent 控」完全靠前端/上层决定发不发这个字段，不在这一层做区分。

行→音色绑定（与 ``synth.py`` 的 ``TIMBRE_NAMES`` 同序，同一个约定用到底）：

    row 0 → bass
    row 1 → pad     （和弦主行——单独一行不发声时代表"最新一个音"）
    row 2 → lead
    row 3 → pluck
    row 4 → pad     （和弦增补行，2026-07-21 起）
    row 5 → pad
    row 6 → pad

**pad 和弦（2026-07-21）**：pad 在 ``ROW_VOICES`` 里出现 4 次（行 1/4/5/6），
不是 4 个不同 checkpoint——``_SHARED_VOICE_MODELS`` 按音色名缓存，4 行背后是
同一个已加载的 pad 模型实例，互不增加显存/加载时间，只各自多一份轻量的
``StreamingVoice`` 跨块状态。这样"一个 voice 池行 = 单音、last-note-priority"
的硬约束（protocol.md §6）没有被打破——和弦不是靠单行塞进多个音高，是靠
**4 个独立单音行同时持有各自的音**拼出来的。旧行号 0/1/2/3 的绑定不变，
新增的 4/5/6 只是追加在末尾，不影响任何写死了 bass=0/pad=1/lead=2/pluck=3
的既有代码（前端 voiceEngine.species 配置、client-integration.md 里的说明）。

哪些行属于同一个音色，运行期从 ``info()`` 的 ``rowsBySpecies`` 读，
不要在调用方写死 ``[1,4,5,6]`` 这种字面量——见 ``info()`` 的说明。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from .base import AudioBackend
from .brave import (
    LOUDNESS_SMOOTH,
    OUTPUT_TRIM,
    SOFT_LIMIT,
    TRAIN_NOTE_MAX,
    TRAIN_NOTE_MIN,
    XY_RATE_PER_SECOND,
    BraveBackend,
)
from .midibrave_backend_v2 import PENDING_VOICES, MidiBraveBackendV2
from .trajectorybrave_pad import TrajectoryVoice, get_shared_trajectorybrave_pad

#: 行→音色，与 synth.py TIMBRE_NAMES 同序。四音色都必须齐；pad 额外占 3 行做
#: 和弦（见模块 docstring），pool_size 固定为 len(ROW_VOICES) = 7。
ROW_VOICES: tuple[str, ...] = ("bass", "pad", "lead", "pluck", "pad", "pad", "pad")

DEFAULT_TIMBRE_DIR = Path(__file__).resolve().parents[2] / "assets" / "timbre" / "voice_defaults"
VOICE_MAP_DIR = Path(__file__).resolve().parents[2] / "assets" / "timbre" / "voice_maps"
#: XY 直控的 kNN 邻居数默认值，与 v1 brave.py 的 LATENT_MAP_K 同一套取舍
#: （太小稀疏区会跳变，太大会把一片区域糊成平均音色）。50 点的地图比 v1
#: 1239 点稀疏得多，默认给小一点。
VOICE_MAP_DEFAULT_K = 4

#: 进程级共享的已加载模型，按音色名缓存——理由与 v1 的 _SHARED_MODELS 相同：
#: 每个 WS 连接都各自 torch.load 一次会在 Spark 上很快耗尽可用内存，
#: 且加载期间没有音频流出会触发客户端重连→再加载一次的死循环（见 R10）。
#: 四个音色权重只读，跨会话共享安全。
_SHARED_VOICE_MODELS: dict[str, MidiBraveBackendV2] = {}

#: 单点响度粗标定的目标 RMS。不是 calibrate_loudness.py 那种多点 K 加权标定
#: （那是离线对 1239 个 preset 各渲一遍才做得起），这里只是防止四个不同模型
#: 天然响度差太多导致某轨明显比别的轨响/轻——已知是粗糙近似，见 §11 待确认。
_LOUDNESS_TARGET_RMS = 0.08
_LOUDNESS_GAIN_MIN = 0.15
_LOUDNESS_GAIN_MAX = 6.0


class MultiVoiceBraveBackend(AudioBackend):
    """B2 档：四行绑定四个独立 checkpoint。"""

    backend_id = "brave-voices"
    supports_split = True

    def __init__(
        self,
        sample_rate: int = 44_100,
        pool_size: int = 4,
        block_samples: int = 2048,
        model_path: str | None = None,
        device: str = "cpu",
    ) -> None:
        super().__init__(sample_rate, pool_size, block_samples)
        if model_path is not None:
            print(
                f"[brave-voices] model_path 对本后端无效（四音色各自固定 "
                f"checkpoint，见 VOICE_CHECKPOINTS），忽略传入值: {model_path}",
                flush=True,
            )
        if pool_size != len(ROW_VOICES):
            raise ValueError(
                f"brave-voices 要求 pool_size == {len(ROW_VOICES)}"
                f"（四音色各占一行：{ROW_VOICES}），收到 {pool_size}"
            )
        self.device = device
        self._backends: list[MidiBraveBackendV2] = []
        self._voices: list = []       # 每行一个 StreamingVoice，绑定各自的 backend
        self._row_state: list[dict] = []
        self._default_z: list[np.ndarray] = []
        self._row_gain: list[float] = []
        self._maps: list[dict | None] = []   # 每行一张漫游地图（缺失则该行不可漫游）
        #: 每行一个持久 CUDA stream，CPU 设备下留 None（见 render_split）。
        #: 常驻、跨块复用——每块都新建 stream 有额外开销，没必要。
        self._streams: list[Any] | None = None

    # ---- 生命周期 ---------------------------------------------------------
    def load(self) -> None:
        if self.loaded:
            return
        import torch

        from .streaming import StreamingVoice

        if self.sample_rate != 44_100:
            raise ValueError(f"midiBrave 固定 44.1 kHz，收到 {self.sample_rate}")

        for voice_name in ROW_VOICES:
            if voice_name == "pad":
                # pad 换了发声引擎（TrajectoryBrave，见 trajectorybrave_pad.py
                # 模块 docstring）——不是 MidiBraveBackendV2，checkpoint/config/
                # 校验方式都不同，单独走一条加载路径。四行（1/4/5/6）都命中
                # 同一个共享实例，跟其余音色共享模型的做法一致。
                backend = get_shared_trajectorybrave_pad(device=self.device)
                meta = backend.checkpoint_meta
                print(f"[brave-voices] pad 使用 TrajectoryBrave 引擎（step="
                      f"{meta.get('step')}, sha256={meta.get('sha256', '')[:12]}…）",
                      flush=True)
                self._backends.append(backend)
                continue
            # 设备进 cache key —— 理由同 brave.py：同一个音色不该在 cpu 请求时
            # 复用到 cuda 上已加载的实例（反之亦然）。
            cache_key = f"{voice_name}@{self.device}"
            shared = _SHARED_VOICE_MODELS.get(cache_key)
            if shared is None:
                shared = MidiBraveBackendV2(voice_name, device=self.device, verify_hashes=True)
                _SHARED_VOICE_MODELS[cache_key] = shared
                print(f"[brave-voices] {voice_name} 已加载并缓存: {shared.describe()}", flush=True)
            else:
                print(f"[brave-voices] {voice_name} 复用已加载的模型（跨会话共享权重）", flush=True)
            self._backends.append(shared)

        geom = self._backends[0].geometry
        if self.block_samples % geom.samples_per_latent:
            raise ValueError(
                f"block_samples 必须是 {geom.samples_per_latent} 的整数倍，"
                f"收到 {self.block_samples}"
            )

        self._default_z = [self._load_default_timbre(name, backend, torch)
                            for name, backend in zip(ROW_VOICES, self._backends)]
        self._row_gain = [self._calibrate_gain(row, torch) for row in range(len(ROW_VOICES))]
        self._maps = [self._load_voice_map(name) for name in ROW_VOICES]

        self._voices = [
            TrajectoryVoice(self._backends[row], block_samples=self.block_samples)
            if ROW_VOICES[row] == "pad"
            else StreamingVoice(self._backends[row])
            for row in range(self.pool_size)
        ]
        self._row_state = [self._blank_row() for _ in range(self.pool_size)]

        # 每行一个持久 stream：render_split 靠这个把本来纯串行的逐行前向
        # 尽量并发地发给 GPU（各行跨块状态互相独立、模型权重推理期只读，
        # 并发没有数据竞争，见 render_split 的注释）。CPU 设备没有这个机制，
        # 留 None，render_split 走原来的纯串行分支，行为完全不变。
        if torch.device(self.device).type == "cuda":
            self._streams = [torch.cuda.Stream() for _ in range(self.pool_size)]

        self.loaded = True

    def _load_default_timbre(self, voice_name: str, backend: MidiBraveBackendV2, torch) -> np.ndarray:
        """从该音色训练集里的真实 preset 取一条 CLAP embedding，过它自己的
        timbre.net 得到 256D z_timbre。**不是零向量**——零向量是分布外的
        CLAP 输入，会让 timbre.net 落在训练时从没见过的角落。

        .npy 来源：2026-07-20 从 Octopus
        /data/midibrave-v2/cache/top50/{voice}/clap/ 拉取，已用该音色自己的
        CLAP 模型算好、L2 归一化过；预设本身来自该 checkpoint 元数据里
        difficulty_ema 记录的、这个音色真实训练过的 preset。
        """
        if voice_name == "pad":
            # TrajectoryBrave 没有 CLAP 概念——默认音色是它自己 anchor 表里
            # 离质心最近的真实 preset（见 trajectorybrave_pad.py 的
            # TrajectoryBravePadBackend.__init__），不走下面 CLAP 那条路。
            return backend.default_control_coordinate.copy()
        npy_path = DEFAULT_TIMBRE_DIR / f"{voice_name}.npy"
        if not npy_path.is_file():
            raise FileNotFoundError(
                f"缺默认音色向量: {npy_path}（每个音色需要一条训练集内真实 "
                f"preset 的 CLAP embedding，不能用零向量兜底）"
            )
        clap = np.load(npy_path)
        with torch.no_grad():
            z = backend.timbre_from_clap(clap)
        return z.cpu().numpy()[0]

    def _calibrate_gain(self, row: int, torch) -> float:
        """单点响度粗标定：渲染一个参考音，量 RMS，算增益让四轨大致齐平。

        不是 calibrate_loudness.py 那种多点 K 加权标定（那需要对每个音色的
        整个训练集渲染采样，是单独的工作量）——这里只用默认音色单点近似，
        目的是不让某条轨道明显比别的响或轻，不是精确响度匹配。
        """
        backend = self._backends[row]
        z = torch.from_numpy(self._default_z[row]).view(1, -1)
        try:
            wav = backend.render_note(z, note=60, velocity=127, duration_seconds=0.6)
        except Exception as error:  # noqa: BLE001 — 标定失败不该拖垮加载，退化成不补偿
            print(f"[brave-voices] {ROW_VOICES[row]} 响度标定失败，退化为增益 1.0: "
                  f"{type(error).__name__}: {error}", flush=True)
            return 1.0
        rms = float(np.sqrt(np.mean(np.square(wav, dtype=np.float64))))
        if rms < 1e-6:
            return 1.0
        gain = _LOUDNESS_TARGET_RMS / rms
        return float(np.clip(gain, _LOUDNESS_GAIN_MIN, _LOUDNESS_GAIN_MAX))

    def _load_voice_map(self, voice_name: str) -> dict | None:
        """载入该音色自己的漫游地图。缺失不致命——该行退化为固定音色
        （沿用 _default_z），其余行不受影响。

        ``tools/build_voice_maps.py`` 产出的 schema：50 个训练集内真实
        preset 的 (x, y, gain) + 对应 256D z_timbre，布局方法（pca/tsne）
        按该音色自己 50 点的方差分布挑，不是抄 v1 的结论。
        """
        path = VOICE_MAP_DIR / f"{voice_name}.json"
        if not path.is_file():
            print(f"[brave-voices] {voice_name} 无漫游地图（{path.name} 缺失），"
                  f"该行固定音色不可漫游", flush=True)
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        points = data.get("points") or []
        if not points:
            return None
        xy = np.asarray([[p["x"], p["y"]] for p in points], dtype=np.float32)
        z = np.asarray(data["z"], dtype=np.float32)
        gain = np.asarray([p.get("gain", 1.0) for p in points], dtype=np.float32)
        print(f"[brave-voices] {voice_name} 漫游地图: {len(points)} 点，"
              f"布局={data.get('layout')}，checkpoint step={data.get('checkpointStep')}", flush=True)
        pca = data.get("pca_basis")
        pca_basis = None
        if pca:
            pca_basis = {
                "mean": np.asarray(pca["mean"], dtype=np.float32),
                "basis": np.asarray(pca["basis"], dtype=np.float32),
                "dims": int(pca.get("dims", len(pca["basis"]))),
                "ranges": pca.get("ranges"),
                "explained_total": pca.get("explained_total"),
            }
            print(f"[brave-voices] {voice_name} PCA 子空间: {pca_basis['dims']} 维，"
                  f"累计解释方差 {float(pca_basis['explained_total'] or 0) * 100:.1f}%"
                  f"（语料只有 {len(points)} 个 preset，比 v1 的 1239 个薄很多，"
                  f"数字仅供参考，别当成稳健统计量）", flush=True)
        return {"xy": xy, "z": z, "gain": gain, "scale": float(data.get("scale", 1.0)),
                "layout": data.get("layout"), "count": len(points), "pca": pca_basis}

    def latent_from_xy(
        self, row: int, x: float, y: float, k: int = VOICE_MAP_DEFAULT_K,
    ) -> tuple[np.ndarray, float] | None:
        """平面坐标 → 该行自己的 z_timbre，kNN 距离加权混合真实 preset。

        与 v1 ``BraveBackend.latent_from_xy`` 同一套取舍：**不做反投影**
        （50 点更稀疏，反投影落到流形外的风险比 v1 的 1239 点更高），
        混合永远落在该音色真实 preset 的凸包内；代价是稀疏区会「黏」在
        最近的几个点上，不是平滑过渡——这是真实性质，不用插值假装抹平。
        """
        m = self._maps[row]
        if m is None:
            return None
        query = np.asarray([x, y], dtype=np.float32)
        distances = np.linalg.norm(m["xy"] - query, axis=1)
        k = max(1, min(int(k), len(distances)))
        idx = np.argpartition(distances, k - 1)[:k]
        local = distances[idx]
        weights = 1.0 / np.square(local + 0.02)
        weights = (weights / max(float(weights.sum()), 1e-9)).astype(np.float32)
        latent = (m["z"][idx].T @ weights).astype(np.float32)
        gain = float(m["gain"][idx] @ weights)
        return latent, gain

    def latent_from_pca(self, row: int, coeffs) -> np.ndarray | None:
        """该行自己的 PCA 子空间系数 → z_timbre。**无约束合成，不做 kNN。**

            z = mean + Σ coeff[i] * basis[i]

        与 ``latent_from_xy`` 的取舍完全相反，跟 v1 ``BraveBackend.latent_from_pca``
        同一套论证（见 docs/latent-map.md「为什么不做 XY → 反投影」、
        tools/build_pca_basis.py 模块 docstring）：

        * kNN 混合真实 preset —— 安全（永远在凸包内），但稀疏区会「黏」。
        * PCA 子空间自由漫游 —— 连续、无黏滞，但**不保证落在流形上**，
          子空间里的点可能落在流形外，听感上是失真、怪音、或不发声。

        v2 每行的 PCA 基是从该行自己的漫游地图语料算的（~31–45 个 preset，
        见 ``_load_voice_map`` 加载时打的日志）——比 v1 算基用的 1239 个薄
        很多，"前 N 维解释多少方差"这类数字在这么小的语料上没有 v1 那么
        可信，子空间本身也更可能是对这几十个点的过拟合方向，不是真正的
        全局主轴。这是已知局限，不是要不要做的问题——用户已经决定要做。

        z_timbre 是 Tanh 输出，落在 [-1,1]^256（v2 是 256 维，不是 v1 的 128）；
        这里仍然 clamp 一次，越界即分布外，硬拉回来至少不会喂给 decoder 一个
        它没见过的量级。
        """
        m = self._maps[row]
        pca = m["pca"] if m else None
        if pca is None:
            return None
        n = pca["basis"].shape[0]
        vector = np.zeros(n, dtype=np.float32)
        for index in range(min(n, len(coeffs))):
            vector[index] = float(coeffs[index])
        latent = pca["mean"] + vector @ pca["basis"]
        return np.clip(latent, -1.0, 1.0).astype(np.float32)

    def _nearest_map_gain(self, row: int, latent: np.ndarray) -> float:
        """按 z 距离取该行漫游地图上最近真实 preset 的响度增益。

        PCA 子空间的点没有逐点标定的响度可用（那需要真的渲染才能测 RMS），
        用最近邻近似——跟 v1 ``_nearest_anchor_gain`` 同一套取舍，误差比
        完全不做归一化好。
        """
        m = self._maps[row]
        if m is None or not len(m["z"]):
            return 1.0
        distances = np.linalg.norm(m["z"] - latent.reshape(1, -1), axis=1)
        return float(m["gain"][int(np.argmin(distances))])

    def _blank_row(self) -> dict:
        return {
            "active": False,
            "releasing": False,
            "gain": 0.0,
            "gain_step": 0.0,
            "trim": 1.0,
            "xy": None,          # 上次同步过的 timbre_xy，用来判断"变了没有"
            "k": None,
            "pca": None,         # 上次同步过的 timbre_pca 系数（四舍五入过的 key）
            "loud": 1.0,         # 响度增益当前值，逐块平滑趋近 loud_target
            "loud_target": 1.0,
        }

    def close(self) -> None:
        """只释放本会话的状态。**不销毁共享模型**——见 _SHARED_VOICE_MODELS 的说明。

        显式同步 + 释放本会话的 CUDA stream 引用,不能指望 Python GC 及时
        回收——`self` 有闭包/引用环时收集时机不确定,stream 句柄可能悬空到
        下一条连接创建新 stream 时才被摊上账(2026-07-22:第三条连接开始
        握手永久卡死,重启才能恢复,疑似与此有关)。这里的 synchronize() 只
        等*本会话*的 stream 排空,不影响共享模型或其它会话。
        """
        if self._streams:
            for stream in self._streams:
                stream.synchronize()
            self._streams = None
        self._voices = []
        self._row_state = []
        self.loaded = False

    def reset(self) -> None:
        for voice in self._voices:
            # StreamingVoice.note_off() 本身就是立即清状态（本模型没有 release
            # 分支）；TrajectoryVoice 的 note_off() 是走 LiveRenderer 的自然
            # release（2.4s 尾音，正常松键要这个），会话重建要的是立即静音，
            # 所以这里有 panic() 就用 panic()，没有就退回 note_off()。
            panic = getattr(voice, "panic", None)
            (panic if panic is not None else voice.note_off)()
        self._row_state = [self._blank_row() for _ in range(self.pool_size)]

    # ---- 事件钩子 -----------------------------------------------------------
    def note_on(self, voice) -> None:
        if not self.loaded:
            return
        import torch

        row = int(voice.row)
        state = self._row_state[row]
        backend = self._backends[row]

        note = int(round(float(voice.midi)))
        if not TRAIN_NOTE_MIN <= note <= TRAIN_NOTE_MAX:
            note = max(TRAIN_NOTE_MIN, min(TRAIN_NOTE_MAX, note))
        velocity, trim = BraveBackend._quantize_velocity(float(voice.velocity))

        # 随机激励缓冲必须先于 note_on（note_on 内部的 warmup 渲染就会
        # 开始消费它），按本音的声明时长精确生成——见 midibrave_backend_v2
        # 模块 docstring 里「分块调用不等于整段调用切片」的说明。
        # 时长要含 release 尾巴：自然到期的音在 remaining 归零后还会按
        # release_seconds 边衰减边渲染，缓冲不含尾巴的话 release 中段就会
        # 越界（2026-07-21 事故）。excitation_bands 里还有末帧冻结兜底，
        # 这里只是把最常见的路径覆盖回到真实缓冲上。
        duration = float(getattr(voice, "duration_seconds", 1.0)) + float(
            getattr(voice, "release_seconds", 0.4)
        )
        backend.prepare_note_stochastic(duration)

        # XY/PCA 直控时起音必须直接落在对应的 z 上——若仍从默认音色起音再漫游
        # 过去，每按一个新音都会把音色拉回默认点，拖动地图听起来「几乎没变化」
        # （这条经验来自 v1 的同一个坑，见 brave.py note_on 的同名注释）。
        # 无约束 PCA 漫游优先级最高——它是显式的实验模式，给了就以它为准
        # （与 v1 BraveBackend.note_on 同一优先级约定）。
        pca_coeffs = getattr(voice, "timbre_pca", None)
        pca_latent = self.latent_from_pca(row, pca_coeffs) if pca_coeffs is not None else None
        xy = getattr(voice, "timbre_xy", None)
        xy_result = (self.latent_from_xy(row, xy[0], xy[1], getattr(voice, "timbre_k", VOICE_MAP_DEFAULT_K))
                     if (xy is not None and pca_latent is None) else None)
        if pca_latent is not None:
            z = torch.from_numpy(pca_latent).view(1, -1)
            loud = self._nearest_map_gain(row, pca_latent)
        elif xy_result is not None:
            latent, loud = xy_result
            z = torch.from_numpy(latent).view(1, -1)
        else:
            z = torch.from_numpy(self._default_z[row]).view(1, -1)
            loud = 1.0

        self._voices[row].note_on(z, note, velocity)
        state.update(
            active=True, releasing=False, gain=1.0, gain_step=0.0,
            trim=trim * self._row_gain[row],
            xy=xy, k=getattr(voice, "timbre_k", VOICE_MAP_DEFAULT_K),
            pca=tuple(round(float(c), 4) for c in pca_coeffs) if pca_coeffs is not None else None,
            loud=loud, loud_target=loud,   # 起音这一刻没有"上一个音色"，不需要过渡
        )

    def _sync_timbre(self, voice, row: int, state: dict) -> None:
        """把 ``voice.timbre_xy``/``timbre_pca`` 的变化翻译成漫游目标（连续
        移动，不重起音）。逻辑跟 v1 ``BraveBackend._sync_timbre`` 对应，
        PCA 优先级最高，同一套取舍见 ``note_on`` 的注释。
        """
        if state["releasing"] or self._maps[row] is None:
            return
        import torch

        pca_coeffs = getattr(voice, "timbre_pca", None)
        if pca_coeffs is not None:
            key = tuple(round(float(c), 4) for c in pca_coeffs)
            if key == state.get("pca"):
                return
            latent = self.latent_from_pca(row, pca_coeffs)
            if latent is None:
                return
            stream = self._voices[row]
            stream.timbre_rate_per_second = XY_RATE_PER_SECOND
            stream.set_timbre_target(torch.from_numpy(latent).view(1, -1))
            state["pca"] = key
            state["loud_target"] = self._nearest_map_gain(row, latent)
            return

        xy = getattr(voice, "timbre_xy", None)
        if xy is None:
            return
        k = int(getattr(voice, "timbre_k", VOICE_MAP_DEFAULT_K))
        if xy == state.get("xy") and k == state.get("k"):
            return
        result = self.latent_from_xy(row, xy[0], xy[1], k)
        if result is None:
            return
        latent, gain = result
        stream = self._voices[row]
        stream.timbre_rate_per_second = XY_RATE_PER_SECOND
        stream.set_timbre_target(torch.from_numpy(latent).view(1, -1))
        state["xy"] = xy
        state["k"] = k
        state["loud_target"] = gain

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

    # ---- 渲染 -----------------------------------------------------------
    @staticmethod
    def _soft_limit(out: np.ndarray) -> np.ndarray:
        """安全网，不是音乐处理——理由与 brave.py 的同名逻辑相同。分轨施加，
        因为求和点在前端，这里看不到四轨叠加后的总电平。"""
        over = np.abs(out) > SOFT_LIMIT
        if over.any():
            sign = np.sign(out[over])
            excess = (np.abs(out[over]) - SOFT_LIMIT) / (1.0 - SOFT_LIMIT)
            out[over] = sign * (SOFT_LIMIT + (1.0 - SOFT_LIMIT) * np.tanh(excess))
        return out

    def render_split(self, voices: Sequence, n_samples: int) -> np.ndarray:
        out = np.zeros((self.pool_size, n_samples), dtype=np.float32)
        if not self.loaded:
            return out

        active: list[tuple[int, dict]] = []
        for voice in voices:
            row = int(voice.row)
            state = self._row_state[row]
            if not state["active"]:
                continue
            self._sync_timbre(voice, row, state)
            active.append((row, state))
        if not active:
            return out

        blocks: dict[int, np.ndarray] = {}
        if self._streams is not None:
            import torch

            # pad 现在是 TrajectoryBrave 引擎（trajectorybrave_pad.py），它的
            # LiveRenderer.render_block() 内部自己做 torch.cuda.synchronize()
            # （vendor 的 demo/live.py），没法参与下面"全部发完再一次 synchronize"
            # 的跨行并发——天然顺序执行，不能塞进同一个 stream 分发循环。
            stream_active = [(row, s) for row, s in active if ROW_VOICES[row] != "pad"]
            sequential_active = [(row, s) for row, s in active if ROW_VOICES[row] == "pad"]

            # 跨行 CUDA stream 并行：原来是纯串行 for 循环，逐行前向 + 逐行
            # .cpu() 同步——.cpu() 本身就是同步点，等于强迫 GPU 一行一行来，
            # 哪怕它们互不依赖。各行跨块状态（state.*_cache / z_current /
            # sample_pos，见 streaming.py 的 _VoiceState）完全独立，模型权重
            # 推理期只读不写（@torch.no_grad()），并发没有数据竞争——包括
            # pad 和弦那 4 行共用同一个模型实例的情况，读同一份权重是安全的。
            # 先把全部行的前向发出去（每行发到自己的 stream，不等），
            # 再一次性 synchronize，最后统一拷回 CPU——这样 GPU 才有机会
            # 真的并发跑，而不是"发一行、等一行、发下一行"。
            tensors: dict[int, Any] = {}
            for row, _state in stream_active:
                with torch.cuda.stream(self._streams[row]):
                    tensors[row] = self._voices[row].render_block_tensor(n_samples)
            torch.cuda.synchronize()
            for row, _state in stream_active:
                tensor = tensors[row]
                blocks[row] = tensor.squeeze(0).squeeze(0).cpu().numpy().astype(np.float32)

            # pad 的 4 行顺序渲染，各自 ~6-9ms（jyhu 的 GPU 门禁实测数字），
            # 4 行合计约 24-36ms，block_samples=2048/44.1kHz=46.44ms 预算内
            # 有余量，但比单行紧——N 路批量解码（LiveRenderer.render_pair_block
            # 的思路推广到 4 路）是已知的后续优化方向，这次不做，先用测试
            # 脚本量实测延迟（tools/test_trajectorybrave_pad.py）确认够不够。
            for row, _state in sequential_active:
                blocks[row] = self._voices[row].render_block(n_samples)
        else:
            for row, _state in active:
                blocks[row] = self._voices[row].render_block(n_samples)

        for row, state in active:
            block = blocks[row]
            if state["releasing"]:
                start = state["gain"]
                end = max(0.0, start - state["gain_step"])
                ramp = np.linspace(start, end, n_samples, endpoint=False, dtype=np.float32)
                block = block * ramp
                state["gain"] = end
                if end <= 1e-5:
                    self._voices[row].note_off()
                    self._row_state[row] = self._blank_row()
                    continue
            # 响度增益逐块指数趋近目标，时间常数与 v1 相同（0.35 s 量级，
            # 比漫游限速快、比块长慢，见 brave.py 同名注释）。
            start_loud = state["loud"]
            end_loud = start_loud + (state["loud_target"] - start_loud) * LOUDNESS_SMOOTH
            state["loud"] = end_loud
            loud_ramp = np.linspace(start_loud, end_loud, n_samples,
                                    endpoint=False, dtype=np.float32)
            out[row] = block * state["trim"] * loud_ramp
        out *= OUTPUT_TRIM
        for row in range(self.pool_size):
            self._soft_limit(out[row])
        return out

    def render_block(self, voices: Sequence, n_samples: int) -> np.ndarray:
        """混合模式：分轨结果求和成 mono，求和后再走一次软限幅。"""
        return self._soft_limit(self.render_split(voices, n_samples).sum(0))

    # ---- 自述 -------------------------------------------------------------
    def info(self) -> dict[str, Any]:
        # rowsBySpecies：某个音色占了哪些行，按 ROW_VOICES 里的出现顺序。
        # pad 和弦增补行（见模块 docstring）跟主行共用同一个已加载模型实例，
        # 调用方要知道"pad 一共有几行能同时发声"就读这个，别写死 [1,4,5,6]。
        rows_by_species: dict[str, list[int]] = {}
        for row, name in enumerate(ROW_VOICES):
            rows_by_species.setdefault(name, []).append(row)

        # voices：每个音色名字只出一条——第一次出现的那一行（bass/pad/lead/pluck
        # 原来的主行 0/1/2/3），同名的增补行（pad 的 4/5/6）不在这里重复出现，
        # 它们的 checkpoint/漫游地图跟主行完全一样（同一个共享模型实例），
        # 要看"这个音色一共几行"用上面的 rowsBySpecies，不是这个字典的 key 数。
        voices_meta = {}
        for row, name in enumerate(ROW_VOICES):
            if row >= len(self._backends) or name in voices_meta:
                continue
            backend = self._backends[row]
            meta = backend.checkpoint_meta
            m = self._maps[row] if row < len(self._maps) else None
            pca = m.get("pca") if m else None
            voices_meta[name] = {
                "row": row,
                "step": meta.get("step"),
                "configHash": meta.get("config_hash"),
                "engine": "trajectorybrave-v1" if name == "pad" else "midibrave-v2",
                "gain": round(self._row_gain[row], 4) if self._row_gain else None,
                "roam": {
                    "available": m is not None,
                    "points": m["count"] if m else 0,
                    "layout": m["layout"] if m else None,
                    "scale": m["scale"] if m else None,
                    "asset": f"/assets/timbre/voice_maps/{name}.json" if m else None,
                    "defaultK": VOICE_MAP_DEFAULT_K,
                    # 无约束 PCA 子空间漫游（timbrePCA 字段）——不保证落在流形上，
                    # 语料只有 points 个真实 preset（远比 v1 的 1239 薄），
                    # explainedTotal 这类数字仅供参考。available=false 时前端
                    # 不该出现 PCA 滑杆，回落到 XY-only。
                    "pca": {
                        "available": True,
                        "dims": pca["dims"],
                        "ranges": pca["ranges"],
                        "explainedTotal": pca["explained_total"],
                    } if pca else {"available": False, "dims": 0},
                } if m else {"available": False, "points": 0},
            }
        return {
            **self.base_info(),
            "engine": "midibrave-v2-voices",
            "latentSize": 256,
            "rowVoices": list(ROW_VOICES),
            "rowsBySpecies": rows_by_species,
            "voices": voices_meta,
            "noteRange": [TRAIN_NOTE_MIN, TRAIN_NOTE_MAX],
            # 每行独立地图，不是全局一张——具体到某一行有没有见 voices[name].roam。
            "roamSupported": all(m is not None for m in self._maps) if self._maps else False,
            "pendingVoices": list(PENDING_VOICES),  # 有 config 但还没有 checkpoint（如 texture）
        }
