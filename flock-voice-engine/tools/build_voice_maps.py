"""为四个 v2 音色各建一张漫游地图：50 个训练 preset 的 256D z_timbre → 2D 布局
+ 逐点响度标定。产出 ``assets/timbre/voice_maps/{voice}.json``，供
``brave_voices.py`` 加载、``tracks.html`` 的 XY 面板消费。

与 v1 ``build_latent_map.py``（1239 点、128D、t-SNE）的关键差异：
每个音色的字典很小（50 个精选 preset，不是全语料），且都是**同一件乐器**
的音色变体（比如全是 pad），不是「随便什么 Serum preset」的大杂烩——
所以布局方法要看这 50 个点自己的方差分布再定，不能照抄 v1 的结论
（v1 在 1239 点上 PCA 前二只解释 45%，判定不够、改用 t-SNE；50 点是否
同样不够，这里实测后再决定，不是抄答案）。

输入：``/home/rolf/staging/voice_clap_extracted.json``（每个音色 50 个
preset 的平均 CLAP embedding，已在 Octopus 用该 checkpoint 训练集里
真实用过的 preset 生成，见 ``/tmp/extract_voice_clap.py`` 的记录）。

用法::

    .venv/bin/python tools/build_voice_maps.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.backends.midibrave_backend_v2 import MidiBraveBackendV2  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
CLAP_INPUT = Path("/home/rolf/staging/voice_clap_extracted.json")
OUT_DIR = REPO / "assets" / "timbre" / "voice_maps"

#: preset 去重阈值。50 个都是训练时精选出来的，理论上不该有重复，
#: 但仍然按 v1 同样的标准查一遍，不假设"精选过就没有"。
DEDUP_COSINE = 0.995
LOUDNESS_TARGET_RMS = 0.08
LOUDNESS_GAIN_MIN, LOUDNESS_GAIN_MAX = 0.15, 6.0
REF_NOTE, REF_VELOCITY, REF_DURATION = 60, 127, 0.8


def pca(z: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = z.mean(0)
    u, s, vt = np.linalg.svd(z - mean, full_matrices=False)
    var = s**2 / max(len(z) - 1, 1)
    return mean, vt, var / var.sum()


def layout_2d(z: np.ndarray, voice_name: str) -> tuple[np.ndarray, str, dict]:
    """按这批点自己的方差分布选布局方法，不预设结论。"""
    mean, components, ratio = pca(z)
    top2 = float(ratio[:2].sum())
    print(f"  PCA: top2={top2:.1%} top5={float(ratio[:5].sum()):.1%}")
    pca_info = {"mean": mean.tolist(), "basis": components[:2].tolist(),
                "explained_top2": top2, "explained": ratio[:8].tolist()}
    if top2 >= 0.60:
        # 方差集中，PCA 本身就是一张说得通的地图，没必要引入 t-SNE 的非线性失真。
        xy = (z - mean) @ components[:2].T
        return xy.astype(np.float32), "pca", pca_info
    from sklearn.manifold import TSNE
    init = ((z - mean) @ components[:2].T)
    init = (init / (np.abs(init).max() + 1e-9)) * 1.0  # t-SNE 要求初始化尺度适中
    tsne = TSNE(n_components=2, init=init, perplexity=min(15, (len(z) - 1) // 3),
                metric="cosine", random_state=0)
    xy = tsne.fit_transform(z)
    return xy.astype(np.float32), "tsne", pca_info


def dedup(preset_ids: list[str], z: np.ndarray) -> tuple[list[str], np.ndarray]:
    norm = z / (np.linalg.norm(z, axis=1, keepdims=True) + 1e-12)
    keep_idx, seen = [], []
    for i in range(len(preset_ids)):
        dup = any(float(norm[i] @ norm[j]) > DEDUP_COSINE for j in seen)
        if not dup:
            seen.append(i)
            keep_idx.append(i)
    dropped = len(preset_ids) - len(keep_idx)
    if dropped:
        print(f"  去重: 丢弃 {dropped} 个（cosine > {DEDUP_COSINE}）")
    return [preset_ids[i] for i in keep_idx], z[keep_idx]


def main() -> None:
    payload = json.loads(CLAP_INPUT.read_text())
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for voice_name, entry in payload.items():
        print(f"\n=== {voice_name} ===")
        preset_ids = entry["preset_ids"]
        clap = np.asarray(entry["clap"], dtype=np.float32)

        backend = MidiBraveBackendV2(voice_name, verify_hashes=True)
        with torch.no_grad():
            z = backend.timbre_from_clap(torch.from_numpy(clap)).numpy() \
                if clap.ndim == 1 else np.stack(
                    [backend.timbre_from_clap(torch.from_numpy(c)).numpy()[0] for c in clap]
                )
        print(f"  {len(preset_ids)} 个 preset -> z_timbre {z.shape}")

        preset_ids, z = dedup(preset_ids, z)
        xy, method, pca_info = layout_2d(z, voice_name)
        scale = float(np.abs(xy).max()) or 1.0

        print("  响度标定中（逐点渲染测 RMS）...")
        gains = []
        for i, pid in enumerate(preset_ids):
            zt = torch.from_numpy(z[i]).view(1, -1)
            wav = backend.render_note(zt, REF_NOTE, REF_VELOCITY, REF_DURATION)
            rms = float(np.sqrt(np.mean(np.square(wav, dtype=np.float64))))
            gain = float(np.clip(LOUDNESS_TARGET_RMS / max(rms, 1e-6),
                                 LOUDNESS_GAIN_MIN, LOUDNESS_GAIN_MAX))
            gains.append(gain)
        print(f"  增益范围: {min(gains):.2f} ~ {max(gains):.2f}")

        out = {
            "schema": 1,
            "voice": voice_name,
            "checkpointStep": backend.checkpoint_meta.get("step"),
            "configHash": backend.checkpoint_meta.get("config_hash"),
            "dim": int(z.shape[1]),
            "layout": method,
            "scale": scale,
            "pca": pca_info,
            "points": [
                {"id": pid, "x": float(xy[i, 0]), "y": float(xy[i, 1]), "gain": gains[i]}
                for i, pid in enumerate(preset_ids)
            ],
            "z": z.tolist(),
        }
        out_path = OUT_DIR / f"{voice_name}.json"
        out_path.write_text(json.dumps(out))
        print(f"  写入 {out_path} ({out_path.stat().st_size / 1024:.0f} KB, 布局={method})")


if __name__ == "__main__":
    main()
