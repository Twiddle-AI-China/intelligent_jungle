"""tanh 塌陷判定：量 1822 个 Serum preset 之间 z_timbre 的余弦分布。纯 numpy，无需 torch。"""
from __future__ import annotations

import argparse
import os
import re
from collections import defaultdict
from collections.abc import Sequence
from pathlib import Path

if __package__:
    from .project_paths import STAGING_ROOT, TIMBRE_WEIGHTS
else:
    from project_paths import STAGING_ROOT, TIMBRE_WEIGHTS

CLAP_DIR = "/data/midibrave/cache/serum_strict_1822/clap"
MAX_CLIPS = 6   # 每个 preset 取多少条单音求均值

def l2(x, axis=-1):
    return x / (np.linalg.norm(x, axis=axis, keepdims=True) + 1e-12)

def layernorm(x, w, b, eps=1e-5):
    m = x.mean(-1, keepdims=True); v = x.var(-1, keepdims=True)
    return (x - m) / np.sqrt(v + eps) * w + b

def silu(x): return x / (1.0 + np.exp(-x))

def adapter(clap, weights, pre_tanh=False):
    """完全复刻 TimbreAdapter.forward: net(F.normalize(clap))"""
    x = l2(np.asarray(clap, np.float64))
    x = layernorm(x, weights["0.weight"], weights["0.bias"])
    x = silu(x @ weights["1.weight"].T + weights["1.bias"])
    x = x @ weights["3.weight"].T + weights["3.bias"]
    return x if pre_tanh else np.tanh(x)

def stats(name, X, note=""):
    Xn = l2(X)
    C = Xn @ Xn.T
    iu = np.triu_indices(len(X), 1)
    c = C[iu]
    q = np.percentile(c, [1, 5, 25, 50, 75, 95, 99])
    print(f"\n[{name}] {note}\n  两两余弦  mean={c.mean():.4f} std={c.std():.4f}"
          f"\n  分位 p1={q[0]:.4f} p5={q[1]:.4f} p25={q[2]:.4f} p50={q[3]:.4f} "
          f"p75={q[4]:.4f} p95={q[5]:.4f} p99={q[6]:.4f}"
          f"\n  >0.98 占比={np.mean(c>0.98):.4f}  >0.95 占比={np.mean(c>0.95):.4f}")
    return c


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path, default=TIMBRE_WEIGHTS)
    parser.add_argument(
        "--out", type=Path, default=STAGING_ROOT / "collapse_probe.npz"
    )
    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int | None:
    args = parse_args(argv)

    global np
    import numpy as np

    weights = np.load(args.weights)

    # ---- 按 preset 分组 ----
    files = sorted(os.listdir(CLAP_DIR))
    by_preset = defaultdict(list)
    for f in files:
        m = re.match(r"(serum_s\d+)_", f)
        if m:
            by_preset[m.group(1)].append(f)
    print(f"presets={len(by_preset)} files={len(files)}", flush=True)

    presets, means, within = [], [], []
    raw_norms = []
    for i, (pid, fl) in enumerate(sorted(by_preset.items())):
        sel = fl[:: max(1, len(fl) // MAX_CLIPS)][:MAX_CLIPS]
        E = np.stack([
            np.load(os.path.join(CLAP_DIR, f)).astype(np.float64).ravel()
            for f in sel
        ])
        raw_norms.append(np.linalg.norm(E, axis=-1).mean())
        # 同 preset 内部：各条单音各自过 adapter，两两余弦
        Z = adapter(E, weights)
        Zn = l2(Z)
        C = Zn @ Zn.T
        within.extend(C[np.triu_indices(len(Z), 1)].tolist())
        presets.append(pid)
        means.append(l2(E.mean(0)))
        if i % 400 == 0:
            print("  ..", i, flush=True)

    M = np.stack(means)                 # (P,512) 每个 preset 的代表 CLAP embedding
    Zp = adapter(M, weights)            # (P,128) tanh 后
    Hp = adapter(M, weights, pre_tanh=True)  # (P,128) tanh 前

    print("\n===== CLAP 缓存本身 =====")
    print(f"  原始 npy L2 范数 mean={np.mean(raw_norms):.4f} (≈1 说明缓存已归一化)")

    c_clap = stats("输入空间 CLAP-512", M, "（参照系：输入本来有多可分）")
    c_pre = stats("tanh 之前 pre-tanh-128", Hp, "（漫游候选空间）")
    c_post = stats("tanh 之后 z_timbre-128", Zp, "★ 判定用：与同 preset 0.984 对照")

    w = np.array(within)
    print(f"\n[同一 preset 内不同单音] z 余弦 mean={w.mean():.4f} p5={np.percentile(w,5):.4f} "
          f"p50={np.percentile(w,50):.4f}  (评测报告同 preset = 0.984)")

    sat = np.mean(np.abs(Zp) > 0.99)
    print(f"\n[饱和度] |z|>0.99 维度占比 全局={sat:.4f}  |z|>0.9 占比={np.mean(np.abs(Zp)>0.9):.4f}")
    print(f"  每 preset 饱和度: mean={np.mean(np.abs(Zp)>0.99, axis=1).mean():.4f} "
          f"max={np.mean(np.abs(Zp)>0.99, axis=1).max():.4f}")
    print(f"  pre-tanh |h| mean={np.abs(Hp).mean():.3f} p95={np.percentile(np.abs(Hp),95):.3f}")

    # 中心化后的可分性（漫游真正能用的方差）
    Zc = Zp - Zp.mean(0)
    ev = np.linalg.svd(Zc, compute_uv=False) ** 2
    ev /= ev.sum()
    print(f"\n[中心化 PCA] 前 1/3/10/32 主成分能量占比: "
          f"{ev[0]:.3f} {ev[:3].sum():.3f} {ev[:10].sum():.3f} {ev[:32].sum():.3f}")
    print(f"  有效维度 (participation ratio) = {1.0/np.sum(ev**2):.1f} / 128")
    c_cen = stats("中心化后 z_timbre", Zc, "（去掉公共偏置后的真实差异）")

    np.savez(args.out, presets=np.array(presets),
             Z=Zp.astype(np.float32), H=Hp.astype(np.float32),
             M=M.astype(np.float32))
    print(f"\n已存 {args.out}")


if __name__ == "__main__":
    raise SystemExit(main())
