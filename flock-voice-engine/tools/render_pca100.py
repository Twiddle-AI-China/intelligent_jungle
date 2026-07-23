"""把 select_100.py 选出的 100 个 preset 渲成三档音频，供听感对比。

只允许在依赖齐备的隔离 candidate checkout 中运行，输入和输出都留在该 checkout 的
``staging/``；不得从 active production tree 运行。

三档 = ``z_true`` / ``z_pca2`` / ``z_pca10``（见 ``select_100.py``）。
第四档「原始 Serum 音频」在 Octopus，不经过模型，由外部脚本拉取。

**音高逐 preset 对齐**：语料里不是每个 preset 都铺满全音域，各自可用的音不同
（``pick_100.json`` 给出每个 preset 实际存在的最接近 60 的音）。decoder 必须渲同一个音，
否则 A/B 比的是音高差不是音色差。

模型调用方式与 ``roam_probe.py`` 一致（``model.decode(z, note, vel)``）。
不接响度归一化增益，也不接软限幅 —— 这里要听的是 decoder 裸输出。

隔离 candidate checkout 用法::

    cd /srv/staging/flock-voice-engine-candidate
    .venv/bin/python tools/render_pca100.py \
        --in staging/pca100 --out staging/pca100/renders
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import wave
from collections.abc import Sequence
from functools import wraps
from pathlib import Path

if __package__:
    from .project_paths import STAGING_ROOT, VENDOR_MIDIBRAVE
else:
    from project_paths import STAGING_ROOT, VENDOR_MIDIBRAVE

CKPT = "/data/model_weights/midiBrave/midibrave-full-c9-phase1-step-000075365.pt"
SR = 44_100
WIN = 49_152  # ≈1.11 s，与 roam_probe 一致
VARIANTS = ("z_true", "z_pca2", "z_pca10")


def _no_grad(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with torch.no_grad():
            return function(*args, **kwargs)

    return wrapped


def write_wav(path: Path, y: np.ndarray, sr: int = SR) -> None:
    """stdlib PCM16 落盘，避免依赖 soundfile。"""
    d = np.clip(np.asarray(y, np.float64), -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((d * 32767).astype("<i2").tobytes())


def build_model(vendor: Path) -> "torch.nn.Module":
    sys.path.insert(0, str(vendor))
    from midibrave.config import ModelConfig
    from midibrave.model import MidiBrave

    cfg = ModelConfig(
        clap_dim=512, timbre_dim=128, midi_dim=32, capacity=64,
        pqmf_bands=16, ratios=[2, 2, 2, 1],
        pitch_backend="differentiable_crepe_tiny", pqmf_taps=256,
        anti_image_taps=31, warmup_latent_frames=64,
        excitation_harmonics=128, excitation_rms=0.1,
        static_condition_fast_path=True, cache_excitation_bands=True,
        excitation_cache_note_chunk=8, condition_gain_hidden=0,
    )
    model = MidiBrave(cfg, output_samples=WIN, sample_rate=SR)
    blob = torch.load(CKPT, map_location="cpu", weights_only=False)
    missing, unexpected = model.load_state_dict(blob["model"], strict=False)
    real_missing = [m for m in missing if "band_bank" not in m]
    if real_missing:
        print(f"⚠️ missing keys: {real_missing[:10]}")
    if unexpected:
        print(f"⚠️ unexpected keys: {list(unexpected)[:10]}")
    print(f"checkpoint step={blob.get('step')} phase={blob.get('phase')} "
          f"disc_updates={blob.get('discriminator_updates')}")
    model.eval()
    return model


@_no_grad
def render(model, zs: np.ndarray, notes: list[int], vels: list[int],
           batch: int = 8) -> np.ndarray:
    outs = []
    for i in range(0, len(zs), batch):
        z = torch.from_numpy(np.asarray(zs[i:i + batch], np.float32))
        n = torch.tensor(notes[i:i + batch], dtype=torch.long)
        v = torch.tensor([float(x) for x in vels[i:i + batch]])
        w = model.decode(z, n, v).cpu().numpy()
        outs.append(w.reshape(len(z), -1))
    return np.concatenate(outs, 0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--in", dest="indir", type=Path, default=STAGING_ROOT / "pca100"
    )
    parser.add_argument(
        "--out", type=Path, default=STAGING_ROOT / "pca100" / "renders"
    )
    parser.add_argument("--vendor", type=Path, default=VENDOR_MIDIBRAVE)
    parser.add_argument("--threads", type=int, default=8)
    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int | None:
    args = parse_args(argv)

    global np, torch
    import numpy as np
    import torch

    torch.set_num_threads(args.threads)
    indir, outdir = args.indir, args.out
    outdir.mkdir(parents=True, exist_ok=True)

    sel = json.loads((indir / "selection_100.json").read_text())
    pick = json.loads((indir / "pick_100.json").read_text())
    items = [it for it in sel["items"] if it["id"] in pick]
    print(f"待渲 {len(items)} 个 preset × {len(VARIANTS)} 档")

    model = build_model(args.vendor)
    notes = [pick[it["id"]]["note"] for it in items]
    vels = [pick[it["id"]]["vel"] for it in items]

    manifest = []
    for variant in VARIANTS:
        t0 = time.time()
        zs = np.array([it[variant] for it in items], dtype=np.float32)
        audio = render(model, zs, notes, vels)
        for it, note, vel, y in zip(items, notes, vels, audio):
            name = f"{it['id']}__{variant}.wav"
            write_wav(outdir / name, y)
        peak = float(np.abs(audio).max())
        rms = float(np.sqrt((audio.astype(np.float64) ** 2).mean()))
        print(f"{variant:9s} 完成 {time.time() - t0:6.1f}s  "
              f"peak={peak:.3f} rms={rms:.4f} "
              f"{'⚠️ 削顶' if peak >= 0.999 else ''}")

    for it, note, vel in zip(items, notes, vels):
        manifest.append({
            "id": it["id"], "note": note, "velocity": vel,
            "src_note": pick[it["id"]]["src"],
            "original_file": pick[it["id"]]["file"],
            "renders": {v: f"{it['id']}__{v}.wav" for v in VARIANTS},
        })
    (outdir / "manifest.json").write_text(json.dumps({
        "schema": 1, "sample_rate": SR, "samples": WIN,
        "checkpoint": Path(CKPT).name,
        "variants": list(VARIANTS),
        "pca": sel["pca"],
        "coverage_cosine": sel["coverage_cosine"],
        "items": manifest,
    }, indent=2))
    print(f"\n写入 {outdir}  （{len(items) * len(VARIANTS)} 个 WAV + manifest.json）")


if __name__ == "__main__":
    raise SystemExit(main())
