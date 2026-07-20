"""aiohttp 实时音源服务。

与 Latent-Cosmos 基线**线兼容**,前端换个 URL 就能接:

    GET  /healthz              存活探针
    GET  /api/decoder-status   后端自述
    WS   /decoder              音频流

下行是二进制**交错立体声 float32 PCM**(L R L R …)。音源本身是干声 mono,
在发送前复制到两声道 —— 声像、混响、EQ、昼夜宏全在前端,服务端一概不做
(BRIEF.md 架构决定 3)。

上行三种帧:

- ``control`` —— 基线的连续 gate 语义,60 Hz 全量下发 voice 状态。
- ``note``    —— 本项目新增。前端是 perch/unperch 的 note 语义(按一下响一段,
  时长由 ``unperchToRelease`` 给出),没有持续的 gate 流。服务端收到就起音并
  记下时长,到点自动松键。
- ``buffer``  —— 客户端回报缓冲水位,服务端据此调节发送节奏(背压 pacing)。

两种上行驱动的是**同一个 voice 池**,互不冲突:``control`` 直接写 gate,
``note`` 通过时长倒计时写 gate。混用时后到的那个说了算。

voice 池常驻固定长度,所以**只要有客户端连着就一直发流**,静音时发零块。
不发流会让客户端 worklet 的环形缓冲饿死,复播时爆音。
"""
from __future__ import annotations

import asyncio
import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from aiohttp import WSMsgType, web

try:
    from .backends.base import AudioBackend, SilentBackend
    from .backends.synth import TIMBRE_NAMES, SynthBackend, timbre_spec
    from .config import (
        DURATION_MAX_SECONDS,
        DURATION_MIN_SECONDS,
        HIGH_WATER_FRAMES,
        MIDI_MAX,
        MIDI_MIN,
        PRIME_FRAMES,
        EngineConfig,
        config_from_args,
    )
    from .voices import VoicePool
except ImportError:  # 支持 `python3 server/app.py` 直接跑
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from server.backends.base import AudioBackend, SilentBackend
    from server.backends.synth import TIMBRE_NAMES, SynthBackend, timbre_spec
    from server.config import (
        DURATION_MAX_SECONDS,
        DURATION_MIN_SECONDS,
        HIGH_WATER_FRAMES,
        MIDI_MAX,
        MIDI_MIN,
        PRIME_FRAMES,
        EngineConfig,
        config_from_args,
    )
    from server.voices import VoicePool

TELEMETRY_EVERY_BLOCKS = 8


# ---------------------------------------------------------------------------
# 后端装配
# ---------------------------------------------------------------------------

def discover_backends() -> dict[str, type[AudioBackend]]:
    """扫描 ``server/backends/`` 下所有 ``AudioBackend`` 子类,按 ``backend_id`` 建表。

    这样接新后端不需要动服务层:只要在这个包里放一个继承 ``AudioBackend`` 的类、
    把 ``backend_id`` 设成想要的名字,``--backend <名字>`` 就能选中它。

    导入失败一律吞掉并记一行 —— 神经后端要 torch,本机/CI 上不一定装了,
    不能因为它导不进来就让整个服务起不来。
    """
    import importlib
    import pkgutil

    package = importlib.import_module(__package__ + ".backends" if __package__ else "server.backends")
    registry: dict[str, type[AudioBackend]] = {}
    for module_info in pkgutil.iter_modules(package.__path__):
        if module_info.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{package.__name__}.{module_info.name}")
        except Exception as error:  # noqa: BLE001 — 缺依赖不该拖垮服务
            print(f"[warn] 后端模块 {module_info.name} 导入失败({error.__class__.__name__}: {error}),跳过", flush=True)
            continue
        for attribute in vars(module).values():
            if (
                isinstance(attribute, type)
                and issubclass(attribute, AudioBackend)
                and attribute is not AudioBackend
            ):
                registry[attribute.backend_id] = attribute
    return registry


