"""aiohttp 实时音源服务。

与 Latent-Cosmos 基线**线兼容**,前端换个 URL 就能接:

    GET  /healthz              存活探针
    GET  /api/decoder-status   后端自述
    WS   /decoder              音频流

下行是二进制**交错立体声 float32 PCM**(L R L R …)。音源本身是干声 mono,
在发送前复制到两声道 —— 声像、混响、EQ、昼夜宏全在前端,服务端一概不做
(BRIEF.md 架构决定 3)。

上行帧:

- ``control`` —— 基线的连续 gate 语义,60 Hz 全量下发 voice 状态。
- ``note``    —— 本项目新增。前端是 perch/unperch 的 note 语义(按一下响一段,
  时长由 ``unperchToRelease`` 给出),没有持续的 gate 流。服务端收到就起音并
  记下时长,到点自动松键。
- ``noteOff`` —— 提前松键，保留后端的自然 release。
- ``panic``   —— 只硬停一个 row；用于跨模型声部迁移，不留旧模型尾音。
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
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Sequence

import numpy as np
from aiohttp import WSMsgType, web

try:
    from .backends.base import AudioBackend, SilentBackend
    from .backend_factory import discover_backends, make_backend
    from .backends.synth import TIMBRE_NAMES, SynthBackend, timbre_spec
    from .config import (
        DURATION_MAX_SECONDS,
        DURATION_MIN_SECONDS,
        GATE_NOTE_BUFFER_SECONDS,
        HIGH_WATER_FRAMES,
        MIDI_MAX,
        MIDI_MIN,
        PRIME_FRAMES,
        EngineConfig,
        config_from_args,
    )
    from .release_info import ReleaseInfo
    from .voices import VoicePool
except ImportError:  # 支持 `python3 server/app.py` 直接跑
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from server.backends.base import AudioBackend, SilentBackend
    from server.backend_factory import discover_backends, make_backend
    from server.backends.synth import TIMBRE_NAMES, SynthBackend, timbre_spec
    from server.config import (
        DURATION_MAX_SECONDS,
        DURATION_MIN_SECONDS,
        GATE_NOTE_BUFFER_SECONDS,
        HIGH_WATER_FRAMES,
        MIDI_MAX,
        MIDI_MIN,
        PRIME_FRAMES,
        EngineConfig,
        config_from_args,
    )
    from server.release_info import ReleaseInfo
    from server.voices import VoicePool

TELEMETRY_EVERY_BLOCKS = 8


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
    #: 客户端回报的缓冲水位（每 32 个 render quanta，约 85 ms @ 48 kHz，是过期值）
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
    #: 分轨下行(``?split=1``)。每连接固定,运行期不可变 —— 通道数变了
    #: 客户端的环形缓冲和 worklet 输出数都要重建。
    split: bool = False

    @property
    def channels(self) -> int:
        return self.config.pool_size if self.split else 2

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

        voice.duration_seconds = duration
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

    def handle_panic(self, payload: dict[str, Any]) -> None:
        """立即停掉单个 row，专用于声部跨模型迁移。"""
        row = int(payload.get("voice", payload.get("row", 0)))
        voice = self.pool.route(row)
        if voice is None:
            return
        voice.note_off()
        voice.envelope = 0.0
        self.backend.panic_voice(voice)
        self.remaining.pop(voice.row, None)
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
                    # gate 起音没有声明时长——v2 随机激励缓冲要在 note_on
                    # 时按预期播长一次性生成,先按 hold 上限备(见 config)。
                    voice.duration_seconds = GATE_NOTE_BUFFER_SECONDS
                    voice.note_on(midi=voice.midi, velocity=voice.velocity)
                    self.backend.note_on(voice)
                elif gate and voice.gate and round(voice.midi) != round(previous_midi):
                    # 延音期间改音高 = 换音，必须重触发。
                    # 只在 gate 翻转时起音的话，按住不放时改音高毫无反应 ——
                    # voice.midi 更新了但流式声部还在放旧音。
                    voice.duration_seconds = GATE_NOTE_BUFFER_SECONDS
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

        客户端每 32 个 render quanta（约 85 ms @ 48 kHz）回报一次水位。
        直接拿这个过期值调节节奏，服务端会在回报间隔里按旧水位继续发送，
        造成不必要的超调。

        服务端自己知道回报之后又发了多少帧,也知道过了多久(客户端按采样率
        匀速消费),所以能把水位外推到当下。这纯属服务端内部策略,不改协议。
        """
        now = time.monotonic()
        if not self.has_report:
            # 首次回报前不能一直假设客户端零消费：它攒够 PRIME_FRAMES 就起播，
            # 之后按采样率匀速消费。照搬 worklet 起播规则外推，短回报间隔内也准确。
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
        """推进 note 倒计时,渲染一块,返回交错 PCM 和耗时(毫秒)。

        两种通道布局,由连接时的 ``?split=1`` 决定(见 ``self.split``):

        * 混合(默认):干声 mono 等幅复制成交错立体声,左右恒等。**线兼容**,
          既有前端与 map/demo 页零改动。
        * 分轨:``pool_size`` 个通道交错,第 n 通道 = 第 n 轨干声。前端据此
          给每一轨接自己的 EQ / 混响发送 / 频段占位 —— 服务端一旦求和,
          这些就都做不了。
        """
        started = time.perf_counter()
        self._advance_notes(n_samples)
        if self.split:
            tracks = self.backend.render_split(self.pool.voices, n_samples)
            # (pool, n) → 交错 n×pool。Fortran 序展平即按帧交错,免手写循环。
            frames = np.asarray(tracks, dtype=np.float32).T.reshape(-1)
            return frames, (time.perf_counter() - started) * 1000.0
        mono = self.backend.render_block(self.pool.voices, n_samples)
        # 干声 mono → 交错立体声。等幅复制,声像交给前端。
        stereo = np.empty(n_samples * 2, dtype=np.float32)
        stereo[0::2] = mono
        stereo[1::2] = mono
        return stereo, (time.perf_counter() - started) * 1000.0

    def _advance_notes(self, n_samples: int) -> None:
        """note 时长到点就松键。块对齐（4096/44100 ≈ 92.88 ms 粒度），对秒级事件率足够。"""
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
    # v1 全局地图约为 [-1,1]；v2 每-checkpoint 地图保留原始 t-SNE/PCA
    # 尺度，当前资产的 scale 最大约 13.7。浏览器可以显示归一化坐标，但线上
    # kNN 必须收到乘回 map.scale 的原始坐标；旧的 ±2 clamp 会让
    # lead/pluck 的大部分地图永远不可达。±16 覆盖已冻结资产并仍拒绝无界输入。
    return (float(np.clip(x, -16.0, 16.0)), float(np.clip(y, -16.0, 16.0)))


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

