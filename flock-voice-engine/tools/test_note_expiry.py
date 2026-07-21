#!/usr/bin/env python3
"""回归：2026-07-21「每个自然到期的音都把会话炸进 fallback」事故。

根因：v2 随机激励缓冲只按「声明时长 + warmup/tail + 8192 采样余量」生成，
release 尾巴（默认 0.40 s ≈ 17,640 采样 >> 余量）继续渲染时切片越界，
`excitation_bands` 里 `deterministic + buf[..., f0:f0+flen]` 形状不匹配，
RuntimeError 把整条 WS 会话打死 → 客户端掉回本地 WebAudio。hold/gate 起音
还用着 stale duration（默认 1.0 s），按住超过 ~1.2 s 同样炸。

修复四层：
1. `excitation_bands` 越界时重复末帧补齐（冻结噪声包络，不炸）——Part 1b 验。
2. `prepare_note_stochastic` 的时长含 release 尾巴（brave_voices.note_on）——Part 1a/2 验。
3. gate/hold 起音按 `GATE_NOTE_BUFFER_SECONDS`（30 s）备缓冲——Part 3 验。
4. app.py 发送循环渲染异常改发零块不杀连接——Part 2/3 顺带验（连接全程存活）。

用法（在 Spark 上跑，模型在 /data/model_weights/midiBrave/）：

    python3 tools/test_note_expiry.py            # 全部
    python3 tools/test_note_expiry.py unit       # 只 Part 1（无服务，约半分钟）
    python3 tools/test_note_expiry.py ws         # 只 Part 2/3（要服务在 8090）
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

WS_URL = "ws://127.0.0.1:8090/decoder"


def part1_unit() -> bool:
    """backend 层集成 + 直接越界调用。旧代码在 1a 的 release 中段必抛 RuntimeError。"""
    import numpy as np

    from server.backends.brave_voices import ROW_VOICES, MultiVoiceBraveBackend
    from server.voices import Voice

    backend = MultiVoiceBraveBackend(sample_rate=44100, pool_size=len(ROW_VOICES), block_samples=2048)
    backend.load()

    # -- 1a: 起音 1.0 s → note_off → release 全程渲染完，不得抛异常 ----------
    v = Voice(row=0)
    v.midi, v.velocity, v.duration_seconds, v.gate = 60, 1.0, 1.0, True
    backend.note_on(v)
    for _ in range(22):  # 22 × 2048 ≈ 1.02 s，播完声明时长
        backend.render_split([v], 2048)
    backend.note_off(v)
    release_blocks = []
    for _ in range(12):  # 12 块 ≈ 0.56 s > release 0.40 s，覆盖整条尾巴
        release_blocks.append(backend.render_split([v], 2048))
    tail = np.concatenate([b[0] for b in release_blocks])
    rms = float(np.sqrt(np.mean(tail.astype(np.float64) ** 2)))
    print(f"[1a] note_off 后 release 全程渲染完成，尾巴 RMS={rms:.5f}（旧代码中段必炸）")
    ok = rms > 1e-5  # 尾巴不该是全零（增益斜坡前半段一定有信号）

    # -- 1b: 直接打越界点，形状契约必须不变 ---------------------------------
    vb = backend._backends[0]
    bands = vb.config.model.pqmf_bands
    buf_len = vb._stochastic_buffer(vb._active_total_frames_pqmf).shape[-1]
    sr = vb.geometry.sample_rate
    for label, start_sample in (
        ("跨界切片（缓冲尾-64 帧起）", (buf_len - 64) * bands),
        ("远超界（35 s 位置）", int(35.0 * sr)),
    ):
        out = vb.excitation_bands(60, start_sample, 2048)
        expect = 2048 // bands
        good = out.shape[-1] == expect
        ok &= good
        print(f"[1b] {label}: → shape={tuple(out.shape)} "
              f"{'OK' if good else f'FAIL（期望末维 {expect}）'}")
    return ok


async def _session(label: str, frames: list[dict], seconds: float) -> bool:
    """开一条真实 WS，按剧本发帧（__sleep__ 为等待），全程消费，报连接死活。"""
    import aiohttp

    blocks = 0
    try:
        async with aiohttp.ClientSession() as s:
            async with s.ws_connect(WS_URL) as ws:
                ready = json.loads((await ws.receive()).data)
                block_bytes = ready["blockSamples"] * ready["channels"] * 4

                async def consume() -> None:
                    nonlocal blocks
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.BINARY:
                            assert len(msg.data) == block_bytes, (
                                f"块 {len(msg.data)}B != {block_bytes}B")
                            blocks += 1

                consumer = asyncio.create_task(consume())
                started = time.monotonic()
                try:
                    for frame in frames:
                        if frame.get("type") == "__sleep__":
                            await asyncio.sleep(float(frame["seconds"]))
                        else:
                            await ws.send_json(frame)
                    remain = seconds - (time.monotonic() - started)
                    if remain > 0:
                        await asyncio.sleep(remain)
                finally:
                    consumer.cancel()
                    try:
                        await consumer
                    except asyncio.CancelledError:
                        pass
    except Exception as error:  # 连接被服务端打死 / 超时 / 块大小断言失败
        print(f"[{label}] 连接中断: {error.__class__.__name__}: {error}（{blocks} 块）")
        return False
    print(f"[{label}] {seconds:.1f} s 全程连接存活（{blocks} 块）")
    return True


def part23_ws() -> bool:
    ok = True
    # Part 2：duration 音自然到期 + release 全程。旧代码必在 ~时长+0.19 s 炸。
    ok &= asyncio.run(_session(
        "note→release",
        [{"type": "note", "voice": 1, "midi": 60, "velocity": 0.68,
          "durationSeconds": 1.0}],
        seconds=4.0,
    ))
    # Part 3：gate 按住 2 s 再松开，松开后活到 release 播完。
    # 旧代码 hold 用 stale duration（默认 1.0 s），release 同样越界炸。
    ok &= asyncio.run(_session(
        "hold→release",
        [{"type": "control", "voices": [{"voice": 0, "midi": 55, "velocity": 1.0,
                                         "gate": True}]},
         {"type": "__sleep__", "seconds": 2.0},
         {"type": "control", "voices": [{"voice": 0, "gate": False}]}],
        seconds=5.0,
    ))
    return ok


def main() -> int:
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    ok = True
    if which in ("all", "unit"):
        ok &= part1_unit()
    if which in ("all", "ws"):
        ok &= part23_ws()
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