def make_backend(config: EngineConfig) -> AudioBackend:
    """按配置造后端。

    ``--backend`` 认三种写法:

    - ``synth`` / ``silent`` —— 内置别名
    - 任何已注册的 ``backend_id``(见 ``discover_backends``)
    - ``模块:类名`` —— 显式指定,应急用

    神经后端还没落地(或缺 torch)时自动回落到程序合成 —— 服务层不因为模型
    没就绪而起不来,这是分头开工的前提。
    """
    kwargs: dict[str, Any] = {
        "sample_rate": config.sample_rate,
        "pool_size": config.pool_size,
        "block_samples": config.block_samples,
    }
    name = config.backend
    if name == "silent":
        return SilentBackend(**kwargs)
    if name == "synth":
        return SynthBackend(**kwargs)

    if ":" in name:  # 模块:类名
        import importlib

        module_name, _, class_name = name.partition(":")
        try:
            factory = getattr(importlib.import_module(module_name), class_name)
        except (ImportError, AttributeError) as error:
            print(f"[warn] 无法加载 {name}({error}),回落到程序合成兜底", flush=True)
            return SynthBackend(**kwargs)
    else:
        registry = discover_backends()
        factory = registry.get(name)
        if factory is None:
            print(
                f"[warn] 后端 '{name}' 未注册(已发现: {sorted(registry)}),"
                "回落到程序合成兜底",
                flush=True,
            )
            return SynthBackend(**kwargs)

    # 神经后端额外要权重路径;不吃这个参数的后端也能正常构造
    if config.model_path is not None:
        kwargs["model_path"] = config.model_path
    try:
        return factory(**kwargs)
    except TypeError as error:
        print(f"[warn] {factory.__name__} 构造签名不匹配({error}),回落到程序合成兜底", flush=True)
        return SynthBackend(**kwargs)


# ---------------------------------------------------------------------------
# 会话状态
# ---------------------------------------------------------------------------