#: 稳态目标水位。13000 / 44100 ≈ 294.78 ms，约为 3.17 个 4096-sample blocks。
#: 当前单块预算 4096 / 44100 ≈ 92.88 ms；HIGH_WATER_FRAMES=19000 在目标之上
#: 留出抖动余量。这里仅描述 buffer/pacing 几何，精确端到端延迟待当前配置复测。
TARGET_FRAMES = 13000


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

#: 当前活跃连接,conn_id → 最近一次遥测快照。**只用来对外报负载,不参与渲染**——
#: 用户正在漫游时想知道负载,不该为了测量而再开一条 WS(那会让 Session 多建一份
#: voice 池和后端实例,等于把要测的东西改大了一倍)。见 /api/load。
_live_sessions: dict[str, dict[str, Any]] = {}

#: 负载日志落盘路径。挂进容器的 /app/logs 是宿主机就能读的目录,
#: 不用 docker logs / docker exec —— 那两个都要 docker 组权限,踩过一次 permission denied。
LOAD_LOG_PATH = Path(
    os.environ.get("FLOCK_VOICE_LOAD_LOG", "/tmp/flock-voice-load.jsonl")
)
LOAD_LOG_EVERY_BLOCKS = 40   # 4096 样本/块 @ 44.1 kHz；40 × 4096 / 44100 ≈ 3.72 s 写一行


