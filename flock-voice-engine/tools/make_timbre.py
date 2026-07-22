#!/usr/bin/env python3
"""离线生成 z_timbre 向量（128D），供服务端启动时直接加载。

这条链**完全离线**：实时路径不加载 CLAP、不加载 timbre adapter。

    参考音频 → CLAP audio encoder → 512D embedding → L2 归一化 → timbre.net → z_timbre 128D

两种输入模式：

1. ``--clap-npy``（**推荐**）：直接用训练期缓存好的 CLAP embedding（``.npy``, 512D, 已 L2 归一化）。
   零重算、零漂移，逐比特就是训练时喂给 ``timbre.net`` 的那个向量。
   缓存在 Octopus ``/data/midibrave/cache/serum_strict_1822/clap/``。

2. ``--audio``：从 wav 现算。**必须**用训练同款 CLAP，否则 embedding 空间不同，出来的 z 是垃圾：
       laion_clap 1.1.7 / HTSAT-base / enable_fusion=False
       ckpt: /data/model_weights/laion-clap/music_audioset_epoch_15_esc_90.14.pt  (Octopus)
       sha256: fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd
   注意 Spark 上的 ``/data/model_weights/clap/models--laion--clap-htsat-fused`` 是**另一个模型**
   （HF 版 / HTSAT-tiny / 带 fusion），**不能用**。

聚合方式：一个 preset 的多条单音 embedding 取均值再 L2 归一化，然后过 ``timbre.net``。
每条完整单音只产生一个 embedding —— 不切 attack/sustain/release 随机窗口（方案A 要求）。
``timbre.net`` 训练时带 pitch adversary（GRL），z_timbre 本就设计成音高无关，跨音高取均值与该设计一致。

用法::

    # 从训练缓存生成 pad 向量
    python3 make_timbre.py --clap-npy '/data/.../clap/serum_s001434_*.npy' \
        --ckpt /data/model_weights/midiBrave/midibrave-full-c9-phase1-step-000075365.pt \
        --name pad --preset serum_s001434 -o pad.json

    # 自测
    python3 make_timbre.py --self-test --ckpt <ckpt>
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import platform
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CLAP_DIM = 512
TIMBRE_DIM = 128

# 训练期 CLAP 契约（来自 manifests/*.meta.json 的 clap_contract 字段，勿改）
CLAP_CONTRACT = {
    "implementation": "laion-clap-1.1.7/HTSAT-base/no-fusion",
    "checkpoint": "/data/model_weights/laion-clap/music_audioset_epoch_15_esc_90.14.pt",
    "checkpoint_sha256": "fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd",
    "dimension": CLAP_DIM,
    "input_sample_rate": 48000,
    "normalization": "L2 (F.normalize(dim=-1))",
}


class TimbreAdapter(nn.Module):
    """midiBrave ``TimbreAdapter`` 的最小复刻。

    结构逐字对应 Octopus ``/home/jyhu/MidiBrave/src/midibrave/model.py:212``::

        nn.Sequential(
            nn.LayerNorm(512), nn.Linear(512, 256), nn.SiLU(),
            nn.Linear(256, 128), nn.Tanh(),
        )
        forward(clap) = net(F.normalize(clap, dim=-1))

    注意 LayerNorm 在**输入端**（index 0），Tanh 在**末端**——不是「末端 LayerNorm→tanh」。
    ``.0`` 是 LayerNorm 而非 BatchNorm1d：state_dict 只有 6 个 tensor，
    没有 ``running_mean`` / ``running_var`` / ``num_batches_tracked``，BatchNorm 必然带这些。
    """

    def __init__(self, input_dim: int = CLAP_DIM, output_dim: int = TIMBRE_DIM) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.LayerNorm(input_dim), nn.Linear(input_dim, 256), nn.SiLU(),
            nn.Linear(256, output_dim), nn.Tanh(),
        )

    def forward(self, clap: torch.Tensor) -> torch.Tensor:
        return self.net(F.normalize(clap, dim=-1))

    def pre_tanh(self, clap: torch.Tensor) -> torch.Tensor:
        """tanh 之前的激活，用于诊断饱和。"""
        x = F.normalize(clap, dim=-1)
        for layer in list(self.net)[:-1]:
            x = layer(x)
        return x


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while block := fh.read(chunk):
            h.update(block)
    return h.hexdigest()


def load_adapter(ckpt_path: str | Path) -> tuple[TimbreAdapter, dict]:
    """只从 checkpoint 里取 ``timbre.net.*`` 这 6 个 tensor，不需要完整模型类。"""
    blob = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    state = blob["model"]
    prefix = "timbre.net."
    weights = {k[len(prefix):]: v.float() for k, v in state.items() if k.startswith(prefix)}

    stray = [k for k in state if k.startswith("timbre.") and not k.startswith(prefix)]
    if stray:
        raise RuntimeError(f"timbre.* 出现预期外的键（可能是 BatchNorm 统计量）: {stray}")
    expected = {"0.weight", "0.bias", "1.weight", "1.bias", "3.weight", "3.bias"}
    if set(weights) != expected:
        raise RuntimeError(f"timbre.net 键不匹配: 期望 {sorted(expected)}, 实得 {sorted(weights)}")

    adapter = TimbreAdapter()
    adapter.net.load_state_dict(weights)
    adapter.eval()

    meta = {k: blob[k] for k in ("format", "phase", "step", "epoch") if k in blob}
    return adapter, meta


def embeddings_from_npy(pattern: str) -> tuple[np.ndarray, list[str]]:
    """读取训练期缓存的 CLAP embedding。"""
    files = sorted(glob.glob(pattern))
    if not files:
        raise FileNotFoundError(f"没有匹配到 .npy: {pattern}")
    mats, names = [], []
    for f in files:
        v = np.load(f, allow_pickle=False)
        if v.shape != (CLAP_DIM,) or not np.isfinite(v).all():
            raise ValueError(f"无效的 CLAP 缓存: {f} shape={v.shape}")
        mats.append(v.astype(np.float32))
        names.append(Path(f).name)
    return np.stack(mats), names


def embeddings_from_audio(paths: list[str], clap_ckpt: str, device: str = "cpu") -> tuple[np.ndarray, list[str]]:
    """从 wav 现算 CLAP embedding，严格复刻 ``data.py:cache_clap_embeddings``。"""
    import laion_clap  # 仅在这条分支才依赖
    import soundfile as sf
    from scipy.signal import resample_poly

    actual = sha256_file(clap_ckpt)
    if actual != CLAP_CONTRACT["checkpoint_sha256"]:
        raise RuntimeError(
            f"CLAP checkpoint sha256 不匹配训练契约。\n  期望 {CLAP_CONTRACT['checkpoint_sha256']}\n"
            f"  实得 {actual}\n  用错 CLAP 会让 z_timbre 完全失效。"
        )

    model = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-base", device=device)
    model.load_ckpt(clap_ckpt)
    model.eval()

    mats, names = [], []
    for p in paths:
        audio, sr = sf.read(p, dtype="float32", always_2d=False)
        if audio.ndim > 1:                      # 训练数据是 mono
            audio = audio.mean(axis=1)
        if sr != 48000:                         # 训练里 44.1k → 48k 用 resample_poly(160,147)
            if sr == 44100:
                audio = resample_poly(audio, 160, 147).astype(np.float32)
            else:
                raise ValueError(f"{p}: 采样率 {sr} 非 44100/48000，训练链路未覆盖")
        tensor = torch.from_numpy(np.asarray(audio, dtype=np.float32)).unsqueeze(0).to(device)
        with torch.no_grad():                   # 整段送入，不切窗
            emb = model.get_audio_embedding_from_data(tensor, use_tensor=True)
            emb = F.normalize(emb.float(), dim=-1)
        mats.append(emb[0].cpu().numpy().astype(np.float32))
        names.append(Path(p).name)
    return np.stack(mats), names


def make_z(adapter: TimbreAdapter, embeddings: np.ndarray) -> tuple[torch.Tensor, dict]:
    """多条单音 embedding → 均值 → L2 → timbre.net → z_timbre，并附健康度诊断。"""
    E = torch.from_numpy(embeddings).float()
    rep = F.normalize(E.mean(dim=0), dim=-1)
    with torch.no_grad():
        z = adapter(rep.unsqueeze(0))[0]
        h = adapter.pre_tanh(rep.unsqueeze(0))[0]
        z_each = adapter(E)

    cos_each = F.cosine_similarity(z.unsqueeze(0), z_each, dim=1)
    saturation = float((z.abs() > 0.99).float().mean())
    diag = {
        "num_source_clips": int(len(E)),
        "tanh_saturation_frac": round(saturation, 4),      # |z|>0.99 的维度占比
        "abs_z_mean": round(float(z.abs().mean()), 4),
        "pre_tanh_abs_mean": round(float(h.abs().mean()), 4),
        "cos_to_per_clip_z_min": round(float(cos_each.min()), 4),
        "cos_to_per_clip_z_mean": round(float(cos_each.mean()), 4),
        # 注意：tanh 饱和 **不等于** 塌陷。全 1822 个 preset 实测（见 docs/timbre.md）：
        # 平均饱和度 0.168、最高 0.703，而不同 preset 之间 z 的余弦中位数只有 0.519，
        # 同 preset 内是 0.951 —— 完全分得开。饱和度高的 preset 依旧可分。
        # 这里保留该指标只作参考，不作为「不可用」的判据。
        "high_saturation": bool(saturation > 0.5),
    }
    return z, diag


def build_payload(z: torch.Tensor, diag: dict, args, source_names: list[str],
                  ckpt_meta: dict, ckpt_sha: str) -> dict:
    return {
        "name": args.name,
        "dim": TIMBRE_DIM,
        "z_timbre": [round(float(v), 8) for v in z],
        "provenance": {
            "preset_id": args.preset,
            "source_mode": "clap_cache_npy" if args.clap_npy else "audio",
            "source_pattern": args.clap_npy or None,
            "source_clips": source_names if len(source_names) <= 8 else
                            source_names[:4] + [f"... (+{len(source_names) - 8})"] + source_names[-4:],
            "num_source_clips": len(source_names),
            "aggregation": "mean over per-clip CLAP embeddings, then L2 normalize",
            "clap": CLAP_CONTRACT,
            "midibrave_checkpoint": {
                "path": args.ckpt,
                "sha256": ckpt_sha,
                **{k: (int(v) if isinstance(v, (int, float)) else str(v)) for k, v in ckpt_meta.items()},
            },
            "adapter": "timbre.net = LayerNorm(512) -> Linear(512,256) -> SiLU -> Linear(256,128) -> Tanh",
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "generated_by": f"tools/make_timbre.py on {platform.node()}",
            "torch": torch.__version__,
        },
        "diagnostics": diag,
    }


# ======================================================================================
# 音色漫游图谱（atlas）
# ======================================================================================
#
# V1 只有一个声部在音色空间里漫游，所以交付的不是一个固定向量，而是一组锚点 +
# 一套「怎么在锚点之间走」的约束。消费方按 Latent-Cosmos 基线的
# ``atlas_latent_point`` / ``limited_step`` 用：邻域加权混合真实锚点 + 限速步进，
# **不做无约束 latent 生成**（会跑到分布外产生坏点）。
#
# 三条听感轴（都用中位数/IQR 稳健标准化后过 tanh，落在 [-1,1]）：
#   brightness      ← log10(谱质心 Hz)
#   attack_fastness ← -log10(起音时间 ms)      （+ = 快起）
#   fullness        ← 800 ms RMS 留存率        （+ = 厚/持续）

ATLAS_AXES = ("brightness", "attack_fastness", "fullness")


def _robust_axis(values: np.ndarray) -> np.ndarray:
    """中位数/IQR 稳健标准化后过 tanh，避免长尾主导坐标。"""
    v = np.asarray(values, dtype=np.float64)
    med = np.median(v)
    iqr = np.percentile(v, 75) - np.percentile(v, 25)
    return np.tanh((v - med) / (iqr + 1e-9))


def build_atlas(probe_npz: str | Path, descriptors_json: str | Path,
                dup_cos: float = 0.995, anchor_cos: float = 0.97) -> dict:
    """从「全语料 z + DSP 画像」里挑一组有听感区分度的锚点。

    ``probe_npz``  由 tools/collapse_probe.py 在 Octopus 上产出（presets / Z / M）。
    ``descriptors_json`` 由 tools/descriptors.py 产出（每 preset 一条代表单音的画像）。
    """
    blob = np.load(probe_npz, allow_pickle=True)
    pids = [str(x) for x in blob["presets"]]
    Z = blob["Z"].astype(np.float64)
    M = blob["M"].astype(np.float64)          # preset 代表 CLAP embedding（已 L2）
    desc = json.loads(Path(descriptors_json).read_text(encoding="utf-8"))

    feats = np.stack([
        _robust_axis(np.log10([desc[p]["centroid_hz"] + 1.0 for p in pids])),
        -_robust_axis(np.log10([max(desc[p]["attack_ms"], 1.0) for p in pids])),
        _robust_axis([desc[p]["retention_800ms"] for p in pids]),
    ], axis=1)

    # 去重：CLAP 空间近似重复的 preset 只留一个（语料里有约 1/3 是重复导入）
    Mn = M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-12)
    keep: list[int] = []
    for i in range(len(pids)):
        if keep and float((Mn[keep] @ Mn[i]).max()) > dup_cos:
            continue
        keep.append(i)
    keep_arr = np.array(keep)

    # 目标点 = 三轴的 8 个角 + 中心，各取最近的**真实** preset
    targets: dict[str, np.ndarray] = {}
    for b in (-1, 1):
        for a in (-1, 1):
            for f in (-1, 1):
                name = (("bright" if b > 0 else "dark") + "_"
                        + ("fast" if a > 0 else "slow") + "_"
                        + ("full" if f > 0 else "thin"))
                targets[name] = np.array([b, a, f], dtype=np.float64) * 0.85
    targets["neutral_center"] = np.zeros(3)

    anchors: list[dict] = []
    used: set[int] = set()
    for name, target in targets.items():
        order = np.argsort(np.linalg.norm(feats[keep_arr] - target, axis=1))
        for o in order:
            gi = int(keep_arr[o])
            if gi in used:
                continue
            if anchors:                       # 与已选锚点在 z 上不能太像，保证听感确实不同
                zc = np.array([a["z_timbre"] for a in anchors])
                zn = zc / (np.linalg.norm(zc, axis=1, keepdims=True) + 1e-12)
                if float((zn @ (Z[gi] / np.linalg.norm(Z[gi]))).max()) > anchor_cos:
                    continue
            used.add(gi)
            pid, d = pids[gi], desc[pids[gi]]
            anchors.append({
                "id": name,
                "z_timbre": [round(float(v), 8) for v in Z[gi]],
                "features": dict(zip(ATLAS_AXES, (round(float(x), 4) for x in feats[gi]))),
                "provenance": {
                    "preset_id": pid,
                    "preset_name": d.get("preset_name"),
                    "category": d.get("category"),
                    "bank": d.get("bank"),
                    "source_audio": d["audio_path"],
                    "source_sample_id": d["sample_id"],
                    "midi_note": d["midi_note"],
                    "velocity": d["velocity"],
                },
                "profile": {
                    "centroid_hz": round(d["centroid_hz"], 1),
                    "rolloff85_hz": round(d["rolloff85_hz"], 1),
                    "hf_ratio_above_4k": round(d["hf_ratio"], 4),
                    "spectral_flatness": round(d["flatness"], 5),
                    "attack_ms": round(d["attack_ms"], 1),
                    "retention_800ms": round(d["retention_800ms"], 4),
                    "retention_2s": round(d["retention_2s"], 4),
                },
            })
            break

    ZA = np.array([a["z_timbre"] for a in anchors])
    ZAn = ZA / (np.linalg.norm(ZA, axis=1, keepdims=True) + 1e-12)
    iu = np.triu_indices(len(ZA), 1)
    cos = (ZAn @ ZAn.T)[iu]
    euc = np.linalg.norm(ZA[:, None] - ZA[None], axis=2)[iu]

    return {
        "schema": 1,
        "dim": TIMBRE_DIM,
        "axes": list(ATLAS_AXES),
        "anchors": anchors,
        "roaming": ROAMING_LIMITS,
        "separability": {
            "anchor_pairwise_cos": {"min": round(float(cos.min()), 4),
                                     "mean": round(float(cos.mean()), 4),
                                     "max": round(float(cos.max()), 4)},
            "anchor_pairwise_l2": {"min": round(float(euc.min()), 3),
                                    "mean": round(float(euc.mean()), 3),
                                    "max": round(float(euc.max()), 3)},
        },
        "corpus": {
            "presets_total": len(pids),
            "presets_after_dedup": len(keep),
            "dedup_cosine_threshold": dup_cos,
        },
        "clap": CLAP_CONTRACT,
        "adapter": "timbre.net = LayerNorm(512) -> Linear(512,256) -> SiLU -> Linear(256,128) -> Tanh",
    }


# 漫游速率约束——实测得来（tools/roam_probe.py，见 docs/timbre.md），不是拍脑袋。
ROAMING_LIMITS = {
    "unit": "z_timbre 的欧氏距离（128 维，tanh 后）",
    "sensitivity_logmel_per_z": 0.3493,   # 每单位 z 距离带来的对数梅尔变化
    "semitone_equivalent_z": 2.143,       # 与「同 preset 相邻半音」等价的 z 距离
    "max_step_per_note": 0.8,             # 推荐：每个音符事件最多移动这么远
    "hard_ceiling_per_note": 1.5,         # 超过这个就从「渐变」变成「换音色」
    "note": ("模型 decode() 把 z_timbre 在整段上广播成常量，训练时每个音一个固定 z。"
             "因此漫游应当**按音符事件**推进（每个音一个 z），不要在单音内部逐帧改 z。"),
    "loudness_warning": ("锚点之间线性插值会有响度塌陷，中点 RMS 实测掉到端点的 0.37~0.63。"
                          "务必按音符做 RMS 归一化，或改用 atlas_latent_point 的邻域加权混合。"),
}


def self_test(ckpt: str) -> None:
    """结构自测：不依赖任何音频或缓存。"""
    adapter, meta = load_adapter(ckpt)
    print("checkpoint meta:", meta)
    shapes = {n: tuple(p.shape) for n, p in adapter.net.named_parameters()}
    print("timbre.net params:", shapes)
    assert shapes == {"0.weight": (512,), "0.bias": (512,), "1.weight": (256, 512),
                      "1.bias": (256,), "3.weight": (128, 256), "3.bias": (128,)}
    # LayerNorm 而非 BatchNorm：无 buffer
    assert not list(adapter.net.buffers()), "出现 buffer，说明 .0 不是 LayerNorm"
    rng = np.random.default_rng(0)
    E = rng.standard_normal((8, CLAP_DIM)).astype(np.float32)
    E /= np.linalg.norm(E, axis=1, keepdims=True)
    z, diag = make_z(adapter, E)
    assert z.shape == (TIMBRE_DIM,) and torch.isfinite(z).all()
    assert z.abs().max() <= 1.0, "tanh 输出必须在 [-1,1]"
    print("z shape", tuple(z.shape), "diag", diag)
    print("self-test OK")


def main() -> None:
    ap = argparse.ArgumentParser(description="离线生成 z_timbre 向量")
    ap.add_argument("--ckpt", required=True, help="midiBrave checkpoint (.pt)")
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--clap-npy", help="训练缓存 embedding 的 glob，例如 '.../serum_s001434_*.npy'")
    src.add_argument("--audio", nargs="+", help="参考音频 wav（需 laion_clap + 训练同款 ckpt）")
    ap.add_argument("--clap-ckpt", default=CLAP_CONTRACT["checkpoint"], help="--audio 模式下的 CLAP 权重")
    ap.add_argument("--name", default="pad", help="声部名，写进 json")
    ap.add_argument("--preset", default=None, help="来源 preset id，写进溯源信息")
    ap.add_argument("-o", "--output", help="输出 json 路径")
    ap.add_argument("--self-test", action="store_true", help="只跑结构自测")
    ap.add_argument("--build-atlas", action="store_true", help="生成音色漫游图谱 atlas.json")
    ap.add_argument("--probe-npz", help="--build-atlas 输入：全语料 z（presets/Z/M）")
    ap.add_argument("--descriptors", help="--build-atlas 输入：每 preset 的 DSP 画像 json")
    ap.add_argument("--ckpt-sha", help="ckpt 不在本机时，显式给出其 sha256")
    args = ap.parse_args()

    if args.self_test:
        self_test(args.ckpt)
        return

    if args.build_atlas:
        if not (args.probe_npz and args.descriptors):
            ap.error("--build-atlas 需要 --probe-npz 与 --descriptors")
        atlas = build_atlas(args.probe_npz, args.descriptors)
        # ckpt 在 Spark/Octopus 上，本机构图时通常没有实体文件，允许直接给 sha。
        sha = sha256_file(args.ckpt) if Path(args.ckpt).is_file() else (args.ckpt_sha or "")
        if not sha:
            ap.error("本机没有 ckpt 实体文件，请用 --ckpt-sha 显式给出 sha256（溯源必填）")
        atlas["midibrave_checkpoint"] = {"path": args.ckpt, "sha256": sha}
        atlas["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        text = json.dumps(atlas, ensure_ascii=False, indent=1)
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(text + "\n", encoding="utf-8")
            sep = atlas["separability"]["anchor_pairwise_cos"]
            print(f"已写出 {args.output}  锚点={len(atlas['anchors'])} "
                  f"两两余弦 min={sep['min']} mean={sep['mean']} max={sep['max']}")
        else:
            print(text)
        return
    if not (args.clap_npy or args.audio):
        ap.error("需要 --clap-npy 或 --audio 之一（或 --self-test）")

    adapter, ckpt_meta = load_adapter(args.ckpt)
    if args.clap_npy:
        E, names = embeddings_from_npy(args.clap_npy)
    else:
        E, names = embeddings_from_audio(args.audio, args.clap_ckpt)

    z, diag = make_z(adapter, E)
    payload = build_payload(z, diag, args, names, ckpt_meta, sha256_file(args.ckpt))

    if diag["high_saturation"]:
        print("注意: tanh 饱和度 %.3f 偏高（>0.5）。实测这不影响可分性，"
              "仅说明该 preset 落在 z 空间边缘，插值时可用步长略小一些。"
              % diag["tanh_saturation_frac"])

    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(text + "\n", encoding="utf-8")
        print(f"已写出 {args.output}  (clips={diag['num_source_clips']}, "
              f"sat={diag['tanh_saturation_frac']}, |z|={diag['abs_z_mean']})")
    else:
        print(text)


if __name__ == "__main__":
    main()