@dataclass
class Session:
    """一个 WS 连接的全部状态。每连接一套 voice 池和后端实例。"""

    pool: VoicePool
    backend: AudioBackend
    config: EngineConfig

    #: 每行剩余的 note 样本数。<=0 表示不由 note 语义驱动(或已到点)。
    remaining: dict[int, int] = field(default_factory=dict)
    #: 客户端回报的缓冲水位(每 32 块才来一次,是**过期值**)
    buffered_frames: int = 0
    underruns: int = 0
    revision: int = 0
    blocks_sent: int = 0
    #: 上次收到回报的时刻,以及此后又发了多少帧 —— 用来把过期值外推到当下
    reported_at: float = field(default_factory=time.monotonic)
    frames_since_report: int = 0
    has_report: bool = False
    #: 首次回报之前,用来推断客户端何时起播(攒够 PRIME_FRAMES 那一刻)
    prime_reached_at: float | None = None

    # ---- 上行事件 ----------------------------------------------------

    def handle_note(self, payload: dict[str, Any]) -> None:
        """note 帧:起音 + 记时长。last-note-priority,新音直接抢占。"""
        row = int(payload.get("voice", payload.get("row", 0)))
        voice = self.pool.route(row)
        if voice is None:
            return
        midi = float(np.clip(payload.get("midi", 60.0), MIDI_MIN, MIDI_MAX))
        velocity = float(np.clip(payload.get("velocity", 0.8), 0.0, 1.0))
        duration = float(
            np.clip(
                payload.get("durationSeconds", 1.0),
                DURATION_MIN_SECONDS,
                DURATION_MAX_SECONDS,
            )
        )
        if "timbre" in payload:
            voice.timbre = _resolve_timbre(payload["timbre"], self._timbre_names())
        if "timbreXY" in payload:
            voice.timbre_xy = _resolve_xy(payload["timbreXY"])
        if "timbreK" in payload:
            voice.timbre_k = int(np.clip(payload["timbreK"], 1, 32))
        if "timbrePCA" in payload:
            voice.timbre_pca = _resolve_pca(payload["timbrePCA"])
        self._apply_continuous(voice, payload)

        voice.note_on(midi=midi, velocity=velocity)
        self.backend.note_on(voice)
        self.remaining[voice.row] = int(duration * self.config.sample_rate)
        self.revision += 1

    def _timbre_names(self) -> list[str]:
        """当前后端的音色/锚点名单。synth 是 4 个波形，brave 是 atlas 的 9 个锚点。"""
        try:
            info = self.backend.info()
        except Exception:  # 后端没就绪时不要让控制帧炸掉
            return list(TIMBRE_NAMES)
        return list(info.get("timbrePresets") or info.get("anchors") or TIMBRE_NAMES)

    def handle_note_off(self, payload: dict[str, Any]) -> None:
        row = int(payload.get("voice", payload.get("row", 0)))
        voice = self.pool.route(row)
        if voice is None:
            return
        self._release(voice)
        self.revision += 1

    def handle_control(self, payload: dict[str, Any]) -> None:
        """基线 control 帧:连续 gate 语义,全量覆盖。

        显式给了 gate 就以它为准,并清掉该行的 note 倒计时 —— 两种语义打架时
        后到的说了算。
        """
        for index, item in enumerate(payload.get("voices", [])):
            row = int(item.get("voice", item.get("row", item.get("objectId", index))))
            voice = self.pool.route(row)
            if voice is None:
                continue
            if "timbre" in item:
                voice.timbre = _resolve_timbre(item["timbre"], self._timbre_names())
            if "timbreXY" in item:
                voice.timbre_xy = _resolve_xy(item["timbreXY"])
            if "timbreK" in item:
                voice.timbre_k = int(np.clip(item["timbreK"], 1, 32))
            if "timbrePCA" in item:
                voice.timbre_pca = _resolve_pca(item["timbrePCA"])
            self._apply_continuous(voice, item)

            previous_midi = voice.midi
            if "midi" in item or "velocity" in item:
                voice.midi = float(np.clip(item.get("midi", voice.midi), MIDI_MIN, MIDI_MAX))
                voice.velocity = float(np.clip(item.get("velocity", voice.velocity), 0.0, 1.0))
            if "gate" in item:
                gate = bool(item["gate"])
                self.remaining.pop(voice.row, None)  # control 接管这一行
                if gate and not voice.gate:
                    voice.note_on(midi=voice.midi, velocity=voice.velocity)
                    self.backend.note_on(voice)
                elif gate and voice.gate and round(voice.midi) != round(previous_midi):
                    # 延音期间改音高 = 换音，必须重触发。
                    # 只在 gate 翻转时起音的话，按住不放时改音高毫无反应 ——
                    # voice.midi 更新了但流式声部还在放旧音。
                    voice.note_on(midi=voice.midi, velocity=voice.velocity)
                    self.backend.note_on(voice)
                elif not gate and voice.gate:
                    self._release(voice)
        self.revision += 1

    def handle_buffer(self, payload: dict[str, Any]) -> None:
        self.buffered_frames = max(0, int(payload.get("bufferedFrames", 0)))
        self.underruns = max(0, int(payload.get("underruns", 0)))
        self.reported_at = time.monotonic()
        self.frames_since_report = 0
        self.has_report = True

    def estimated_buffer(self) -> int:
        """把过期的回报外推到当下。

        客户端每 32 块(约 0.74 s)才报一次水位。直接拿这个过期值调节节奏,
        服务端会在整个盲区里按"缓冲还很空"全速发 —— 实测一个盲区就能冲出
        0.48 s 的超调,缓冲在 80 ms 和 525 ms 之间来回锯齿,峰值远超
        100–300 ms 的延迟预算。

        服务端自己知道回报之后又发了多少帧,也知道过了多久(客户端按采样率
        匀速消费),所以能把水位外推到当下。这纯属服务端内部策略,不改协议。
        """
        now = time.monotonic()
        if not self.has_report:
            # 首次回报要等 32 块(约 0.74 s)才来,这段盲区不能一直假设客户端
            # 零消费 —— 它攒够 PRIME_FRAMES 就起播了,之后按采样率匀速消费。
            # 照搬客户端 worklet 的起播规则自己推一遍,盲区里也能估得准。
            if self.frames_since_report < PRIME_FRAMES:
                return self.frames_since_report          # 还在攒,没起播
            if self.prime_reached_at is None:
                self.prime_reached_at = now
            consumed = (now - self.prime_reached_at) * self.config.sample_rate
            return max(0, int(self.frames_since_report - consumed))
        consumed = (now - self.reported_at) * self.config.sample_rate
        return max(0, int(self.buffered_frames + self.frames_since_report - consumed))

    # ---- 渲染 ----------------------------------------------------------

    def render(self, n_samples: int) -> tuple[np.ndarray, float]:
        """推进 note 倒计时,渲染一块,返回交错立体声和耗时(毫秒)。"""
        started = time.perf_counter()
        self._advance_notes(n_samples)
        mono = self.backend.render_block(self.pool.voices, n_samples)
        # 干声 mono → 交错立体声。等幅复制,声像交给前端。
        stereo = np.empty(n_samples * 2, dtype=np.float32)
        stereo[0::2] = mono
        stereo[1::2] = mono
        return stereo, (time.perf_counter() - started) * 1000.0

    def _advance_notes(self, n_samples: int) -> None:
        """note 时长到点就松键。块对齐(23 ms 粒度),对秒级事件率足够。"""
        for row, left in list(self.remaining.items()):
            remaining = left - n_samples
            if remaining <= 0:
                self.remaining.pop(row, None)
                voice = self.pool.route(row)
                if voice is not None and voice.gate:
                    self._release(voice)
            else:
                self.remaining[row] = remaining

    def _release(self, voice) -> None:
        voice.note_off()
        self.backend.note_off(voice)
        self.remaining.pop(voice.row, None)

    def _apply_continuous(self, voice, payload: dict[str, Any]) -> None:
        """gain / rich / room / dirt。room 服务端不消费(混响在前端),但照收
        不误 —— 前端一套参数发过来,服务端不该因为多一个字段就报错。"""
        self.pool.apply_params(voice.row, payload)

    # ---- 遥测 ----------------------------------------------------------

    def telemetry(self, mono_rms: float, render_ms: float) -> dict[str, Any]:
        return {
            "type": "telemetry",
            "renderMs": round(render_ms, 3),
            "revision": self.revision,
            "bufferedFrames": self.buffered_frames,
            "estimatedBufferedFrames": self.estimated_buffer(),
            "underruns": self.underruns,
            "activeVoices": self.pool.active(),
            "db": round(20.0 * math.log10(max(mono_rms, 1e-7)), 2),
            "voices": [
                {
                    "row": voice.row,
                    "timbre": TIMBRE_NAMES[voice.timbre] if 0 <= voice.timbre < len(TIMBRE_NAMES) else "pad",
                    "gate": voice.gate,
                    "midi": round(voice.midi, 3),
                    "velocity": round(voice.velocity, 3),
                    "envelope": round(voice.envelope, 5),
                    "remainingSeconds": round(
                        self.remaining.get(voice.row, 0) / self.config.sample_rate, 3
                    ),
                }
                for voice in self.pool.voices
            ],
        }




