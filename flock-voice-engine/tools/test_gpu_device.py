"""CPU vs GPU 实测：走生产路径的 ``brave-voices`` 四音色后端(不是裸 MidiBraveBackend)。

跟 ``bench_compute.py`` 的区别：那个测的是单音色 v1 backend 的流式前向,
这个测的是 ``server/backends/brave_voices.MultiVoiceBraveBackend`` ——
docker-run.sh 实际部署的类,pool=4、block=2048,四个 checkpoint 各自独立。
直接量「服务端配置 --device cuda 之后到底有没有用、稳不稳」,而不是纸面算力。

用法::

    .venv/bin/python tools/test_gpu_device.py --device cpu
    .venv/bin/python tools/test_gpu_device.py --device cuda
"""
from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SR = 44_100
BLOCK = 2048
BUDGET_MS = BLOCK / SR * 1000


class FakeVoice:
    """避开 server.voices.VoicePool 的完整依赖，只给后端要用到的字段。"""

    def __init__(self, row: int, midi: float, velocity: float = 0.85, gain: float = 1.0):
        self.row = row
        self.midi = midi
        self.velocity = velocity
        self.gain = gain
        self.timbre = 0
        self.timbre_xy = None
        self.timbre_k = 4
        self.duration_seconds = 6.0
        self.release_seconds = 0.4
        self.gate = True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--iters", type=int, default=60)
    ap.add_argument("--warmup", type=int, default=10)
    args = ap.parse_args()

    import torch

    from server.backends.brave_voices import ROW_VOICES, MultiVoiceBraveBackend

    print(f"[boot] device={args.device} torch={torch.__version__} "
          f"cuda_available={torch.cuda.is_available()}")

    t0 = time.perf_counter()
    backend = MultiVoiceBraveBackend(
        sample_rate=SR, pool_size=4, block_samples=BLOCK, device=args.device,
    )
    backend.load()
    load_s = time.perf_counter() - t0
    print(f"[load] {load_s:.2f}s，四个 checkpoint 都在 {args.device} 上")

    if args.device.startswith("cuda") and torch.cuda.is_available():
        torch.cuda.synchronize()
        allocated = torch.cuda.memory_allocated() / 1e6
        reserved = torch.cuda.memory_reserved() / 1e6
        print(f"[gpu] memory_allocated={allocated:.1f}MB memory_reserved={reserved:.1f}MB")

    notes = [60, 55, 43, 72]
    voices = [FakeVoice(row=i, midi=notes[i]) for i in range(4)]
    for v in voices:
        backend.note_on(v)

    times = []
    last_out = None
    for i in range(args.warmup + args.iters):
        t0 = time.perf_counter()
        out = backend.render_split(voices, BLOCK)
        if args.device.startswith("cuda") and torch.cuda.is_available():
            torch.cuda.synchronize()
        dt = (time.perf_counter() - t0) * 1000
        if i >= args.warmup:
            times.append(dt)
        last_out = out

    peak = float(np.abs(last_out).max())
    finite = bool(np.isfinite(last_out).all())
    rms_per_row = [float(np.sqrt(np.mean(np.square(last_out[r], dtype=np.float64))))
                   for r in range(4)]
    print(f"[audio] peak={peak:.4f} finite={finite} rms_per_row={[round(r, 4) for r in rms_per_row]}")
    assert finite, "输出含 NaN/Inf —— 不是速度问题，是数值问题"
    assert peak > 0.01, "输出接近静音，音色/激励可能没跑通"

    p50 = float(np.percentile(times, 50))
    p95 = float(np.percentile(times, 95))
    mean = statistics.mean(times)
    fits = "✅" if p95 < BUDGET_MS else "✗"
    print(f"[render] pool=4 block={BLOCK} 预算={BUDGET_MS:.2f}ms "
          f"p50={p50:.2f}ms p95={p95:.2f}ms mean={mean:.2f}ms {fits}")

    if args.device.startswith("cuda") and torch.cuda.is_available():
        allocated = torch.cuda.memory_allocated() / 1e6
        reserved = torch.cuda.memory_reserved() / 1e6
        print(f"[gpu] 渲染后 memory_allocated={allocated:.1f}MB memory_reserved={reserved:.1f}MB")

    for row, name in enumerate(ROW_VOICES):
        actual_device = str(backend._backends[row].device)
        assert actual_device.startswith(args.device.split(":")[0]), (
            f"{name} 实际在 {actual_device}，不是预期的 {args.device}"
        )
    print(f"[assert] 四个音色 backend.device 全部确认在 {args.device} 上")


if __name__ == "__main__":
    main()
