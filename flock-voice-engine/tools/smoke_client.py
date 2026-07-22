"""最小自测客户端 —— 本项目的验收手段。

连上 ``/decoder``,按一小段固定曲目发 note 帧,把收到的 PCM 存成 WAV,然后校验:

    时长     收到的样本数与录制时长相符(说明服务端节奏没有慢性漏拍)
    无爆音   相邻样本跳变有上界(说明跨块相位/包络接上了)
    无 underrun  模拟 worklet 的环形缓冲,播放期间不饿死
    声道     左右完全相同(干声 mono 复制,服务端没偷偷做声像)
    电平     有声、不削顶、无直流

**它同时也是背压 pacing 的对手方**:这里如实模拟基线 worklet 的行为 ——
1.5 s 环形缓冲、攒够 4096 帧才起播、每 32 块回报一次水位。服务端的三档
pacing 只有在有真实回报时才有意义,所以这个模拟不能省。

用法::

    python3 server/app.py &                 # 另开一个终端
    python3 tools/smoke_client.py           # 默认连 127.0.0.1:8090
    python3 tools/smoke_client.py --seconds 12 --out /tmp/a.wav
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

import aiohttp
import numpy as np

# 基线 worklet 的参数,不要随便改 —— 改了就不再是对手方了
RING_SECONDS = 1.5
PRIME_FRAMES = 4096
REPORT_EVERY_BLOCKS = 32

#: 相邻样本跳变上限。44.1 kHz 下,幅度 0.5 的 2 kHz 正弦最大斜率约 0.14/样本,
#: 0.30 给足余量的同时仍能抓住块边界的阶跃。
MAX_SAMPLE_STEP = 0.30


@dataclass
class NoteEvent:
    """一个排定的 note。``at`` 是相对录制起点的秒数。"""

    at: float
    row: int
    timbre: str
    midi: int
    velocity: float
    duration: float


def default_score(pool_size: int) -> list[NoteEvent]:
    """一小段覆盖四种音色的曲目。

    池子只有 1 行(V1)时,所有音都落在第 0 行并靠切换 timbre 取得对比 ——
    顺便把 **last-note-priority 抢占**也测了(后一个音在前一个还在响时插进来)。
    """
    plan = [
        # (起始秒, 音色, 音高, 力度, 时长)
        (0.30, "pad", 50, 0.68, 2.5),
        (1.00, "bass", 38, 1.00, 1.8),
        (2.20, "pluck", 74, 0.68, 0.4),
        (2.70, "pluck", 79, 0.42, 0.4),
        (3.30, "lead", 67, 1.00, 1.2),
        (4.20, "pad", 55, 0.42, 2.0),
        (5.00, "bass", 43, 0.68, 1.5),
        (6.00, "lead", 72, 0.68, 0.8),   # 抢占:pad 还在响
        (6.80, "pluck", 86, 1.00, 0.3),
    ]
    return [
        NoteEvent(at=at, row=index % pool_size, timbre=timbre, midi=midi,
                  velocity=velocity, duration=duration)
        for index, (at, timbre, midi, velocity, duration) in enumerate(plan)
    ]


@dataclass
class RingBufferModel:
    """模拟客户端 worklet 的环形缓冲,只为算出真实的水位和 underrun。"""

    sample_rate: int
    capacity_frames: int = 0
    received_frames: int = 0
    playing: bool = False
    play_started_at: float = 0.0
    consumed_at_start: int = 0
    underruns: int = 0
    overflow_frames: int = 0
    _last_buffered: int = field(default=0, repr=False)

    def __post_init__(self) -> None:
        self.capacity_frames = int(RING_SECONDS * self.sample_rate)

    def push(self, frames: int) -> None:
        self.received_frames += frames
        if not self.playing and self.received_frames >= PRIME_FRAMES:
            # 攒够起播量,播放时钟从此刻开始走
            self.playing = True
            self.play_started_at = time.monotonic()
            self.consumed_at_start = 0

    def buffered(self) -> int:
        """当前水位(帧)。没起播就是已收全部。"""
        if not self.playing:
            return self.received_frames
        consumed = int((time.monotonic() - self.play_started_at) * self.sample_rate)
        level = self.received_frames - consumed
        if level < 0:
            # 缓冲见底 = worklet 会输出静音 = 可听的断裂
            self.underruns += 1
            level = 0
        if level > self.capacity_frames:
            self.overflow_frames += level - self.capacity_frames
            level = self.capacity_frames
        self._last_buffered = level
        return level


async def run(args: argparse.Namespace) -> int:
    base = f"http://{args.host}:{args.port}"
    async with aiohttp.ClientSession() as http:
        # 先探 status,拿到采样率和池子大小再排曲目
        async with http.get(f"{base}/api/decoder-status") as response:
            status = await response.json()
        sample_rate = int(status["sampleRate"])
        pool_size = int(status["poolSize"])
        print(f"服务端: {status['models'][0]['id']} · {sample_rate} Hz · pool={pool_size} "
              f"· {status['pcmFormat']}")

        score = default_score(pool_size)
        ring = RingBufferModel(sample_rate=sample_rate)
        chunks: list[np.ndarray] = []
        pending = list(score)
        telemetry_count = 0

        async with http.ws_connect(f"{base}/decoder", max_msg_size=0) as ws:
            ready = await ws.receive_json()
            if ready.get("type") != "ready":
                print(f"没收到 ready 帧: {ready}")
                return 1

            started = time.monotonic()
            blocks = 0
            while True:
                now = time.monotonic() - started
                if now >= args.seconds:
                    break

                # 到点就发 note
                while pending and pending[0].at <= now:
                    note = pending.pop(0)
                    await ws.send_json({
                        "type": "note",
                        "voice": note.row,
                        "midi": note.midi,
                        "velocity": note.velocity,
                        "durationSeconds": note.duration,
                        "timbre": note.timbre,
                    })
                    print(f"  {now:5.2f}s  note row={note.row} {note.timbre:<5} "
                          f"midi={note.midi} vel={note.velocity} dur={note.duration}s")

                try:
                    message = await asyncio.wait_for(ws.receive(), timeout=5.0)
                except asyncio.TimeoutError:
                    print("接收超时,服务端停流了")
                    return 1

                if message.type is aiohttp.WSMsgType.BINARY:
                    block = np.frombuffer(message.data, dtype="<f4")
                    chunks.append(block)
                    ring.push(len(block) // 2)
                    blocks += 1
                    if blocks % REPORT_EVERY_BLOCKS == 0:
                        await ws.send_json({
                            "type": "buffer",
                            "bufferedFrames": ring.buffered(),
                            "underruns": ring.underruns,
                        })
                elif message.type is aiohttp.WSMsgType.TEXT:
                    if json.loads(message.data).get("type") == "telemetry":
                        telemetry_count += 1
                elif message.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    print("连接被关闭")
                    return 1

    if not chunks:
        print("一块音频都没收到")
        return 1

    interleaved = np.concatenate(chunks)
    left, right = interleaved[0::2], interleaved[1::2]
    write_wav(Path(args.out), interleaved, sample_rate)
    return verify(left, right, sample_rate, args, ring, telemetry_count, Path(args.out))


def write_wav(path: Path, interleaved: np.ndarray, sample_rate: int) -> None:
    """写立体声 WAV。有 soundfile 就存 float32,没有就用标准库转 PCM16。

    Spark 上不一定装了 soundfile,验收工具不该因为一个可选依赖跑不起来。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        import soundfile as sf

        sf.write(path, interleaved.reshape(-1, 2), sample_rate, subtype="FLOAT")
        print(f"WAV 已写出(float32): {path}")
    except ImportError:
        clipped = np.clip(interleaved, -1.0, 1.0)
        pcm16 = (clipped * 32767.0).astype("<i2")
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(pcm16.tobytes())
        print(f"WAV 已写出(PCM16,无 soundfile): {path}")