def _resolve_pca(value: Any) -> tuple[float, ...] | None:
    """解析无约束 PCA 漫游的系数。给 null 表示退出该模式。"""
    if value is None:
        return None
    try:
        return tuple(float(np.clip(v, -8.0, 8.0)) for v in value)
    except (TypeError, ValueError):
        return None


def _resolve_xy(value: Any) -> tuple[float, float] | None:
    """解析二维音色地图坐标。给 null 表示回到锚点槽位模式。"""
    if value is None:
        return None
    try:
        x, y = value[0], value[1]
    except (TypeError, IndexError, KeyError):
        return None
    # 地图坐标已归一化到约 [-1,1]，夹一下防止离谱输入把 kNN 拉到边角
    return (float(np.clip(x, -2.0, 2.0)), float(np.clip(y, -2.0, 2.0)))


def _resolve_timbre(value: Any, names: Sequence[str] | None = None) -> int:
    """音色可以给下标也可以给名字。不认识的回落到 1。

    ``names`` 是**当前后端**的音色/锚点名单：synth 是 4 个波形，brave 是
    atlas 的 9 个锚点。必须按后端来夹取——写死成 synth 的 4 个会把
    brave 的锚点 4–8 全部打回 1，表现为「漫游只能到前几个锚点」。
    """
    table = list(names) if names else TIMBRE_NAMES
    if isinstance(value, str):
        return table.index(value) if value in table else 1
    index = int(value)
    return index if 0 <= index < len(table) else 1


