"""为 pad 的新引擎（TrajectoryBrave）建一张漫游地图：50 个训练 anchor 的
8D 坐标 → 2D 布局 + 逐点响度标定。产出 ``assets/timbre/voice_maps/pad.json``，
替换掉旧模型（MidiBraveBackendV2）的 256D 版本——见
``server/backends/trajectorybrave_pad.py`` 模块 docstring。

跟 ``build_voice_maps.py``（其余四个音色）的关键差异：那边的 z 是从 CLAP
embedding 过 ``timbre_from_clap`` 算出来的 256D 向量；这里 z 直接就是模型
自己训练出的 8D anchor 坐标（``TrajectoryBravePadBackend.anchors``，来自
``TrajectoryBrave.control_coordinates()``），不需要 CLAP 这一步——50 个
anchor 本来就是模型的可学习参数，不是从音频再提一次特征算出来的。

``layout_2d``/``dedup``/响度标定（逐点渲染测 RMS）三个函数原样照抄
``build_voice_maps.py``——它们本来就不认输入维度，8D 和 256D 走同一套代码。
``MultiVoiceBraveBackend.latent_from_xy``/``latent_from_pca``（brave_voices.py）
同样不认维度，所以这张新地图接进去不需要改任何漫游代码。

用法（在 Spark 上跑，权威副本在那）::

    python3 tools/build_pad_trajectorybrave_map.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.backends.trajectorybrave_pad import get_shared_trajectorybrave_pad  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "assets" / "timbre" / "voice_maps"
VOICE_NAME = "pad"

DEDUP_COSINE = 0.995
LOUDNESS_TARGET_RMS = 0.08
LOUDNESS_GAIN_MIN, LOUDNESS_GAIN_MAX = 0.15, 6.0
#: TrajectoryBrave pad v1 只在 MIDI 36–71 上训练（见 trajectorybrave_pad.py
#: 的 PAD_NOTE_MIN/MAX），参考音符不能沿用其余音色的 60（虽然 60 本身在
#: 范围内，这里显式写出来避免以后跟其余音色的参考音混淆）。
REF_NOTE, REF_VELOCITY, REF_DURATION = 60, 127, 0.8


def pca(z: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = z.mean(0)
    u, s, vt = np.linalg.svd(z - mean, full_matrices=False)
    var = s**2 / max(len(z) - 1, 1)
    return mean, vt, var / var.sum()


def layout_2d(z: np.ndarray, voice_name: str) -> tuple[np.ndarray, str, dict]:
    """按这批点自己的方差分布选布局方法，不预设结论（同 build_voice_maps.py）。"""
    mean, components, ratio = pca(z)
    top2 = float(ratio[:2].sum())
    print(f"  PCA: top2={top2:.1%} top5={float(ratio[:5].sum()):.1%}")
    pca_info = {"mean": mean.tolist(), "basis": components[:2].tolist(),
                "explained_top2": top2, "explained": ratio[:8].tolist()}
    if top2 >= 0.60:
        xy = (z - mean) @ components[:2].T
        return xy.astype(np.float32), "pca", pca_info
    from sklearn.manifold import TSNE
    init = ((z - mean) @ components[:2].T)
    init = (init / (np.abs(init).max() + 1e-9)) * 1.0
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


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"\n=== {VOICE_NAME} (TrajectoryBrave) ===")

    backend = get_shared_trajectorybrave_pad(device="cpu")
    z = backend.anchors.astype(np.float32)  # [50, 8]，模型自己的可学习 anchor
    preset_ids = [f"anchor_{i}" for i in range(z.shape[0])]
    print(f"  {len(preset_ids)} 个 anchor -> 坐标 {z.shape}")

    preset_ids, z = dedup(preset_ids, z)
    xy, method, pca_info = layout_2d(z, VOICE_NAME)
    scale = float(np.abs(xy).max()) or 1.0

    print("  响度标定中（逐点渲染测 RMS，TrajectoryBrave 每点渲染约 5s 训练时钟）...")
    gains = []
    for i, pid in enumerate(preset_ids):
        wav = backend.render_note(z[i], REF_NOTE, REF_VELOCITY, REF_DURATION)
        rms = float(np.sqrt(np.mean(np.square(wav, dtype=np.float64))))
        gain = float(np.clip(LOUDNESS_TARGET_RMS / max(rms, 1e-6),
                             LOUDNESS_GAIN_MIN, LOUDNESS_GAIN_MAX))
        gains.append(gain)
        if (i + 1) % 10 == 0:
            print(f"    {i + 1}/{len(preset_ids)}")
    print(f"  增益范围: {min(gains):.2f} ~ {max(gains):.2f}")

    out = {
        "schema": 1,
        "voice": VOICE_NAME,
        "engine": "trajectorybrave-v1",
        "checkpointStep": backend.checkpoint_meta.get("step"),
        "checkpointSha256": backend.checkpoint_meta.get("sha256"),
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
    out_path = OUT_DIR / f"{VOICE_NAME}.json"
    out_path.write_text(json.dumps(out))
    print(f"  写入 {out_path} ({out_path.stat().st_size / 1024:.0f} KB, 布局={method})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
