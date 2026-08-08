#!/usr/bin/env python3
"""通过已运行的 neural WebSocket 验证四复音。

这不创建替代模型：脚本只是客户端，音频由服务当前加载的真实
MidiBrave / TrajectoryBrave checkpoint 产生。用 ``?split=1`` 直接检查每个
row 的干声，同时记录服务端回报的 render 时间。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import time

import aiohttp
import numpy as np


REPORT_INTERVAL_SECONDS = 32 * 128 / 48_000
PRIME_FRAMES = 4096


class PlaybackClock:
    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = sample_rate
        self.received = 0
        self.started_at: float | None = None
        self.underruns = 0
        self._empty = False

    def push(self, frames: int) -> None:
        self.received += frames
        if self.started_at is None and self.received >= PRIME_FRAMES:
            self.started_at = time.monotonic()

    def buffered(self) -> int:
        if self.started_at is None:
            return self.received
        consumed = int((time.monotonic() - self.started_at) * self.sample_rate)
        buffered = self.received - consumed
        if buffered < 0:
            if not self._empty:
                self.underruns += 1
                self._empty = True
            return 0
        self._empty = False
        return buffered


async def verify(host: str, port: int, blocks: int) -> dict:
    timeout = aiohttp.ClientTimeout(total=300)
    base = f"http://{host}:{port}"
    async with aiohttp.ClientSession(timeout=timeout) as http:
        async with http.get(f"{base}/api/decoder-status") as response:
            response.raise_for_status()
            status = await response.json()

        backend = status["models"][0]
        if backend.get("engine") != "midibrave-v2-voices":
            raise RuntimeError(f"拒绝非神经后端: {backend.get('engine')}")
        if backend.get("polyphony") != 4 or backend.get("poolSize") != 16:
            raise RuntimeError(f"后端不是 4 复音 / 16 row: {backend}")

        rows_by_species = backend["rowsBySpecies"]
        sample_rate = int(backend["sampleRate"])
        block_samples = int(backend["blockSamples"])
        budget_ms = block_samples / sample_rate * 1000.0
        clock = PlaybackClock(sample_rate)
        next_report = time.monotonic() + REPORT_INTERVAL_SECONDS
        current_species: str | None = None
        telemetry: dict[str, list[float]] = {name: [] for name in rows_by_species}
        active_counts: dict[str, list[int]] = {name: [] for name in rows_by_species}
        last_audio_at: float | None = None
        receive_gaps_ms: list[float] = []

        async with http.ws_connect(f"{base}/decoder?split=1", max_msg_size=0) as ws:
            ready = await ws.receive_json()
            if not ready.get("split") or ready.get("channels") != 16:
                raise RuntimeError(f"未得到 16 轨分轨流: {ready}")

            async def receive_audio() -> np.ndarray:
                nonlocal next_report, last_audio_at
                while True:
                    message = await ws.receive()
                    if message.type is aiohttp.WSMsgType.BINARY:
                        frame = np.frombuffer(message.data, dtype="<f4")
                        frame = frame.reshape(-1, int(ready["channels"]))
                        received_at = time.monotonic()
                        if last_audio_at is not None:
                            receive_gaps_ms.append((received_at - last_audio_at) * 1000.0)
                        last_audio_at = received_at
                        clock.push(len(frame))
                        now = time.monotonic()
                        if now >= next_report:
                            await ws.send_json({
                                "type": "buffer",
                                "bufferedFrames": clock.buffered(),
                                "underruns": clock.underruns,
                            })
                            next_report = now + REPORT_INTERVAL_SECONDS
                        return frame
                    if message.type is aiohttp.WSMsgType.TEXT:
                        payload = json.loads(message.data)
                        if payload.get("type") == "telemetry" and current_species:
                            telemetry[current_species].append(float(payload["renderMs"]))
                            active_counts[current_species].append(int(payload["activeVoices"]))
                        elif payload.get("type") == "error":
                            raise RuntimeError(payload["message"])
                    elif message.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        raise RuntimeError("WebSocket 在验证中断开")

            # 真实 worklet 会在目标水位附近工作；先收到约 300ms 静音再起键，
            # 避免把“刚採到一块就起播”的测试器假象计入模型卡顿。
            for _ in range(6):
                await receive_audio()

            results = {}
            for species, rows in rows_by_species.items():
                if len(rows) != 4:
                    raise RuntimeError(f"{species} 不是 4 rows: {rows}")
                current_species = species
                underruns_before = clock.underruns
                gap_start = len(receive_gaps_ms)
                notes = (48, 55, 60, 67) if species == "bass" else (60, 64, 67, 72)
                await ws.send_json({
                    "type": "control",
                    "voices": [
                        {"voice": row, "midi": note, "velocity": 0.8, "gate": True,
                         "timbreXY": [0.0, 0.0], "timbreK": 4}
                        for row, note in zip(rows, notes, strict=True)
                    ],
                })

                energy = {row: 0.0 for row in rows}
                samples = 0
                finite = True
                for index in range(blocks):
                    frame = await receive_audio()
                    if index >= 4:  # 略过起音的四个缓冲块
                        samples += len(frame)
                        finite = finite and bool(np.isfinite(frame[:, rows]).all())
                        for row in rows:
                            energy[row] += float(np.square(frame[:, row], dtype=np.float64).sum())

                rms = {str(row): math.sqrt(energy[row] / max(1, samples)) for row in rows}
                render_ms = telemetry[species]
                counts = active_counts[species]
                p95 = float(np.percentile(render_ms, 95)) if render_ms else math.inf
                if not finite or any(value <= 1e-4 for value in rms.values()):
                    raise RuntimeError(f"{species} 分轨静音或非有限值: {rms}")
                if 4 not in counts:
                    raise RuntimeError(f"{species} 遥测没看到 4 个 active voices: {counts}")
                if p95 > budget_ms:
                    raise RuntimeError(
                        f"{species} render p95={p95:.2f}ms 超过 {budget_ms:.2f}ms 块预算"
                    )
                results[species] = {
                    "rows": rows,
                    "rms": {row: round(value, 6) for row, value in rms.items()},
                    "renderMsP50": round(float(np.percentile(render_ms, 50)), 3),
                    "renderMsP95": round(p95, 3),
                    "renderMsMax": round(max(render_ms), 3),
                    "telemetrySamples": len(render_ms),
                    "maxAudioGapMs": round(max(receive_gaps_ms[gap_start:], default=0.0), 3),
                    "clientUnderruns": clock.underruns - underruns_before,
                }

                for row in rows:
                    await ws.send_json({"type": "panic", "voice": row})
                for _ in range(2):
                    await receive_audio()

        return {
            "engine": backend["engine"],
            "poolSize": backend["poolSize"],
            "polyphony": backend["polyphony"],
            "budgetMs": round(budget_ms, 3),
            "clientUnderruns": clock.underruns,
            "species": results,
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify real four-voice neural rendering")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8092)
    parser.add_argument("--blocks", type=int, default=32)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(verify(args.host, args.port, args.blocks)), indent=2))


if __name__ == "__main__":
    main()