# ---------------------------------------------------------------------------
# 发送节奏(背压)
# ---------------------------------------------------------------------------

#: 稳态想稳在这个水位。起播量之上留一点余量吸收调度抖动,约 136 ms。
TARGET_FRAMES = 6000


def pacing_factor(buffered_frames: int) -> float:
    """按缓冲水位算发送节奏系数(1.0 = 实时,<1 = 抢跑,>1 = 减速)。

    保留基线的两个硬边界(起播量之下抢跑、高水位之上减速),但中间那档从
    固定的 0.97 换成**比例控制**:

    - 固定 0.97 意味着服务端永远比实时快 3%,缓冲只会一路涨到高水位才被
      掐住,稳态延迟被顶到 HIGH_WATER 附近,白白浪费预算。
    - 比例控制在 ``TARGET_FRAMES`` 处取 1.0(正好实时),偏高就减速、偏低就
      加速,是个有稳定不动点的控制器。

    传进来的应当是 ``Session.estimated_buffer()`` 的外推值,不是过期的原始回报。
    """
    if buffered_frames < PRIME_FRAMES:
        return 0.5           # 还没攒够起播量,抢跑但别过头
    if buffered_frames > HIGH_WATER_FRAMES:
        return 1.20          # 堆积了,让客户端消费
    error = (buffered_frames - TARGET_FRAMES) / TARGET_FRAMES
    return float(np.clip(1.0 + 0.5 * error, 0.5, 1.20))


# ---------------------------------------------------------------------------
# HTTP / WS
# ---------------------------------------------------------------------------

