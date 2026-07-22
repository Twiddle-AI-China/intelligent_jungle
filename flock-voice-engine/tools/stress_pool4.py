"""四轨满载并发压测 —— 逼出最坏情况的 renderMs。

## 跟 smoke_client 的分工

``smoke_client.py`` 验的是**正确性**（无爆音/无 underrun/电平/声道），
曲目稀疏、声部错开，最坏时也就两三个声部同时响。

但 ``brave.py:390`` 对未激活的 voice 是 ``continue`` 跳过的 ——
**pool=4 而只有 1 个在响时，成本等于 pool=1**。
所以稀疏曲目量不到四轨满载的真实开销。

本脚本反过来：**让四个声部始终都在发声**，音符到期立刻续上，
把 renderMs 的 p95/max 逼到最坏，看还剩多少余量。

## 判据

块长 2048 → 硬截止 46.44 ms。renderMs p95 超过它就是要 underrun 了。
另外单独看 max —— 实时音频里一次超时就是一次可闻的爆音，均值好看没有用。

用法::

    .venv/bin/python tools/stress_pool4.py --seconds 30
    .venv/bin/python tools/stress_pool4.py --seconds 30 --voices 4 --roam
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time

import aiohttp
import numpy as np

RING_SECONDS = 1.5
PRIME_FRAMES = 4096
REPORT_EVERY_BLOCKS = 32
#: 训练边界内、四个声部各占一个音区，避免撞在同一频段听不出来
VOICE_NOTES = [43, 55, 67, 79]


async def run(args: argparse.Namespace) -> int:
    url = f"http://{args.host}:{args.port}"
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{url}/api/decoder-status") as resp:
            status = (await resp.json())["models"][0]
        sr = status["sampleRate"]
        block = status["blockSamples"]
        pool = status["poolSize"]
        channels = pool if args.split else 2
        budget = block / sr * 1000
        print(f"服务端: pool={pool} block={block} @ {sr} Hz → 硬截止 {budget:.2f} ms"
              f"{' · 分轨 ' + str(channels) + ' 通道' if args.split else ' · 混合立体声'}")
        if pool < args.voices:
            print(f"⚠️ 服务端 pool={pool} < 请求的 {args.voices} 轨，多余的行不会发声")

        render_ms: list[float] = []
        buffered_frames: list[int] = []
        underruns = 0
        received = 0
        capacity = int(sr * RING_SECONDS)
        ring = 0
        playing = False
        next_note = [0.0] * args.voices

        q = f"?model={status['id']}" + ("&split=1" if args.split else "")
        async with session.ws_connect(f"ws://{args.host}:{args.port}/decoder{q}") as ws:
            t0 = time.perf_counter()
            blocks = 0
            while True:
                now = time.perf_counter() - t0
                if now >= args.seconds:
                    break

                # 让每一轨始终在发声：到期立刻续上一个音
                for row in range(args.voices):
                    if now >= next_note[row]:
                        dur = args.note_seconds
                        payload = {
                            "type": "note", "voice": row,
                            "midi": VOICE_NOTES[row % len(VOICE_NOTES)],
                            "velocity": 1.0, "durationSeconds": dur,
                        }
                        if args.roam:
                            # 音色漫游同时进行 —— 漫游会每块重算 z 轨迹，是额外开销
                            payload["timbre"] = (blocks // 8) % 9
                        await ws.send_json(payload)
                        # 略早于到期续音，保证不留空隙（last-note-priority 会抢占）
                        next_note[row] = now + dur * 0.85

                try:
                    msg = await asyncio.wait_for(ws.receive(), timeout=2.0)
                except asyncio.TimeoutError:
                    print("✗ 2 秒没收到任何数据")
                    return 1

                if msg.type == aiohttp.WSMsgType.BINARY:
                    # 帧数 = 字节数 / (4 字节 × 通道数)。分轨时通道数 = 轨数。
                    frames = len(msg.data) // (4 * channels)
                    received += frames
                    ring = min(ring + frames, capacity)
                    blocks += 1
                    if not playing and ring >= PRIME_FRAMES:
                        playing = True
                    if playing:
                        # 模拟 worklet 消费：按真实时间流逝取走样本
                        consumed = int(frames)
                        if ring < consumed:
                            underruns += 1
                            playing = False
                            ring = 0
                        else:
                            ring -= consumed
                    if blocks % REPORT_EVERY_BLOCKS == 0:
                        await ws.send_json({"type": "buffer",
                                            "bufferedFrames": ring,
                                            "underruns": underruns})
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    if data.get("type") == "telemetry":
                        if "renderMs" in data:
                            render_ms.append(float(data["renderMs"]))
                        buffered_frames.append(ring)
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    print("✗ 连接断开")
                    return 1

    if not render_ms:
        print("✗ 没收到任何 renderMs telemetry")
        return 1

    arr = np.array(render_ms)
    p50, p95, p99 = (float(np.percentile(arr, p)) for p in (50, 95, 99))
    mx = float(arr.max())
    over = int((arr > budget).sum())
    print(f"\n{len(arr)} 次渲染 · {args.voices} 轨满载"
          f"{' + 音色漫游' if args.roam else ''}")
    print(f"  p50 {p50:6.2f} ms   p95 {p95:6.2f} ms   p99 {p99:6.2f} ms   max {mx:6.2f} ms")
    print(f"  硬截止 {budget:.2f} ms → 余量 p95 {budget - p95:+.2f} ms / max {budget - mx:+.2f} ms")
    print(f"  超时块 {over}/{len(arr)} ({over / len(arr) * 100:.1f}%)   "
          f"模拟 underrun {underruns} 次")
    print(f"  收到 {received} 帧 ≈ {received / 44100:.2f}s 音频（录制 {args.seconds}s）")

    ok = over == 0 and underruns == 0
    print(f"\n{'✅ 四轨满载留有余量' if ok else '✗ 满载下会掉块'}")
    return 0 if ok else 2


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--voices", type=int, default=4)
    ap.add_argument("--note-seconds", type=float, default=2.0)
    ap.add_argument("--roam", action="store_true", help="同时做音色漫游，额外开销")
    ap.add_argument("--split", action="store_true", help="分轨下行（通道数=轨数，带宽翻倍）")
    return asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
