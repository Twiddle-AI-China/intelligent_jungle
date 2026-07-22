"""算力瓶颈实测：pool 长度 × 块长 × CPU/GPU × 串行/批量。

## 为什么要这个脚本

PRD 是四轨实时（1 人控 + 3 agent 控），四声部不是可推迟的 V2。
既有结论「串行前向超预算 2.6 倍」只测了 pool 1/2/4 在 CPU、块长 1024 下的串行路径，
**没有回答**三件事：

1. 固定成本占多少？（batch 能不能摊薄，还是纯算术瓶颈 —— batch 不减 FLOPs）
2. 块长能不能换预算？块长翻倍 → 预算翻倍、固定成本几乎不变。
   HANDOFF 已验证「块长无关」（逐样本与离线一致 6.9e-07），所以这条是安全的。
   延迟预算 100–300 ms（BRIEF），而 1024 样本才 23 ms —— headroom 很大。
3. GPU 值不值？模型只有 8M 参数、解码时间维每块仅 8 帧，
   这种形状 kernel launch 开销可能盖过收益，必须实测而不是想当然。

## 量什么

**流式路径**（`StreamingVoice.render_block`），不是离线 `model.decode` ——
后者没有跨块状态维护，会低估真实成本。另外单独量一次纯批量前向，
用来分离「固定成本」与「算术成本」。

用法::

    .venv/bin/python tools/bench_compute.py --device cpu
    # GPU 必须走 qgpu（GPU-GUARD），见 --emit-qgpu
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections.abc import Sequence
from functools import wraps
from pathlib import Path

if __package__:
    from .project_paths import ENGINE_ROOT, STAGING_ROOT
else:
    from project_paths import ENGINE_ROOT, STAGING_ROOT

SR = 44_100


def _no_grad(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with torch.no_grad():
            return function(*args, **kwargs)

    return wrapped


def budget_ms(block: int) -> float:
    return block / SR * 1000


def pct(xs: list[float], p: float) -> float:
    return float(np.percentile(xs, p))


def bench_streaming(backend, zs, notes, block: int, iters: int, warmup: int) -> dict:
    """串行路径：逐 voice 各调一次 render_block，与 brave.py 现状一致。"""
    from server.backends.streaming import StreamingVoice

    voices = []
    for z, note in zip(zs, notes):
        v = StreamingVoice(backend)
        v.note_on(z, note=note, velocity=127)
        voices.append(v)

    times = []
    for i in range(warmup + iters):
        t0 = time.perf_counter()
        for v in voices:
            v.render_block(block)
        if backend.device.type == "cuda":
            torch.cuda.synchronize()
        dt = (time.perf_counter() - t0) * 1000
        if i >= warmup:
            times.append(dt)
    return {"p50": pct(times, 50), "p95": pct(times, 95), "mean": statistics.mean(times)}


@_no_grad
def bench_batched_forward(model, zs, notes, iters: int, warmup: int, device) -> dict:
    """纯批量前向：一次 forward 出 N 个声部。用来看固定成本能被摊薄多少。

    注意这不是可直接上线的路径（跨块状态还没沿 batch 维拼接），
    只是用来回答「batch 到底有没有用」。
    """
    z = torch.as_tensor(np.asarray(zs, np.float32), device=device)
    n = torch.as_tensor(notes, dtype=torch.long, device=device)
    v = torch.full((len(zs),), 127.0, device=device)
    times = []
    for i in range(warmup + iters):
        t0 = time.perf_counter()
        model.decode(z, n, v)
        if device.type == "cuda":
            torch.cuda.synchronize()
        dt = (time.perf_counter() - t0) * 1000
        if i >= warmup:
            times.append(dt)
    return {"p50": pct(times, 50), "p95": pct(times, 95)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--iters", type=int, default=40)
    parser.add_argument("--warmup", type=int, default=8)
    parser.add_argument("--pools", default="1,2,4")
    parser.add_argument("--blocks", default="1024,2048,4096")
    parser.add_argument(
        "-o", "--out", type=Path, default=STAGING_ROOT / "bench_compute.json"
    )
    parser.add_argument(
        "--selection",
        type=Path,
        default=STAGING_ROOT / "pca100" / "selection_100.json",
    )
    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int | None:
    args = parse_args(argv)

    global np, torch
    import numpy as np
    import torch

    sys.path.insert(0, str(ENGINE_ROOT))

    torch.set_num_threads(args.threads)
    device = torch.device(args.device)
    from server.backends.midibrave_backend import MidiBraveBackend

    print(f"device={device} threads={args.threads} torch={torch.__version__}")
    backend = MidiBraveBackend(device=args.device)  # 构造函数里就加载权重

    sel = json.loads(args.selection.read_text())
    z_pool = [np.array(it["z_true"], np.float32) for it in sel["items"][:4]]
    notes = [60, 55, 43, 72][:4]

    pools = [int(x) for x in args.pools.split(",")]
    blocks = [int(x) for x in args.blocks.split(",")]
    results = {"device": args.device, "threads": args.threads,
               "torch": torch.__version__, "streaming": [], "batched_forward": []}

    print("\n=== 流式串行路径（现状）===")
    print(f"{'pool':>4} {'block':>6} {'预算ms':>7} {'p50':>8} {'p95':>8} {'余量':>8}")
    for block in blocks:
        for pool in pools:
            zs = [torch.as_tensor(z_pool[i % len(z_pool)], device=device)
                  for i in range(pool)]
            r = bench_streaming(backend, zs, notes[:pool], block,
                                args.iters, args.warmup)
            b = budget_ms(block)
            ok = "✅" if r["p95"] < b else "✗"
            print(f"{pool:>4} {block:>6} {b:>7.2f} {r['p50']:>8.2f} {r['p95']:>8.2f} "
                  f"{b - r['p95']:>7.2f} {ok}")
            results["streaming"].append({"pool": pool, "block": block,
                                         "budget_ms": b, **r, "fits": r["p95"] < b})

    print("\n=== 纯批量前向（问「固定成本能摊薄多少」）===")
    print(f"{'batch':>5} {'p50':>8} {'p95':>8} {'每声部':>8}")
    for pool in pools:
        zs = [z_pool[i % len(z_pool)] for i in range(pool)]
        r = bench_batched_forward(backend.model, zs, notes[:pool],
                                  args.iters, args.warmup, device)
        print(f"{pool:>5} {r['p50']:>8.2f} {r['p95']:>8.2f} {r['p50'] / pool:>8.2f}")
        results["batched_forward"].append({"batch": pool, **r,
                                           "per_voice_p50": r["p50"] / pool})

    args.out.write_text(json.dumps(results, indent=2))
    print(f"\n写入 {args.out}")


if __name__ == "__main__":
    raise SystemExit(main())