def build_app(config: EngineConfig) -> web.Application:
    template = make_backend(config)
    template.load()
    print(f"[boot] 后端就绪: {template.info()}", flush=True)

    def status_payload() -> dict[str, Any]:
        info = template.info()
        return {
            "engine": "flock-voice-engine",
            "defaultModel": info["id"],
            "models": [info],
            "sampleRate": config.sample_rate,
            "blockSamples": config.block_samples,
            "samplesPerFrame": config.block_samples,
            "framesPerDecode": 1,
            "poolSize": config.pool_size,
            "channels": 2,
            "pcmFormat": "f32-interleaved-stereo",
            "controlSchemes": ["control", "note"],
            "timbres": list(TIMBRE_NAMES),
            "serverSideMastering": False,
        }

    async def healthz(_request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "backend": template.backend_id})

    async def decoder_status(_request: web.Request) -> web.Response:
        return web.json_response(status_payload())

    async def decoder(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=15.0, max_msg_size=64 * 1024)
        await ws.prepare(request)

        # 每个连接一套池子和后端实例 —— 跨块状态不能在连接之间串。
        session = Session(
            pool=VoicePool(size=config.pool_size, sample_rate=config.sample_rate),
            backend=make_backend(config),
            config=config,
        )
        session.backend.load()

        peer = request.remote or "?"
        conn_id = f"{peer}#{id(ws) & 0xffff:04x}"
        conn_started = time.monotonic()
        print(f"[conn {conn_id}] 已连接，后端 {session.backend.backend_id}", flush=True)

        await ws.send_json({
            "type": "ready",
            **status_payload(),
            "modelId": session.backend.backend_id,
            "backend": session.backend.info(),
        })

        async def receive() -> None:
            async for message in ws:
                if message.type is not WSMsgType.TEXT:
                    if message.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                        break
                    continue
                try:
                    payload = json.loads(message.data)
                    kind = payload.get("type")
                    if kind == "note":
                        session.handle_note(payload)
                    elif kind in ("noteOff", "note_off"):
                        session.handle_note_off(payload)
                    elif kind == "control":
                        session.handle_control(payload)
                    elif kind == "buffer":
                        session.handle_buffer(payload)
                except (ValueError, TypeError, KeyError) as error:
                    await ws.send_json({"type": "error", "message": f"坏帧: {error}"})

        receiver = asyncio.create_task(receive())
        block_seconds = config.block_seconds
        exit_reason = "客户端关闭"
        try:
            while not ws.closed:
                started = time.perf_counter()
                stereo, render_ms = session.render(config.block_samples)
                await ws.send_bytes(stereo.astype("<f4", copy=False).tobytes())
                session.blocks_sent += 1
                session.frames_since_report += config.block_samples

                if session.blocks_sent % TELEMETRY_EVERY_BLOCKS == 0:
                    mono_rms = float(np.sqrt(np.mean(np.square(stereo[0::2], dtype=np.float64))))
                    await ws.send_json(session.telemetry(mono_rms, render_ms))

                elapsed = time.perf_counter() - started
                delay = block_seconds * pacing_factor(session.estimated_buffer()) - elapsed
                await asyncio.sleep(max(0.0, delay))
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        except (ConnectionResetError, asyncio.CancelledError) as error:
            exit_reason = f"连接重置({error.__class__.__name__})"
        except Exception as error:  # noqa: BLE001 — 必须记下来，否则断因不可见
            import traceback

            exit_reason = f"服务端异常 {error.__class__.__name__}: {error}"
            traceback.print_exc()
        finally:
            alive = time.monotonic() - conn_started
            print(
                f"[conn {conn_id}] 断开 · {exit_reason} · 存活 {alive:.1f}s · "
                f"发出 {session.blocks_sent} 块 · underrun {session.underruns} · "
                f"客户端水位 {session.buffered_frames} 帧",
                flush=True,
            )
            receiver.cancel()
            try:
                await receiver
            except asyncio.CancelledError:
                pass
            session.backend.close()
        return ws

    app = web.Application()
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/api/decoder-status", decoder_status)
    app.router.add_get("/decoder", decoder)

    # 可选：同源托管前端。页面和 WS 同主机同端口，浏览器到服务端只有一条链路，
    # 不经本机 VPN 的 TUN 栈 —— 后者对长连接 WS 的处理是已知的不稳定来源。
    if config.static:
        static_root = Path(config.static).expanduser().resolve()
        if not static_root.is_dir():
            raise SystemExit(f"--static 指向的不是目录: {static_root}")

        async def index(_request: web.Request) -> web.FileResponse:
            return web.FileResponse(static_root / "index.html")

        app.router.add_get("/", index)
        # show_index=False：不暴露目录列表
        app.router.add_static("/", static_root, show_index=False, follow_symlinks=False)
        print(f"[boot] 静态站点: {static_root} → http://{config.host}:{config.port}/", flush=True)

    app["config"] = config
    return app


def main(argv: list[str] | None = None) -> None:
    config = config_from_args(argv)
    app = build_app(config)
    print(
        f"[boot] flock-voice-engine → http://{config.host}:{config.port}"
        f"  (pool={config.pool_size}, {config.sample_rate} Hz, "
        f"{config.block_samples} samples/块 = {config.block_seconds * 1000:.1f} ms)",
        flush=True,
    )
    web.run_app(app, host=config.host, port=config.port, print=None)


