"""构建二维音色地图：语料 z_timbre → PCA 平面 + kNN 混合所需的数据。

## 这张图是什么

把 Serum 语料里每个 preset 的 z_timbre（128 维）投到前两个主成分上，
得到一张可拖动的音色平面。**PC1 占 60.6%、前 3 占 76.0%** —— 方差本来就集中在
头几个方向，降到 2D 不是硬压，是顺着数据自身的结构走。

## 为什么不做「XY → 反投影回 128 维」

PC1+PC2 只解释约 70% 的方差，直接反投影出来的点会落在流形之外 ——
听感上是失真、怪音、或者干脆不发声。

正确做法是 **kNN 混合**：XY → 在平面上找最近的 k 个**真实 preset** →
按距离加权混合它们的 z。这样得到的点永远在真实音色的凸包内。
代价是 preset 稀疏的区域会有「空洞」，拖过去时音色会黏在最近的几个点上而不是
平滑过渡 —— 这个如实画在面板背景上，比假装到处都平滑要诚实。

## 去重

语料里约 1/3 是重复导入的 preset（CLAP 余弦 >0.995，重复在输入空间就存在，
不是模型行为）。不去重的话地图上会有一堆重叠点，kNN 也会被同一个音色的多份
拷贝主导。

用法::

    python3 tools/build_latent_map.py            # 在 Octopus 上跑（CLAP 缓存在那）
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

CLAP_CACHE = Path("/data/midibrave/cache/serum_strict_1822/clap")
#: 文件名语法 serum_s067180_n072_s060_v127 = preset / 目标note / 源note / velocity
NAME_RE = re.compile(r"serum_s(\d+)_n(\d+)_s(\d+)_v(\d+)")
#: 每个 preset 最多取这么多条 embedding 求均值。取太多没有收益，只是变慢。
MAX_PER_PRESET = 6
#: 去重阈值：CLAP 余弦超过它就认为是同一个 preset 的重复导入。
DEDUP_COSINE = 0.995


def load_corpus(cache_dir: Path, limit: int | None = None) -> tuple[list[str], np.ndarray]:
    """按 preset 聚合 CLAP embedding（均值 + L2）。"""
    by_preset: dict[str, list[Path]] = defaultdict(list)
    for path in sorted(cache_dir.iterdir()):
        m = NAME_RE.match(path.stem)
        if not m:
            continue
        pid = m.group(1)
        if len(by_preset[pid]) < MAX_PER_PRESET:
            by_preset[pid].append(path)

    ids = sorted(by_preset)
    if limit:
        ids = ids[:limit]
    print(f"preset 数: {len(ids)}（每个取 ≤{MAX_PER_PRESET} 条 embedding）", flush=True)

    vectors = np.zeros((len(ids), 512), dtype=np.float32)
    for index, pid in enumerate(ids):
        stack = np.stack([np.load(p) for p in by_preset[pid]])
        mean = stack.mean(axis=0)
        vectors[index] = mean / max(float(np.linalg.norm(mean)), 1e-9)
        if index % 200 == 0:
            print(f"  {index}/{len(ids)}", flush=True)
    return ids, vectors


def dedup(ids: list[str], clap: np.ndarray, threshold: float) -> np.ndarray:
    """贪心去重：与已保留项余弦超阈值的丢弃。返回保留下标。"""
    keep: list[int] = []
    kept_vectors = np.zeros((0, clap.shape[1]), dtype=np.float32)
    for index in range(len(ids)):
        if len(keep) and float((kept_vectors @ clap[index]).max()) > threshold:
            continue
        keep.append(index)
        kept_vectors = clap[keep]
    return np.asarray(keep, dtype=np.int64)



def timbre_adapter(clap: np.ndarray, weights: Path) -> np.ndarray:
    """CLAP 512D → z_timbre 128D。**纯 numpy，不需要 torch。**

    结构是实测确认过的：

        LayerNorm(512) → Linear(512,256) → SiLU → Linear(256,128) → Tanh

    权重来自 ``tools/dump_timbre_net.py`` 从 checkpoint 导出的 npz（6 个张量）。
    刻意不依赖 torch 也不依赖 vendor 源码 —— 这个脚本要在 Octopus 上跑
    （CLAP 缓存 438 MB 在那），而那台机器既没有 torch 也没有工程树。
    搬 6 个小张量过去，比把 438 MB 缓存拉回来划算。

    注意 `.0` 是 LayerNorm 不是 BatchNorm（源码 + state_dict 无 running stats，
    双重确认）—— 误当成 BatchNorm 用错统计量会让输出整体偏掉。
    """
    w = np.load(weights)
    x = clap.astype(np.float32)

    # LayerNorm：沿特征维归一化，再仿射
    mean = x.mean(axis=-1, keepdims=True)
    var = x.var(axis=-1, keepdims=True)
    x = (x - mean) / np.sqrt(var + 1e-5)
    x = x * w["ln_weight"] + w["ln_bias"]

    x = x @ w["fc1_weight"].T + w["fc1_bias"]
    x = x / (1.0 + np.exp(-x))            # SiLU
    x = x @ w["fc2_weight"].T + w["fc2_bias"]
    return np.tanh(x).astype(np.float32)


def main() -> int:
    parser = argparse.ArgumentParser(description="构建二维音色地图")
    parser.add_argument("--cache", default=str(CLAP_CACHE))
    parser.add_argument("--out", default="latent_map.json")
    parser.add_argument("--limit", type=int, default=None, help="只取前 N 个 preset（调试用）")
    parser.add_argument("--layout", choices=["tsne", "pca"], default="tsne",
                        help="平面布局方式。tsne=近邻保持(推荐)，pca=全局方差")
    parser.add_argument("--weights", default="/home/rolf/timbre_net.npz",
                        help="tools/dump_timbre_net.py 导出的 6 个张量")
    args = parser.parse_args()

    ids, clap = load_corpus(Path(args.cache), args.limit)

    print("去重中…", flush=True)
    keep = dedup(ids, clap, DEDUP_COSINE)
    ids = [ids[i] for i in keep]
    clap = clap[keep]
    print(f"去重后 {len(ids)} 个 preset", flush=True)

    print("过 timbre.net → z_timbre …", flush=True)
    z = timbre_adapter(clap, Path(args.weights))

    # PCA 先算，只为拿到解释率这个诚实指标（也作为 t-SNE 的初始化）。
    mean = z.mean(axis=0)
    centered = z - mean
    u, s, vt = np.linalg.svd(centered, full_matrices=False)
    basis = vt[:2]                       # [2, 128]
    pca_coords = centered @ basis.T      # [N, 2]
    variance = (s**2) / float((s**2).sum())
    print(f"PCA: PC1 {variance[0]*100:.1f}%  PC2 {variance[1]*100:.1f}%  "
          f"前二合计 {variance[:2].sum()*100:.1f}%")

    # 布局用 t-SNE 而不是 PCA。
    #
    # 去重后 PCA 前二只解释约 45% 方差 —— 作为「承载全部信息的投影」是不够的。
    # 但我们并不反投影：平面只是**导航面**，真正的 z 来自 kNN 混合真实 preset。
    # 导航面需要的性质是「平面上挨得近 ⇒ 听感也近」，那正是 t-SNE 优化的目标，
    # 而 PCA 优化的是全局方差保留 —— 两者目标不同，这里该用前者。
    #
    # 用 PCA 结果做初始化：t-SNE 随机初始化的结果不稳定，PCA 初始化让布局
    # 可复现，也保留一点全局结构。
    if args.layout == "tsne":
        from sklearn.manifold import TSNE  # noqa: PLC0415

        print("t-SNE 布局中（1239 点，约 1–2 分钟）…", flush=True)
        init = pca_coords / max(float(np.abs(pca_coords).max()), 1e-9) * 1e-4
        coords = TSNE(
            n_components=2,
            perplexity=30,
            init=init.astype(np.float32),
            learning_rate="auto",
            random_state=0,
            metric="cosine",   # z 是 tanh 输出，方向比模长更能代表音色
        ).fit_transform(z)
    else:
        coords = pca_coords

    # 归一化到 [-1,1]，让前端不用关心量纲
    scale = float(np.abs(coords).max())
    coords_norm = coords / max(scale, 1e-9)

    payload = {
        "schema": 1,
        "dim": 128,
        "presets": len(ids),
        "layout": args.layout,
        "pca": {
            "explained": [float(v) for v in variance[:8]],
            "explained_top2": float(variance[:2].sum()),
            "note": "去重后 PCA 前二只解释约 45% 方差。布局默认用 t-SNE —— "
                    "导航面要的是近邻保持，不是方差保留；真正的 z 来自 kNN 混合，"
                    "平面不承载信息，只承载可达性。",
        },
        "scale": scale,
        "knn": {
            "default_k": 6,
            "note": "XY → 平面上最近的 k 个真实 preset → 距离加权混合 z，"
                    "**不做反投影**（PC1+PC2 只解释约 70% 方差，反投影会落到流形外）",
        },
        # 前端只要这两列画散点；z 留在服务端做 kNN 混合。
        "points": [
            {"id": ids[i], "x": round(float(coords_norm[i, 0]), 5),
             "y": round(float(coords_norm[i, 1]), 5)}
            for i in range(len(ids))
        ],
        # 服务端 kNN 用：与 points 同序
        "z": [[round(float(v), 6) for v in row] for row in z],
        "mean": [round(float(v), 6) for v in mean],
        "basis": [[round(float(v), 6) for v in row] for row in basis],
    }
    out = Path(args.out)
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    size_mb = out.stat().st_size / 1e6
    print(f"已写 {out}（{size_mb:.1f} MB，{len(ids)} 点）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
