"""TrajectoryBrave pad v1 后端——只换 pad 的发声引擎，不改协议、不改和弦逻辑。

当前 ``ROW_VOICES`` 是 bass/pad/lead/pluck/pad，pad 占 2 行（1/4）做和弦（见
``brave_voices.py`` 模块 docstring「pad 和弦」一节）。``timbre_xy``/``timbre_k``/
``timbre_pca`` 走的仍是 ``MultiVoiceBraveBackend.latent_from_xy``/``latent_from_pca``——
那两个函数本来就不认维度，只吃 ``voice_maps/pad.json`` 里存的 ``z`` 数组，所以只要
建一张新的 8D 地图（``tools/build_pad_trajectorybrave_map.py``），协议/前端/漫游
全部不用碰。

跟 ``MidiBraveBackendV2`` 的关键差异：这个模型不是「逐块因果卷积流式」
（``streaming.py`` 那一套），而是每块都用一个 ``[warmup+block+tail]`` 的滑动窗口
重新跑一次完整前向（vendor 的 ``trajectorybrave.demo.live.LiveRenderer``），自己管理
note 生命周期（pre_roll/gate/release）和音色平滑（内建约 100ms 时间常数）。
历史 2048 配置的 Spark GPU 独立审计记录为 46.44ms 块预算内 6–9ms 渲染、10 分钟 WS
soak 零 NaN/Inf（见 ``TrajectoryBrave_Boids_Spark_测试结果.md``）；这不是当前生产
4096 配置的门禁结果。所以这里不重新实现流式因果缓存，
而是给 ``LiveRenderer`` 包一层跟 ``StreamingVoice`` 同名方法的薄适配器
（``TrajectoryVoice``），``brave_voices.py`` 的调用代码几乎不用分支。

vendor 来源的坑：checkpoint 是按 Spark 上部署的旧版 ``model.py`` 训练/加载的，
跟 TrajectoryBrave 项目本身的最新开发树已经不是同一版本（新开发树加了
velocity-conditioned expander 等参数形状变化——见交接文档
``TrajectoryBrave_Pad_V1_模型与Spark测试页面交接说明.md`` §8.1）。
``vendor/trajectorybrave/`` 必须来自跑在 Spark 上那个容器
（``jyhu-trajectorybrave-demo``）里 ``/opt/trajectorybrave/src/trajectorybrave/``
的实际文件（``model.py`` sha256 ``dfacc5b1…``），不能直接抄 TrajectoryBrave 项目的
开发树——那会 state_dict 缺失/多出/shape mismatch，而且未必报错（"形状兼容"不等于
"行为正确"，同样的坑 ``midibrave_backend_v2.py`` 模块 docstring 也踩过一次）。

note 范围的坑：本仓库其余音色统一用 ``brave.TRAIN_NOTE_MIN``/``TRAIN_NOTE_MAX``
（21–109，见 ``brave_voices.py`` 的 ``note_on``），但这个 checkpoint 只在 MIDI
36–71 上训练，``LiveRenderer.start()`` 对越界 note 直接 ``raise ValueError``——
不在这层单独 clamp 的话，越界音会在 ``note_on`` 内部炸出未捕获异常，顺着
``world.on('perch')`` 一路炸穿渲染循环（这个仓库刚踩过一次同类的坑，见
mvp jungle break 的 NaN 修复）。所以 ``TrajectoryVoice.note_on`` 自己再夹一次。
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import Any

import numpy as np

_HERE = Path(__file__).resolve()
DEFAULT_VENDOR_TRAJECTORYBRAVE = _HERE.parents[2] / "vendor" / "trajectorybrave"
#: TrajectoryBrave 的 model.py 依赖 midibrave.model（BraveDecoder 等，见模块
#: docstring）——跟 MidiBraveBackendV2 用的是同一份 vendor（已用 sha256 核实
#: 逐字节相同）。这里独立加一次 sys.path，不能假设调用方已经先构造过某个
#: MidiBraveBackendV2 实例（它的 __init__ 会顺带加这条路径，但本模块可能
#: 被单独调用——比如 tools/build_pad_trajectorybrave_map.py 只建 pad 一个
#: 后端，不会经过任何 MidiBraveBackendV2 构造）。
DEFAULT_VENDOR_MIDIBRAVE_V2 = _HERE.parents[2] / "vendor" / "midibrave-v2"
CONFIG_PATH = DEFAULT_VENDOR_TRAJECTORYBRAVE / "configs" / "pad_v1.yaml"
CHECKPOINT_PATH = Path("/data/model_weights/midiBrave/trajectorybrave-pad-v1-step-035000.pt")

#: 来自 jyhu 的 TrajectoryBrave_Boids_Spark_测试结果.md（joint step 35000）。
EXPECTED_CHECKPOINT_SHA256 = "644bf99d2463af136e2819b780657d9502bbbb7b2f0f055a4a9c7da46c7f4b1b"

#: 这个 checkpoint 训练时的 MIDI 范围（见 vendor 的 live.py LiveRenderer.start）。
#: 比本仓库其余音色的 TRAIN_NOTE_MIN/MAX（21–109）窄很多，必须单独 clamp。
PAD_NOTE_MIN = 36
PAD_NOTE_MAX = 71

#: 按 device 缓存已加载模型——当前两行（1/4）共享同一个实例，
#: 跟 MidiBraveBackendV2 的 pad 共享模型做法一致（brave_voices.py 模块 docstring）。
_SHARED_TRAJECTORYBRAVE_MODELS: dict[str, "TrajectoryBravePadBackend"] = {}
# CUDA kernel selection/compilation is shape-specific. The offline loudness pass
# uses 2048 samples, while production serves 4096; warming one does not warm the
# other. Cache the exact live geometry once per loaded model and process.
_WARMED_LIVE_GEOMETRIES: set[tuple[int, int]] = set()
_LIVE_WARMUP_LOCK = threading.Lock()


def _ensure_vendor_on_path(midibrave_vendor_root=DEFAULT_VENDOR_MIDIBRAVE_V2,
                           trajectory_vendor_root=DEFAULT_VENDOR_TRAJECTORYBRAVE) -> None:
    for vendor_root in (midibrave_vendor_root, trajectory_vendor_root):
        src = str(vendor_root / "src")
        if src not in sys.path:
            sys.path.insert(0, src)


class TrajectoryBravePadBackend:
    """单例共享的 TrajectoryBrave pad 模型封装。"""

    def __init__(self, device: str = "cpu", *, checkpoint_path: Path = CHECKPOINT_PATH,
                 config_path: Path = CONFIG_PATH,
                 expected_sha256: str = EXPECTED_CHECKPOINT_SHA256,
                 midibrave_vendor_root: Path = DEFAULT_VENDOR_MIDIBRAVE_V2,
                 trajectory_vendor_root: Path = DEFAULT_VENDOR_TRAJECTORYBRAVE) -> None:
        _ensure_vendor_on_path(midibrave_vendor_root, trajectory_vendor_root)
        from trajectorybrave.demo.live import load_runtime_model

        if not checkpoint_path.is_file():
            raise FileNotFoundError(f"缺 TrajectoryBrave pad checkpoint: {checkpoint_path}")
        runtime = load_runtime_model(
            config_path, checkpoint_path, device,
            expected_sha256=expected_sha256,
        )
        self.device = device
        self.model = runtime.model
        self.config = runtime.config
        self.anchors = runtime.anchors  # np.float32 [50, 8]
        self.checkpoint_meta = runtime.checkpoint

        # 默认音色：离全部 anchor 质心最近的一个真实 anchor，不是零向量——
        # 零向量是分布外输入，跟 _load_default_timbre 拒绝用零向量的理由一样
        # （brave_voices.py 同名注释）。这里没有 CLAP 可用，直接挑真实 anchor。
        centroid = self.anchors.mean(axis=0, keepdims=True)
        distances = np.linalg.norm(self.anchors - centroid, axis=1)
        self.default_control_coordinate = self.anchors[int(np.argmin(distances))].copy()

    def warm_up_live(self, block_samples: int) -> dict[str, Any] | None:
        """Warm the production ``natural`` CUDA path for its exact block shape.

        The first 4096-sample live render on Spark has been measured at ~807 ms,
        versus a 92.88 ms block budget and ~5.7 ms steady state. Loudness
        calibration cannot cover it because ``render_note`` uses 2048 samples.
        Discard two blocks and panic the temporary renderer so no note/lifecycle
        state leaks into the first user session. Shared models only pay once.
        """
        device_type = getattr(self.device, "type", str(self.device).split(":", 1)[0])
        if device_type != "cuda":
            return None
        block_samples = int(block_samples)
        key = (id(self.model), block_samples)
        with _LIVE_WARMUP_LOCK:
            if key in _WARMED_LIVE_GEOMETRIES:
                return None
            _ensure_vendor_on_path()
            from trajectorybrave.demo.live import LiveRenderer

            renderer = LiveRenderer(self.model, block_samples=block_samples)
            render_ms: list[float] = []
            try:
                renderer.start(
                    self.default_control_coordinate,
                    note=60,
                    velocity=127,
                    mode="natural",
                )
                for _ in range(2):
                    block = renderer.render_block(block_samples)
                    if block is None:
                        raise RuntimeError("TrajectoryBrave live warm-up returned no block")
                    render_ms.append(float(block.render_ms))
            finally:
                renderer.panic()
            _WARMED_LIVE_GEOMETRIES.add(key)
            return {
                "blockSamples": block_samples,
                "firstRenderMs": round(render_ms[0], 3),
                "secondRenderMs": round(render_ms[1], 3),
            }

    def prepare_note_stochastic(self, duration_seconds: float) -> None:
        """空实现——MultiVoiceBraveBackend.note_on() 对所有行无条件调用这个
        方法（MidiBraveBackendV2 用它预生成整段随机激励缓冲，见该类模块
        docstring「分块调用不等于整段调用切片」）。TrajectoryBrave 的
        ``StreamingStochasticCache``（vendor 的 demo/live.py）自己按会话
        时长一次性生成、内部管理，不需要调用方配合，这里只是接住调用别让
        ``note_on()`` 因为 AttributeError 崩掉。"""

    def render_note(
        self, z: Any, note: int, velocity: int, duration_seconds: float,
    ) -> np.ndarray:
        """离线整段渲染——只给 ``_calibrate_gain`` 和建图脚本用，跟
        ``MidiBraveBackendV2.render_note`` 同一调用形状，好让调用方零改动复用。

        ``full_lifecycle=True`` 让它严格按训练时钟播满整条 5 秒生命周期
        （pre_roll/gate/release 都在训练时的真实位置上），不是"播 duration_seconds
        就切断"——跟 Audit 模式的「完整重播 5s」同一语义。返回值再裁到
        ``duration_seconds``，供 RMS 响度标定使用。
        """
        _ensure_vendor_on_path()
        from trajectorybrave.demo.live import LiveRenderer

        coordinate = _coord_array(z)
        note = max(PAD_NOTE_MIN, min(PAD_NOTE_MAX, int(round(float(note)))))
        renderer = LiveRenderer(self.model, block_samples=2048)
        renderer.start(
            coordinate, note=note, velocity=int(velocity),
            mode="natural", full_lifecycle=True,
        )
        chunks: list[np.ndarray] = []
        while renderer.state != "idle":
            block = renderer.render_block()
            if block is None:
                break
            chunks.append(block.audio)
        wave = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        wanted = int(round(duration_seconds * self.config.data.sample_rate))
        if wave.shape[0] < wanted:
            wave = np.pad(wave, (0, wanted - wave.shape[0]))
        return wave[:wanted].astype(np.float32)


def get_shared_trajectorybrave_pad(device: str = "cpu", **asset_paths) -> TrajectoryBravePadBackend:
    key = f"pad-trajectorybrave@{device}@{asset_paths.get('checkpoint_path', CHECKPOINT_PATH)}"
    shared = _SHARED_TRAJECTORYBRAVE_MODELS.get(key)
    if shared is None:
        shared = TrajectoryBravePadBackend(device=device, **asset_paths)
        _SHARED_TRAJECTORYBRAVE_MODELS[key] = shared
    return shared


def _coord_array(z: Any) -> np.ndarray:
    if hasattr(z, "detach"):
        z = z.detach().cpu().numpy()
    return np.asarray(z, dtype=np.float32).reshape(-1)


class TrajectoryVoice:
    """单声部包装：把 ``LiveRenderer`` 的方法改名成跟 ``StreamingVoice`` 一样的
    形状，这样 ``brave_voices.py`` 的调用代码不用为这个引擎单独分支。

    跟 ``StreamingVoice`` 的一个真实差别：``LiveRenderer`` 内部自带音色平滑
    （约 100ms 时间常数，见 vendor 的 ``live.py`` ``_smoothing_alpha``），
    ``timbre_rate_per_second`` 这个属性只是接住赋值，不生效——见模块 docstring。
    """

    def __init__(self, backend: TrajectoryBravePadBackend, block_samples: int = 2048) -> None:
        _ensure_vendor_on_path()
        from trajectorybrave.demo.live import LiveRenderer

        self.backend = backend
        self.renderer = LiveRenderer(backend.model, block_samples=block_samples)
        self.timbre_rate_per_second = 0.0

    def note_on(self, z: Any, note: int, velocity: int) -> None:
        coordinate = _coord_array(z)
        note = max(PAD_NOTE_MIN, min(PAD_NOTE_MAX, int(round(float(note)))))
        self.renderer.start(coordinate, note=note, velocity=int(velocity), mode="natural")

    def set_timbre_target(self, z: Any) -> None:
        self.renderer.update_coordinate(_coord_array(z))

    def note_off(self) -> None:
        self.renderer.stop()

    def panic(self) -> None:
        """立即静音，跳过 release 尾音——只给 ``MultiVoiceBraveBackend.reset()``
        用（会话重建时要的是立即清空，不是自然释放）。"""
        self.renderer.panic()

    def render_block(self, samples: int) -> np.ndarray:
        block = self.renderer.render_block(samples)
        if block is None:
            return np.zeros(samples, dtype=np.float32)
        return block.audio