if __name__ == "__main__":
    import sys

    if "--selftest" in sys.argv:
        # 进程内起服务 → 连上 → 发 note → 校验下行,不占 8090。
        import aiohttp

        async def selftest() -> None:
            config = EngineConfig(host="127.0.0.1", port=0, pool_size=2)
            runner = web.AppRunner(build_app(config))
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
            base = f"http://127.0.0.1:{port}"
            try:
                async with aiohttp.ClientSession() as http:
                    async with http.get(f"{base}/healthz") as response:
                        assert (await response.json())["ok"] is True
                    async with http.get(f"{base}/api/decoder-status") as response:
                        status = await response.json()
                    assert status["channels"] == 2
                    assert status["pcmFormat"] == "f32-interleaved-stereo"
                    print(f"[1] HTTP 端点 OK: {status['models'][0]['id']}")

                    async with http.ws_connect(f"{base}/decoder") as ws:
                        ready = await ws.receive_json()
                        assert ready["type"] == "ready", ready
                        print(f"[2] ready 帧 OK: pool={ready['poolSize']}")

                        await ws.send_json({
                            "type": "note", "voice": 0, "midi": 60,
                            "velocity": 0.9, "durationSeconds": 0.4, "timbre": "pluck",
                        })
                        audio_blocks, telemetry_seen = [], False
                        deadline = time.monotonic() + 6.0
                        while len(audio_blocks) < 40 and time.monotonic() < deadline:
                            message = await asyncio.wait_for(ws.receive(), timeout=3.0)
                            if message.type is WSMsgType.BINARY:
                                audio_blocks.append(np.frombuffer(message.data, dtype="<f4"))
                                await ws.send_json({
                                    "type": "buffer",
                                    "bufferedFrames": len(audio_blocks) * config.block_samples,
                                    "underruns": 0,
                                })
                            elif message.type is WSMsgType.TEXT:
                                if json.loads(message.data).get("type") == "telemetry":
                                    telemetry_seen = True
                        assert len(audio_blocks) >= 40, f"只收到 {len(audio_blocks)} 块"
                        assert telemetry_seen, "没收到 telemetry"

                        stream = np.concatenate(audio_blocks)
                        assert len(stream) == 40 * config.block_samples * 2, "交错立体声长度不对"
                        left, right = stream[0::2], stream[1::2]
                        assert np.array_equal(left, right), "左右声道应当相同(干声 mono 复制)"
                        assert float(np.abs(left).max()) > 0.01, "没有声音"
                        assert float(np.abs(np.diff(left.astype(np.float64))).max()) < 0.3, "爆音"
                        print(f"[3] 音频流 OK: {len(audio_blocks)} 块, peak={float(np.abs(left).max()):.3f}")

                        # 基线 control 帧(连续 gate 语义)必须驱动同一个池子
                        async def drain(count: int) -> np.ndarray:
                            collected = []
                            while len(collected) < count:
                                item = await asyncio.wait_for(ws.receive(), timeout=3.0)
                                if item.type is WSMsgType.BINARY:
                                    collected.append(np.frombuffer(item.data, dtype="<f4")[0::2])
                            return np.concatenate(collected)

                        await ws.send_json({"type": "control", "voices": [
                            {"voice": 1, "gate": True, "midi": 55, "velocity": 1.0, "timbre": "pad"},
                        ]})
                        held = await drain(30)
                        assert float(np.abs(held).max()) > 0.01, "control gate=True 没出声"

                        await ws.send_json({"type": "control", "voices": [{"voice": 1, "gate": False}]})
                        released = await drain(120)
                        assert float(np.abs(released[-1024:]).max()) < float(np.abs(held).max()), \
                            "control gate=False 没有进入 release"
                        print(f"[4] control 帧 OK: 起音 peak={float(np.abs(held).max()):.3f} → 松键收敛")

                        # MIDI 越界必须被夹到训练域内(31–95),而不是原样透传
                        await ws.send_json({
                            "type": "note", "voice": 0, "midi": 200,
                            "velocity": 0.5, "durationSeconds": 0.3,
                        })
                        await drain(4)
                        telemetry = None
                        deadline = time.monotonic() + 3.0
                        while telemetry is None and time.monotonic() < deadline:
                            item = await asyncio.wait_for(ws.receive(), timeout=3.0)
                            if item.type is WSMsgType.TEXT:
                                candidate = json.loads(item.data)
                                if candidate.get("type") == "telemetry":
                                    telemetry = candidate
                        assert telemetry is not None
                        assert telemetry["voices"][0]["midi"] <= 95, telemetry["voices"][0]
                        print(f"[5] MIDI 夹紧 OK: 200 → {telemetry['voices'][0]['midi']}")
            finally:
                await runner.cleanup()
            print("app.py 自测通过")

        asyncio.run(selftest())
    else:
        main()
