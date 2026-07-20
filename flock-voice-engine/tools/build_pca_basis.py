"""把前 N 个主成分的基写进 latent_map.json，供「无约束 PCA 漫游」模式使用。

## 这是在验证什么

现有的 XY 直控走 **kNN 混合真实 preset**：安全（永远在凸包内），但代价是
稀疏区会「黏」在最近几个点上，过渡不连续。

这个实验去掉约束层，改成在**前 N 个主成分张成的子空间**里自由漫游：

    z = mean + Σ coeff[i] * basis[i]

假设：z_timbre 的方差高度集中（前 10 个主成分约 80%），所以这个子空间里的点
**大概率仍然落在合理区域**，而它是连续的 —— 不会有 kNN 的黏滞感。

风险：主成分是**线性**方向，真实的 z 流形未必是线性的。子空间里的点可能落在
流形之外 → 失真、怪音、或不发声。这正是要听出来的东西。

## 为什么能本地算

`latent_map.json` 里已经存了全部 1239 个 z（1239×128），PCA 只是一次 SVD，
不需要重跑 CLAP 或加载模型。

用法::

    python3 tools/build_pca_basis.py            # 写回 latent_map.json
    python3 tools/build_pca_basis.py --dims 16
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MAP_PATH = ROOT / "assets" / "timbre" / "latent_map.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="写入前 N 个主成分的基")
    parser.add_argument("--dims", type=int, default=10)
    parser.add_argument("--map", default=str(MAP_PATH))
    args = parser.parse_args()

    path = Path(args.map)
    data = json.loads(path.read_text(encoding="utf-8"))
    z = np.asarray(data["z"], dtype=np.float32)
    print(f"语料 {z.shape[0]} 个 preset，{z.shape[1]} 维")

    mean = z.mean(axis=0)
    centered = z - mean
    _u, s, vt = np.linalg.svd(centered, full_matrices=False)
    variance = (s**2) / float((s**2).sum())

    n = args.dims
    basis = vt[:n]                       # [n, 128]
    coords = centered @ basis.T          # [N, n]

    print(f"\n{'主成分':>6} {'解释率':>8} {'累计':>8} {'p5':>9} {'p50':>9} {'p95':>9}")
    ranges = []
    for i in range(n):
        col = coords[:, i]
        lo, mid, hi = np.percentile(col, [5, 50, 95])
        ranges.append({"p5": float(lo), "p50": float(mid), "p95": float(hi),
                       "min": float(col.min()), "max": float(col.max())})
        print(f"{'PC'+str(i+1):>6} {variance[i]*100:7.2f}% {variance[:i+1].sum()*100:7.2f}%"
              f" {lo:9.3f} {mid:9.3f} {hi:9.3f}")

    # 每个 preset 在 PC1/PC2 上的投影，归一化到约 [-1,1]。
    # PCA 模式下散点必须换成这套坐标 —— 否则屏幕位置（t-SNE 布局）与
    # 实际送进 decoder 的系数（PCA 坐标）对不上，拖动的位置和听到的东西不一致。
    xy = coords[:, :2]
    xy_scale = float(np.abs(np.percentile(xy, [1, 99])).max())
    xy_norm = xy / max(xy_scale, 1e-9)
    for point, (px, py) in zip(data["points"], xy_norm):
        point["px"] = round(float(px), 5)
        point["py"] = round(float(py), 5)

    data["pca_basis"] = {
        "xy_scale": xy_scale,
        "dims": n,
        "explained": [float(v) for v in variance[:n]],
        "explained_total": float(variance[:n].sum()),
        # 每维的分位数：UI 把屏幕坐标映射到 p5–p95 而不是 min–max，
        # 避免被极端离群点把有效范围压扁。
        "ranges": ranges,
        "mean": [round(float(v), 6) for v in mean],
        "basis": [[round(float(v), 6) for v in row] for row in basis],
        "note": "z = mean + Σ coeff[i] * basis[i]。**无约束** —— 不保证落在真实 "
                "preset 的凸包内，可能出现流形外的坏点。这正是本实验要听的。",
    }
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"\n前 {n} 个主成分累计解释 {variance[:n].sum()*100:.1f}%")
    print(f"已写回 {path}（{path.stat().st_size/1e6:.1f} MB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