def verify(
    left: np.ndarray,
    right: np.ndarray,
    sample_rate: int,
    args: argparse.Namespace,
    ring: RingBufferModel,
    telemetry_count: int,
    path: Path,
) -> int:
    """逐项验收。任一项不过就返回非零 —— 这是 CI 能直接用的退出码。"""
    checks: list[tuple[str, bool, str]] = []
    mono = left.astype(np.float64)
    seconds = len(left) / sample_rate

    # 1) 时长:收到的音频应当铺满录制时间。差太多说明服务端节奏跑偏。
    ratio = seconds / args.seconds
    checks.append((
        "时长", 0.90 <= ratio <= 1.15,
        f"{seconds:.2f}s / 录制 {args.seconds:.2f}s (比值 {ratio:.3f})",
    ))

    # 2) 无爆音:相邻样本跳变有上界
    step = float(np.abs(np.diff(mono)).max()) if len(mono) > 1 else 0.0
    checks.append(("无爆音", step < MAX_SAMPLE_STEP, f"最大跳变 {step:.4f} < {MAX_SAMPLE_STEP}"))

    # 3) 无 underrun
    checks.append(("无 underrun", ring.underruns == 0, f"{ring.underruns} 次"))

    # 4) 声道一致
    identical = bool(np.array_equal(left, right))
    checks.append(("左右一致", identical, "干声 mono 复制" if identical else "左右不同"))

    # 5) 电平:有声、不削顶
    peak = float(np.abs(mono).max())
    rms = float(np.sqrt(np.mean(np.square(mono))))
    checks.append(("有声", rms > 1e-4, f"RMS {rms:.5f} / peak {peak:.4f}"))
    checks.append(("不削顶", peak <= 0.999, f"peak {peak:.4f}"))

    # 6) 无直流
    dc = float(np.mean(mono))
    checks.append(("无直流", abs(dc) < 1e-3, f"DC {dc:+.6f}"))

    # 7) telemetry 有在发
    checks.append(("telemetry", telemetry_count > 0, f"{telemetry_count} 条"))

    print("\n验收:")
    failed = 0
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<12} {detail}")
        failed += 0 if ok else 1

    print(f"\n缓冲峰值水位约 {ring._last_buffered} 帧"
          f"({ring._last_buffered / sample_rate:.2f} s),溢出 {ring.overflow_frames} 帧")
    if failed:
        print(f"\n{failed} 项未通过 → {path}")
        return 1
    print(f"\n全部通过 → {path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="flock-voice-engine 冒烟测试客户端")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--seconds", type=float, default=9.0, help="录制时长")
    parser.add_argument(
        "--out", default=str(Path(__file__).resolve().parents[1] / "staging" / "smoke.wav"),
        help="WAV 输出路径",
    )
    args = parser.parse_args()
    try:
        return asyncio.run(run(args))
    except aiohttp.ClientConnectorError:
        print(f"连不上 {args.host}:{args.port} —— 服务起了吗?"
              f"\n  python3 server/app.py")
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
