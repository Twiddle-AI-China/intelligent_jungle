"""G1 gate smoke: measure server-sequencer trigger jitter end to end.

Run the realtime server first, e.g.:

    uv run python -m latent_cosmos_research.realtime_server \
        --model ../models/brave-multidim/latent_cosmos_brave_16d_streaming.ts \
        --offline-model ../models/brave-multidim/latent_cosmos_brave_16d.ts \
        --corpus ../data/corpus/v1 --root .. --port 4183

then:

    uv run python scripts/g1_trigger_jitter_smoke.py 4183

Sends transport 120 BPM / one 4-beat loop and a single note at beat 0,
records PCM, detects envelope onsets, and checks the steady-state loop
spacing against the ideal 2.0 s. The very first gap is excluded: transport
start is not aligned to a musical instant (playing begins inside whichever
block the message lands in), so only loop-to-loop spacing counts for G1.

Measured 2026-07-17 on M4, BRAVE 16d streaming: steady-state |error|
max 0.07 ms across 3 loops (target < 5 ms).
"""
import asyncio
import json
import sys

import aiohttp
import numpy as np

SAMPLE_RATE = 44_100
LOOP_SECONDS = 2.0
TARGET_MS = 5.0


async def collect_pcm(port: int, seconds: float) -> np.ndarray:
    pcm = []
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(f"ws://127.0.0.1:{port}/decoder?model=brave-16d") as ws:
            ready = json.loads((await ws.receive()).data)
            if ready.get("type") != "ready":
                raise RuntimeError(f"unexpected handshake: {ready}")
            await ws.send_json({"type": "control", "voices": [{
                "objectId": 0, "species": "pulse", "decoderId": "brave-16d",
                "relationState": [0.0] * 8, "latentStep": 0.16,
                "noteGroups": [], "pitchSemitones": 0.0,
                "triggerSerial": 0, "triggerStrength": 0.0,
                "pan": 0.0, "energy": 0.8, "muted": False, "solo": False,
            }]})
            await ws.send_json({"type": "chord", "rootMidi": 57, "quality": "minor"})
            await ws.send_json({"type": "pattern", "objectId": 0,
                                "notes": [{"beat": 0.0, "midi": 60, "durBeats": 0.4, "vel": 1.0}]})
            await ws.send_json({"type": "transport", "bpm": 120, "beatsPerBar": 4,
                                "loopBars": 1, "playing": True})
            await ws.send_json({"type": "buffer", "bufferedFrames": 8192, "underruns": 0})
            total = 0
            while total < seconds * SAMPLE_RATE:
                message = await ws.receive()
                if message.type == aiohttp.WSMsgType.BINARY:
                    block = np.frombuffer(message.data, dtype="<f4").reshape(-1, 2).mean(axis=1)
                    pcm.append(block)
                    total += len(block)
                elif message.type == aiohttp.WSMsgType.TEXT:
                    payload = json.loads(message.data)
                    if payload.get("type") == "error":
                        raise RuntimeError(str(payload))
                else:
                    raise RuntimeError(f"socket closed early: {message}")
    return np.concatenate(pcm)


def detect_onsets(audio: np.ndarray) -> list[int]:
    window = 256
    rms = np.sqrt(np.convolve(audio ** 2, np.ones(window) / window, mode="same") + 1e-12)
    floor = np.quantile(rms, 0.2)
    hot = rms > max(float(floor) * 4.0, 1e-4)
    onsets: list[int] = []
    for edge in np.flatnonzero(hot[1:] & ~hot[:-1]):
        if not onsets or edge - onsets[-1] > 0.5 * SAMPLE_RATE:
            onsets.append(int(edge))
    return onsets


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4183
    audio = asyncio.run(collect_pcm(port, seconds=9.0))
    onsets = detect_onsets(audio)
    print(f"onsets: {onsets}")
    if len(onsets) < 4:
        print("FAIL: need at least 4 onsets (3 loop gaps)")
        sys.exit(1)
    gaps = np.diff(onsets)[1:]  # drop the unaligned transport-start gap
    errors_ms = (gaps - LOOP_SECONDS * SAMPLE_RATE) / (SAMPLE_RATE / 1000.0)
    worst = float(np.max(np.abs(errors_ms)))
    print(f"steady-state gaps={gaps.tolist()} error(ms)={np.round(errors_ms, 3).tolist()}")
    print(f"max |error| = {worst:.3f} ms (G1 target < {TARGET_MS} ms)")
    sys.exit(0 if worst < TARGET_MS else 1)


if __name__ == "__main__":
    main()