def _append_load_log(record: dict[str, Any]) -> None:
    try:
        LOAD_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOAD_LOG_PATH.open("a") as f:
            f.write(json.dumps(record) + "\n")
    except OSError:
        pass  # 日志是锦上添花,写不进去不该打断音频渲染


def build_app(
    config: EngineConfig,
    release_info: ReleaseInfo | None = None,
) -> web.Application:
    release_info = release_info or ReleaseInfo.from_env()
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
            # 分轨是**按连接选择**的:``ws://…/decoder?split=1`` 才开。
            # 默认保持混合立体声,既有前端零改动(线兼容)。
            "splitSupported": bool(getattr(template, "supports_split", False)),
            "splitChannels": config.pool_size,
            "controlSchemes": ["control", "note"],
            "timbres": list(TIMBRE_NAMES),
            "serverSideMastering": False,
            **release_info.as_payload(),
        }

    async def healthz(_request: web.Request) -> web.Response:
        return web.json_response({
            "ok": True,
            "backend": template.backend_id,
            **release_info.as_payload(),
        })

    async def decoder_status(_request: web.Request) -> web.Response:
        return web.json_response(status_payload())

    async def load_status(_request: web.Request) -> web.Response:
        """当前负载,不开 WS 也能查。用户正在用的时候想看负载,连一条 WS 去测
        等于把要测的东西自己改大了一倍(Session 每连接一套池子和后端实例)。
        数据来自发送循环里顺手记的快照,过期上限约 1 个块（约 92.88 ms）。"""
        sessions = list(_live_sessions.values())
        return web.json_response({
            "connections": len(sessions),
            "sessions": sessions,
            "logPath": str(LOAD_LOG_PATH),
        })

    async def decoder(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=15.0, max_msg_size=64 * 1024)
        await ws.prepare(request)

        # 每个连接一套池子和后端实例 —— 跨块状态不能在连接之间串。
        session = Session(
            pool=VoicePool(size=config.pool_size, sample_rate=config.sample_rate),
            backend=make_backend(config),
            config=config,
        )
        # 2026-07-22:试过把这行放线程池 + 超时(防一条连接卡死拖垮全部后续
        # 连接),但线程池会让这条连接的 GPU 建 stream/标定渲染跟其它正在收流
        # 的连接的 render() 真并发抢 GPU(原来单线程事件循环上不可能出现这种
        # 重叠),导致所有人正常播放时都卡顿——比它想防的问题更糟,当天撤回。
        # 真正的卡死根因是客户端 connectTimeoutMs 太短(见 voice-client.js),
        # 已经在那边修了,这里维持原来的同步调用。
        session.backend.load()

        # 分轨由连接时决定,之后不可变。后端不支持真分轨时不宣告,免得前端
        # 拿到一堆静音轨还以为自己接错了 —— 宁可明说降级。
        want_split = request.query.get("split") in ("1", "true", "yes")
        session.split = want_split and getattr(session.backend, "supports_split", False)
        if want_split and not session.split:
            print(f"[conn] 请求分轨但后端 {session.backend.backend_id} 不支持，"
                  f"降级为混合立体声", flush=True)

        peer = request.remote or "?"
        conn_id = f"{peer}#{id(ws) & 0xffff:04x}"
        conn_started = time.monotonic()
        print(f"[conn {conn_id}] 已连接，后端 {session.backend.backend_id}", flush=True)

        await ws.send_json({
            "type": "ready",
            **status_payload(),
            # 通道布局按本连接的实际情况覆盖 status_payload 的默认值 ——
            # status 是服务级描述,ready 是这条连接的事实。
            "split": session.split,
            "channels": session.channels,
            "pcmFormat": ("f32-interleaved-tracks" if session.split
                          else "f32-interleaved-stereo"),
            "trackCount": config.pool_size if session.split else 1,
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
                    elif kind == "panic":
                        session.handle_panic(payload)
                    elif kind == "control":
                        session.handle_control(payload)
                    elif kind == "buffer":
                        session.handle_buffer(payload)
                except (ValueError, TypeError, KeyError) as error:
                    await ws.send_json({"type": "error", "message": f"坏帧: {error}"})

        receiver = asyncio.create_task(receive())
        block_seconds = config.block_seconds
        exit_reason = "客户端关闭"
        render_ms_window: list[float] = []   # 两次落盘之间的样本,用来报 p95 而不只是最后一块
        consecutive_render_errors = 0
        try:
            # aiohttp 服务端的 ``ws.closed`` 不保证在对端 close frame 到达后
            # 立即变 True；但 receive 的 async-for 会结束。两者都看，否则
            # 一个已退出的测试/浏览器会永久留下一套 backend 和 CUDA streams。
            while not ws.closed and not receiver.done():
                started = time.perf_counter()
                try:
                    interleaved, render_ms = session.render(config.block_samples)
                    consecutive_render_errors = 0
                except Exception:
                    # 渲染异常不再杀连接(2026-07-21:一个 voice 的缓冲越界曾把
                    # 整条会话炸进客户端 fallback)。发零块顶位、大声记日志、
                    # 给后端一个自愈机会(下个 note_on 会重建全部逐音状态)。
                    # 连续炸 ~9 秒还不好才放弃这条连接。
                    consecutive_render_errors += 1
                    if consecutive_render_errors <= 3 or consecutive_render_errors % 100 == 0:
                        import traceback

                        print(
                            f"[conn {conn_id}] 渲染块异常(连续第 "
                            f"{consecutive_render_errors} 次),本块发静音:",
                            flush=True,
                        )
                        traceback.print_exc()
                    if consecutive_render_errors >= 200:
                        exit_reason = "服务端渲染持续异常"
                        break
                    interleaved = np.zeros(
                        config.block_samples * session.channels, dtype=np.float32
                    )
                    render_ms = 0.0
                await ws.send_bytes(interleaved.astype("<f4", copy=False).tobytes())
                session.blocks_sent += 1
                # 帧数与通道数无关 —— 一帧就是一个采样时刻,分轨只是每帧多几个数。
                session.frames_since_report += config.block_samples
                render_ms_window.append(render_ms)

                if session.blocks_sent % TELEMETRY_EVERY_BLOCKS == 0:
                    # 遥测的 db 是「听感电平」,所以分轨要先按帧求和还原成混合,
                    # 不能像立体声那样取 [0::2] —— pool=4 时那等于把 0/2 两轨
                    # 交错着取,量出来的东西没有意义。
                    ch = session.channels
                    frames = interleaved.reshape(-1, ch)
                    mix = frames.sum(1) if session.split else frames[:, 0]
                    mono_rms = float(np.sqrt(np.mean(np.square(mix, dtype=np.float64))))
                    telemetry = session.telemetry(mono_rms, render_ms)
                    await ws.send_json(telemetry)
                    # 外部可查的负载快照。**不用连 WS 就能看**——用户正在漫游时
                    # 想知道负载,不该逼着再开一条连接去测(那会让 Session 多建
                    # 一份 voice 池和后端实例,等于把要测的东西自己改大一倍)。
                    _live_sessions[conn_id] = {
                        "connId": conn_id,
                        "split": session.split,
                        "channels": session.channels,
                        "activeVoices": telemetry["activeVoices"],
                        "renderMs": round(render_ms, 3),
                        "db": telemetry["db"],
                        "aliveSeconds": round(time.monotonic() - conn_started, 1),
                    }

                if session.blocks_sent % LOAD_LOG_EVERY_BLOCKS == 0 and render_ms_window:
                    arr = np.asarray(render_ms_window)
                    _append_load_log({
                        "t": time.time(), "connId": conn_id,
                        "activeConnections": len(_live_sessions),
                        "activeVoices": session.pool.active(),
                        "split": session.split,
                        "renderMsP50": round(float(np.percentile(arr, 50)), 3),
                        "renderMsP95": round(float(np.percentile(arr, 95)), 3),
                        "renderMsMax": round(float(arr.max()), 3),
                        "budgetMs": round(block_seconds * 1000, 3),
                        "underruns": session.underruns,
                    })
                    render_ms_window.clear()

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
            _live_sessions.pop(conn_id, None)
            receiver.cancel()
            try:
                await receiver
            except asyncio.CancelledError:
                pass
            session.backend.close()
        return ws

    @web.middleware
    async def frontend_cache_policy(
        request: web.Request,
        handler: Callable[[web.Request], Awaitable[web.StreamResponse]],
    ) -> web.StreamResponse:
        response = await handler(request)
        # 前端是直接覆盖挂载目录发布的。若让浏览器启发式缓存 ES modules，部署
        # 瞬间可能把新 main.js 与旧子模块拼在一起，产生“does not provide an
        # export named ...”这类并不存在于同一 Git tree 的错误。HTML/JS/CSS
        # 体积小且只在加载时请求，生产统一 no-store，保证一个页面只运行一版。
        if config.static and request.method in {"GET", "HEAD"}:
            suffix = Path(request.path).suffix.lower()
            if request.path == "/" or suffix in {".html", ".js", ".css"}:
                response.headers["Cache-Control"] = "no-store"
        return response

    app = web.Application(middlewares=[frontend_cache_policy])
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/api/decoder-status", decoder_status)
    app.router.add_get("/api/load", load_status)
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
            release_info = ReleaseInfo(
                "unknown", "unknown", "legacy-decoder", 1, "browser", "legacy"
            )
            runner = web.AppRunner(build_app(config, release_info))
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
            base = f"http://127.0.0.1:{port}"
            try:
                async with aiohttp.ClientSession() as http:
                    async with http.get(f"{base}/healthz") as response:
                        health = await response.json()
                    assert health["ok"] is True
                    assert health["releaseRevision"] == "unknown"
                    assert health["sourceManifestSha256"] == "unknown"
                    assert health["protocolFamily"] == "legacy-decoder"
                    assert health["protocolVersion"] == 1
                    assert health["runtimeOwner"] == "browser"
                    assert health["audioOwner"] == "legacy"
                    async with http.get(f"{base}/api/decoder-status") as response:
                        status = await response.json()
                    assert status["channels"] == 2
                    assert status["pcmFormat"] == "f32-interleaved-stereo"
                    assert status["releaseRevision"] == "unknown"
                    assert status["sourceManifestSha256"] == "unknown"
                    assert status["protocolFamily"] == "legacy-decoder"
                    assert status["protocolVersion"] == 1
                    assert status["runtimeOwner"] == "browser"
                    assert status["audioOwner"] == "legacy"
                    print(f"[1] HTTP 端点 OK: {status['models'][0]['id']}")

                    async with http.ws_connect(f"{base}/decoder") as ws:
                        ready = await ws.receive_json()
                        assert ready["type"] == "ready", ready
                        assert ready["releaseRevision"] == "unknown"
                        assert ready["sourceManifestSha256"] == "unknown"
                        assert ready["protocolFamily"] == "legacy-decoder"
                        assert ready["protocolVersion"] == 1
                        assert ready["runtimeOwner"] == "browser"
                        assert ready["audioOwner"] == "legacy"
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
