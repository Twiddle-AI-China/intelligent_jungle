"""把每个 v2 音色自己的 PCA 基写进对应的 voice_maps/{name}.json，供「无约束
PCA 漫游」（``timbrePCA`` 协议字段）用。是 ``build_pca_basis.py`` 的 v2 版本，
方法完全一样，区别只是语料来源——v1 用共享的 1239 preset 语料，v2 每个
音色各自的语料就是它自己那张漫游地图里的 preset（见下面「跟 v1 的关键差异」）。

## 这是在验证什么

跟 v1 一样：现有 XY 直控走 kNN 混合真实 preset，安全（永远在凸包内），
代价是稀疏区会「黏」。这个实验去掉约束层，在**每个音色自己的**前 N 个
主成分张成的子空间里自由漫游：

    z = mean + Σ coeff[i] * basis[i]

风险跟 v1 完全一样：主成分是线性方向，真实的 z 流形未必线性，子空间里的点
可能落在流形之外 → 失真、怪音、或不发声。这正是要听出来的东西，见
``docs/latent-map.md``「为什么不做 XY → 反投影」一节的论证，本工具直接复用。

## 跟 v1 的关键差异——语料薄，数字别太当真

v1 的 1239 个 preset 是全语料共享的，v2 每个音色的语料是
``tools/build_voice_maps.py`` 从该 checkpoint 训练集里选出来的 ~31–50 个
preset（bass 44 / pad 31 / lead 45 / pluck 42，实测数字见各自 json 的
``points`` 长度）。样本数（~30–50）远小于维度数（256），SVD 数学上仍然
成立（``full_matrices=False`` 给出 min(n,d) 个分量），但：

* 「前 10 维解释多少方差」这类数字在这么小的语料上会显得**虚高**——
  样本越少，PCA 越容易"完美解释"这几十个点本身，不代表真的抓住了
  256 维流形的全局主轴。跟 v1 的数字不是一回事，不要拿来比。
* 子空间更可能是对这几十个点的过拟合方向，不是稳健的全局主成分。

这是已知局限，不是要不要做的问题——已经决定要做，这里如实记录代价。

## 用法

对每个音色跑一遍（在 Spark 上，权威副本在那）::

    python3 tools/build_pca_basis_v2.py                        # 全部四个音色
    python3 tools/build_pca_basis_v2.py --voice pad --dims 10
    python3 tools/build_pca_basis_v2.py --dims 8                # 全部音色都用 8 维

跑完别忘了同步到 ``web/assets/timbre/voice_maps/``（两份拷贝，见
``docs/HANDOFF.md``「地图资产的权威副本在 Spark」）。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MAP_DIR = ROOT / "assets" / "timbre" / "voice_maps"
VOICES = ("bass", "pad", "lead", "pluck")


def build_one(path: Path, dims: int) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    z = np.asarray(data["z"], dtype=np.float32)
    n_samples, n_dim = z.shape
    print(f"\n=== {path.stem} ===")
    print(f"语料 {n_samples} 个 preset，{n_dim} 维")
    if n_samples < 8:
        print(f"  ⚠️ 样本太少（{n_samples} < 8），PCA 基质量没有保障，跳过")
        return

    n = min(dims, n_samples - 1)
    if n < dims:
        print(f"  ⚠️ 语料只够算 {n} 维（要求 {dims}），样本数 {n_samples} 是硬上限")

    mean = z.mean(axis=0)
    centered = z - mean
    _u, s, vt = np.linalg.svd(centered, full_matrices=False)
    variance = (s**2) / float((s**2).sum())

    basis = vt[:n]
    coords = centered @ basis.T

    # 每个 preset 在 PC1/PC2 上的投影，归一化到约 [-1,1]，写回 points[i].px/py。
    # PCA 模式下散点必须换成这套坐标——否则屏幕位置（kNN 模式用的 t-SNE/PCA
    # 布局 x/y）跟实际送进 decoder 的系数（PCA 坐标）对不上，拖动的位置和
    # 听到的东西不一致。跟 tools/build_pca_basis.py（v1）完全同一个做法。
    xy = coords[:, :2]
    xy_scale = float(np.abs(np.percentile(xy, [1, 99])).max())
    xy_norm = xy / max(xy_scale, 1e-9)
    for point, (px, py) in zip(data["points"], xy_norm):
        point["px"] = round(float(px), 5)
        point["py"] = round(float(py), 5)

    print(f"{'主成分':>6} {'解释率':>8} {'累计':>8} {'p5':>9} {'p50':>9} {'p95':>9}")
    ranges = []
    for i in range(n):
        col = coords[:, i]
        lo, mid, hi = np.percentile(col, [5, 50, 95])
        ranges.append({"p5": float(lo), "p50": float(mid), "p95": float(hi),
                       "min": float(col.min()), "max": float(col.max())})
        print(f"{'PC'+str(i+1):>6} {variance[i]*100:7.2f}% {variance[:i+1].sum()*100:7.2f}%"
              f" {lo:9.3f} {mid:9.3f} {hi:9.3f}")

    data["pca_basis"] = {
        "dims": n,
        "xy_scale": xy_scale,
        "explained": [float(v) for v in variance[:n]],
        "explained_total": float(variance[:n].sum()),
        "corpus_size": n_samples,
        # 每维的分位数：UI 把滑杆范围映射到 p5–p95 而不是 min–max，
        # 避免被极端离群点把有效范围压扁（跟 v1 同样的取舍）。
        "ranges": ranges,
        "mean": [round(float(v), 6) for v in mean],
        "basis": [[round(float(v), 6) for v in row] for row in basis],
        "note": "z = mean + Σ coeff[i] * basis[i]。**无约束** —— 不保证落在真实 "
                "preset 的凸包内，可能出现流形外的坏点。语料只有 "
                f"{n_samples} 个 preset，比 v1 的 1239 个薄很多，"
                "解释方差数字仅供参考，不是稳健统计量。这正是本实验要听的。",
    }
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"前 {n} 维累计解释 {variance[:n].sum()*100:.1f}%（语料 {n_samples} 点，"
          f"数字比 v1 虚高，见模块 docstring）")
    print(f"已写回 {path}（{path.stat().st_size/1e3:.1f} KB）")


def main() -> int:
    parser = argparse.ArgumentParser(description="给 v2 每个音色的漫游地图写入 PCA 基")
    parser.add_argument("--voice", choices=VOICES, default=None,
                        help="只处理一个音色，缺省处理全部四个")
    parser.add_argument("--dims", type=int, default=10)
    parser.add_argument("--map-dir", default=str(MAP_DIR))
    args = parser.parse_args()

    map_dir = Path(args.map_dir)
    voices = [args.voice] if args.voice else list(VOICES)
    for voice in voices:
        path = map_dir / f"{voice}.json"
        if not path.is_file():
            print(f"跳过 {voice}：{path} 不存在")
            continue
        build_one(path, args.dims)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
