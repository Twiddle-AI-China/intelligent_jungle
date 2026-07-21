"""从 1239 个 preset 里选 100 条代表点，并在这 100 条上重建 PCA 子空间。

## 这个脚本回答什么

「只用 100 条代表性训练数据能不能撑起一张 latent map」——分三档产出 z，
交给 render 侧渲成音频做听感对比：

* ``z_true``   —— 真实 preset 的 z_timbre（128D），decoder 重建的输入
* ``z_pca2``   —— 投到这 100 条自己的前 2 主成分再反投影回 128D
* ``z_pca10``  —— 同上，前 10 主成分

对照的第四档是原始 Serum 音频（在 Octopus 上，不经过模型）。

## 度量为什么用 cosine

``z`` 是 tanh 输出，方向比模长更能代表音色（``docs/latent-map.md`` 的既有结论）。
所以 k-means 在 L2 归一化后的向量上做欧氏距离 —— 等价于 cosine。

## PCA 为什么在 100 条上重新拟合

问题问的是「100 条能不能撑起这张图」，所以主成分必须由这 100 条自己决定，
而不是沿用 1239 条的基。两者的 explained variance 都打印出来对比。

用法::

    python3 tools/select_100.py                     # 写 staging/selection_100.json
    python3 tools/select_100.py --k 100 --seed 0
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
MAP_JSON = REPO / "assets" / "timbre" / "latent_map.json"


def kmeans_cosine(x: np.ndarray, k: int, seed: int, iters: int = 200) -> np.ndarray:
    """球面 k-means。x 需已 L2 归一化。返回 (k, dim) 质心（也已归一化）。"""
    rng = np.random.default_rng(seed)
    n = len(x)

    # k-means++ 初始化：第一个随机，之后按「到已有质心最小距离的平方」加权抽
    centers = [x[rng.integers(n)]]
    d2 = ((x - centers[0]) ** 2).sum(1)
    for _ in range(k - 1):
        probs = d2 / d2.sum() if d2.sum() > 0 else np.full(n, 1 / n)
        centers.append(x[rng.choice(n, p=probs)])
        d2 = np.minimum(d2, ((x - centers[-1]) ** 2).sum(1))
    c = np.array(centers)

    for _ in range(iters):
        # 归一化向量上，最大内积 == 最小欧氏距离
        assign = (x @ c.T).argmax(1)
        new_c = np.zeros_like(c)
        for j in range(k):
            members = x[assign == j]
            # 空簇：重新丢到离当前质心最远的那个样本上，避免簇数塌陷
            new_c[j] = members.mean(0) if len(members) else x[(x @ c.T).max(1).argmin()]
        new_c /= np.linalg.norm(new_c, axis=1, keepdims=True) + 1e-12
        if np.allclose(new_c, c, atol=1e-7):
            break
        c = new_c
    return c


def pca_fit(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """返回 (mean, components[dim,dim], explained_ratio)。用 SVD，不依赖 sklearn。"""
    mean = x.mean(0)
    xc = x - mean
    _, s, vt = np.linalg.svd(xc, full_matrices=False)
    var = s**2 / max(len(x) - 1, 1)
    return mean, vt, var / var.sum()


def roundtrip(z: np.ndarray, mean: np.ndarray, comps: np.ndarray, n: int) -> np.ndarray:
    """投到前 n 个主成分再反投影回原空间。"""
    basis = comps[:n]
    return (z - mean) @ basis.T @ basis + mean


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", type=int, default=100)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("-o", "--out", default=str(REPO / "staging" / "selection_100.json"))
    args = ap.parse_args()

    data = json.loads(MAP_JSON.read_text())
    z_all = np.array(data["z"], dtype=np.float64)
    ids = [p["id"] for p in data["points"]]
    gains = {p["id"]: p.get("gain", 1.0) for p in data["points"]}
    assert len(ids) == len(z_all), f"id/z 数量不一致: {len(ids)} vs {len(z_all)}"
    print(f"语料 {len(ids)} 个 preset，dim={z_all.shape[1]}")

    # ---- 选点 ----------------------------------------------------------
    z_norm = z_all / (np.linalg.norm(z_all, axis=1, keepdims=True) + 1e-12)
    centers = kmeans_cosine(z_norm, args.k, args.seed)

    # 每个质心取最近的真实 preset；已被选走的排除，保证 k 个互异
    chosen: list[int] = []
    taken = set()
    for c in centers:
        order = (z_norm @ c).argsort()[::-1]
        for idx in order:
            if idx not in taken:
                taken.add(int(idx))
                chosen.append(int(idx))
                break
    chosen.sort()
    sel_z = z_all[chosen]
    sel_ids = [ids[i] for i in chosen]
    print(f"选出 {len(sel_ids)} 个（互异）")

    # 覆盖度自查：每个未选中的 preset 到最近选中点的 cosine
    sel_norm = z_norm[chosen]
    cos_to_sel = (z_norm @ sel_norm.T).max(1)
    print(f"覆盖度 cosine to nearest selected: "
          f"min={cos_to_sel.min():.4f} p05={np.percentile(cos_to_sel, 5):.4f} "
          f"median={np.median(cos_to_sel):.4f}")

    # ---- PCA：100 条自己的基 vs 1239 条的基 -----------------------------
    mean_100, comps_100, ratio_100 = pca_fit(sel_z)
    _, _, ratio_all = pca_fit(z_all)
    print(f"\nPCA on 100:   top2={ratio_100[:2].sum():.1%}  top10={ratio_100[:10].sum():.1%}")
    print(f"PCA on 1239:  top2={ratio_all[:2].sum():.1%}  top10={ratio_all[:10].sum():.1%}")
    print(f"  前 10 各分量(100): {np.round(ratio_100[:10], 4).tolist()}")

    z_pca2 = roundtrip(sel_z, mean_100, comps_100, 2)
    z_pca10 = roundtrip(sel_z, mean_100, comps_100, 10)
    for name, zz in (("z_pca2", z_pca2), ("z_pca10", z_pca10)):
        err = np.linalg.norm(zz - sel_z, axis=1) / (np.linalg.norm(sel_z, axis=1) + 1e-12)
        cos = (zz * sel_z).sum(1) / (
            np.linalg.norm(zz, axis=1) * np.linalg.norm(sel_z, axis=1) + 1e-12)
        print(f"  {name}: 相对误差 median={np.median(err):.3f}  "
              f"cosine to z_true median={np.median(cos):.4f}")

    out = {
        "schema": 1,
        "note": "z_true/z_pca2/z_pca10 三档，配合 Octopus 原始音频共四档听感对比",
        "k": args.k,
        "seed": args.seed,
        "source_map": str(MAP_JSON.relative_to(REPO)),
        "pca": {
            "fitted_on": 100,
            "explained_top2_on_100": float(ratio_100[:2].sum()),
            "explained_top10_on_100": float(ratio_100[:10].sum()),
            "explained_top2_on_1239": float(ratio_all[:2].sum()),
            "explained_top10_on_1239": float(ratio_all[:10].sum()),
            "explained_first10_on_100": [float(v) for v in ratio_100[:10]],
        },
        "coverage_cosine": {
            "min": float(cos_to_sel.min()),
            "p05": float(np.percentile(cos_to_sel, 5)),
            "median": float(np.median(cos_to_sel)),
        },
        "items": [
            {
                "id": pid,
                "gain": gains[pid],
                "z_true": sel_z[i].tolist(),
                "z_pca2": z_pca2[i].tolist(),
                "z_pca10": z_pca10[i].tolist(),
            }
            for i, pid in enumerate(sel_ids)
        ],
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out))
    print(f"\n写入 {out_path}  ({out_path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
