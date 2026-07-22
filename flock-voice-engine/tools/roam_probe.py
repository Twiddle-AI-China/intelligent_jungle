"""z_timbre 漫游速率实测：沿锚点间插值渲染，量每步听感变化，定漫游速率上限。CPU。"""
from __future__ import annotations

import argparse
import json
import sys
import wave
from collections.abc import Sequence
from functools import wraps
from pathlib import Path

if __package__:
    from .project_paths import STAGING_ROOT, VENDOR_MIDIBRAVE
else:
    from project_paths import STAGING_ROOT, VENDOR_MIDIBRAVE

CKPT = "/data/model_weights/midiBrave/midibrave-full-c9-phase1-step-000075365.pt"
SR = 44100
WIN = 49152


def _no_grad(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with torch.no_grad():
            return function(*args, **kwargs)

    return wrapped


def write_wav(path, y, sr):
    """stdlib PCM16 落盘，避免依赖 soundfile。"""
    d = np.clip(np.asarray(y, np.float64), -1, 1)
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((d * 32767).astype('<i2').tobytes())


@_no_grad
def render(model, zs, note=60, vel=127, bs=8):
    outs = []
    for i in range(0, len(zs), bs):
        z = torch.from_numpy(np.asarray(zs[i:i+bs], np.float32))
        n = torch.full((len(z),), note, dtype=torch.long)
        v = torch.full((len(z),), float(vel))
        w = model.decode(z, n, v).cpu().numpy()
        outs.append(w.reshape(len(z), -1))
    return np.concatenate(outs, 0)


# ---- 对数梅尔距离：听感变化的代理量 ----
def melbank(n_fft=2048, n_mel=64):
    f = np.fft.rfftfreq(n_fft, 1/SR)
    m = lambda hz: 2595*np.log10(1+hz/700); im = lambda mel: 700*(10**(mel/2595)-1)
    pts = im(np.linspace(m(30), m(SR/2*0.99), n_mel+2))
    B = np.zeros((n_mel, len(f)))
    for i in range(n_mel):
        lo, ct, hi = pts[i], pts[i+1], pts[i+2]
        L = (f >= lo) & (f <= ct); R = (f > ct) & (f <= hi)
        B[i, L] = (f[L]-lo)/max(ct-lo, 1e-9); B[i, R] = (hi-f[R])/max(hi-ct, 1e-9)
    return B


def logmel(x, mb, n_fft=2048, hop=512):
    fr = [x[i:i+n_fft]*np.hanning(n_fft) for i in range(0, len(x)-n_fft, hop)]
    S = np.abs(np.fft.rfft(np.array(fr), axis=1))**2
    return np.log10(S @ mb.T + 1e-10)


def dist(a, b, mb):
    A, B = logmel(a, mb), logmel(b, mb)
    n = min(len(A), len(B))
    return float(np.sqrt(np.mean((A[:n]-B[:n])**2)))


def roam_wav(model, path, per_note_z, note_seq, vel=127):
    au = render(model, per_note_z, vel=vel) if len(set(note_seq)) == 1 else None
    segs = []
    for k, (z, n) in enumerate(zip(per_note_z, note_seq)):
        a = render(model, [z], note=int(n), vel=vel)[0]
        env = np.ones_like(a); r = int(0.02*SR)
        env[:r] = np.linspace(0, 1, r); env[-r:] = np.linspace(1, 0, r)
        segs.append(a*env)
    y = np.concatenate(segs)
    y = y/max(np.abs(y).max(), 1e-9)*0.7
    write_wav(path, y, SR)
    print("wrote", path, f"{len(y)/SR:.1f}s")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--anchors", type=Path, default=STAGING_ROOT / "anchors_partial.json"
    )
    parser.add_argument("--out", type=Path, default=STAGING_ROOT / "roam")
    parser.add_argument("--vendor", type=Path, default=VENDOR_MIDIBRAVE)
    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int | None:
    args = parse_args(argv)

    global np, torch
    import numpy as np
    import torch

    sys.path.insert(0, str(args.vendor))
    from midibrave.config import ModelConfig
    from midibrave.model import MidiBrave

    args.out.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(8)

    cfg = ModelConfig(clap_dim=512, timbre_dim=128, midi_dim=32, capacity=64,
                      pqmf_bands=16, ratios=[2, 2, 2, 1],
                      pitch_backend='differentiable_crepe_tiny', pqmf_taps=256,
                      anti_image_taps=31, warmup_latent_frames=64,
                      excitation_harmonics=128, excitation_rms=0.1,
                      static_condition_fast_path=True, cache_excitation_bands=True,
                      excitation_cache_note_chunk=8, condition_gain_hidden=0)
    model = MidiBrave(cfg, output_samples=WIN, sample_rate=SR)
    blob = torch.load(CKPT, map_location='cpu', weights_only=False)
    missing, unexpected = model.load_state_dict(blob['model'], strict=False)
    print("missing:", [m for m in missing if 'band_bank' not in m][:10])
    print("unexpected:", list(unexpected)[:10])
    model.eval()

    anchors = json.load(open(args.anchors))
    names = [a['id'] for a in anchors]
    ZA = np.array([a['z_timbre'] for a in anchors], dtype=np.float32)
    print("anchors:", names)

    mb = melbank()

    # ---- 参考尺度：同一 preset 相邻半音 / 不同 velocity 的天然差异 ----
    ref = []
    for k in range(len(ZA)):
        a = render(model, [ZA[k]], note=60)[0]
        b = render(model, [ZA[k]], note=61)[0]
        ref.append(dist(a, b, mb))
    ref_semitone = float(np.median(ref))
    print(f"\n参考尺度 同 preset 相邻半音 logmel 距离 中位数 = {ref_semitone:.4f}")

    # ---- 沿锚点对插值 ----
    STEPS = 33
    pairs = [(0, 7), (1, 6), (2, 4), (3, 5), (8, 0), (8, 7)]
    rows = []
    for i, j in pairs:
        ts = np.linspace(0, 1, STEPS)
        zs = (1-ts)[:, None]*ZA[i][None] + ts[:, None]*ZA[j][None]
        au = render(model, zs)
        zstep = float(np.linalg.norm(ZA[j]-ZA[i]) / (STEPS-1))
        dd = [dist(au[k], au[k+1], mb) for k in range(STEPS-1)]
        total = dist(au[0], au[-1], mb)
        # 离流形检测：插值点的谱平坦度不应超出两端点范围太多
        flat = [float(np.exp(np.mean(np.log(np.abs(np.fft.rfft(a[:SR]))**2+1e-12)))/
                      np.mean(np.abs(np.fft.rfft(a[:SR]))**2+1e-12)) for a in au]
        rms = [float(np.sqrt(np.mean(a**2))) for a in au]
        rows.append(dict(
            pair=f"{names[i]}->{names[j]}",
            zdist=float(np.linalg.norm(ZA[j]-ZA[i])),
            zstep=zstep,
            d_mean=float(np.mean(dd)),
            d_max=float(np.max(dd)),
            total=total,
            flat_mid_over_end=float(
                np.max(flat)/max(max(flat[0], flat[-1]), 1e-9)
            ),
            rms_dip=float(
                np.min(rms)/max(np.mean([rms[0], rms[-1]]), 1e-9)
            ),
        ))
        print(f"\n[{rows[-1]['pair']}]  |Δz|={rows[-1]['zdist']:.2f}  每步Δz={zstep:.3f}")
        print(f"  端到端 logmel={total:.3f}  每步 logmel mean={np.mean(dd):.4f} max={np.max(dd):.4f}"
              f"  (=相邻半音的 {np.mean(dd)/ref_semitone:.2f}x)")
        print(f"  中段谱平坦度/端点={rows[-1]['flat_mid_over_end']:.2f}  "
              f"RMS 最低/端点均值={rows[-1]['rms_dip']:.2f}")
        # 每单位 z 距离带来的听感变化
        print(f"  灵敏度 = {np.mean(dd)/zstep:.4f} logmel / 单位z")

    sens = float(np.median([r['d_mean']/r['zstep'] for r in rows]))
    print(f"\n===== 汇总 =====")
    print(f"听感灵敏度中位数 = {sens:.4f} logmel 每单位 z 距离")
    print(f"1 个半音的听感差 = {ref_semitone:.4f} logmel  → 等效 z 距离 = {ref_semitone/sens:.3f}")
    json.dump(
        dict(rows=rows, ref_semitone=ref_semitone, sensitivity=sens),
        open(args.out / 'roam_metrics.json', 'w'),
        indent=1,
    )

    # ---- 渲染可听素材：锚点巡回，三种速率 ----
    tour = [0, 4, 2, 6, 8, 1, 5, 3, 7]     # 锚点巡回顺序
    notes = [60, 64, 67, 62, 60, 65, 69, 63, 60]
    for rate_name, n_between in (("slow_8", 8), ("med_3", 3), ("jump_0", 0)):
        zs, ns = [], []
        for k in range(len(tour)-1):
            a, b = ZA[tour[k]], ZA[tour[k+1]]
            for s in range(n_between+1):
                t = s/(n_between+1)
                zs.append((1-t)*a + t*b); ns.append(notes[k])
        zs.append(ZA[tour[-1]]); ns.append(notes[-1])
        roam_wav(model, args.out / f'roam_{rate_name}.wav', zs, ns)
        print(f"  {rate_name}: 每音 Δz = "
              f"{np.median([np.linalg.norm(zs[k+1]-zs[k]) for k in range(len(zs)-1)]):.3f}")


if __name__ == "__main__":
    raise SystemExit(main())
