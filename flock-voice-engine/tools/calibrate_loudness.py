"""锚点响度标定：给 atlas 里每个锚点算一个归一化增益。

## 为什么不用压缩器

不同锚点的响度差异是**静态的电平差**（实测 RMS 0.0149–0.1429，近 10 倍），
不是动态范围问题。上压缩器会把 velocity 差异和包络起伏一起压掉 —— 那是音乐性，
不该被当成噪声消掉。正确做法是离线标定每个锚点的增益，运行期只是一个乘数。

## 为什么用 K 加权而不是裸 RMS

bright 锚点的能量集中在 6–9 kHz，裸 RMS 会**低估**它的听感响度（人耳在 2–5 kHz
最敏感，低频钝感）。这里用 ITU-R BS.1770 的 K 加权简化版：一级高通（去掉听感上
不贡献响度的极低频）+ 一级高频搁架（补偿头部效应）。不是完整 LUFS 实现 ——
不做门限（gating）和多声道加权，因为我们是单声道稳态单音，那两项没有意义。

## 标定条件

固定 midi 60 / velocity 127 / 3 秒，掐掉起音只取稳态。跨锚点必须用同一条件，
否则量到的是音高和力度的差异而不是音色的。

用法::

    python3 tools/calibrate_loudness.py               # 写回 atlas.json
    python3 tools/calibrate_loudness.py --dry-run     # 只看结果不写
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ATLAS = PROJECT_ROOT / "assets" / "timbre" / "atlas.json"

#: 标定用的参考音。跨锚点必须一致。
REF_NOTE = 60
REF_VELOCITY = 127
REF_SECONDS = 3.0
#: 掐掉前这么多秒的起音，只量稳态 —— 起音差异属于音色特征，不该进响度标定。
SKIP_ATTACK_SECONDS = 0.5
#: 目标响度（K 加权 RMS 的 dBFS）。取偏保守的值，给包络和多声部叠加留余量。
TARGET_DBFS = -23.0
#: 增益修正上下限。超过这个范围说明锚点本身有问题（比如几乎不发声），
#: 硬拉上来只会把底噪放大 —— 宁可让它偏轻，也不要放大垃圾。
GAIN_DB_MIN, GAIN_DB_MAX = -12.0, 18.0


def k_weight(x: np.ndarray, sample_rate: int) -> np.ndarray:
    """BS.1770 K 加权的简化实现：高通 + 高频搁架。

    直接在频域做 —— 我们量的是整段稳态的能量，不需要逐样本滤波器的相位特性。
    """
    spectrum = np.fft.rfft(x * np.hanning(len(x)))
    freqs = np.fft.rfftfreq(len(x), 1.0 / sample_rate)

    # 1) 高通：~60 Hz 以下按二阶滚降衰减。极低频对响度感知贡献很小，
    #    但对 RMS 贡献很大，不去掉会让低频厚的锚点被高估。
    highpass = (freqs / 60.0) ** 2 / (1.0 + (freqs / 60.0) ** 2)

    # 2) 高频搁架：1.5 kHz 以上逐步 +4 dB，模拟头部效应造成的高频听感增益。
    #    这是 bright 锚点在裸 RMS 下被低估的直接原因。
    shelf = 1.0 + (10 ** (4.0 / 20.0) - 1.0) / (1.0 + (1500.0 / np.maximum(freqs, 1.0)) ** 2)

    return spectrum * highpass * shelf


def loudness_dbfs(x: np.ndarray, sample_rate: int = 44_100) -> float:
    """K 加权响度，dBFS。"""
    weighted = k_weight(x, sample_rate)
    # Parseval：频域能量 → 时域 RMS（窗函数的相干增益在跨锚点比较时抵消）
    energy = float(np.sum(np.abs(weighted) ** 2)) / (len(x) ** 2 / 2.0)
    return 10.0 * np.log10(max(energy, 1e-20))


def main() -> int:
    parser = argparse.ArgumentParser(description="标定 atlas 锚点的响度归一化增益")
    parser.add_argument("--atlas", default=str(DEFAULT_ATLAS))
    parser.add_argument("--dry-run", action="store_true", help="只打印，不写回 atlas")
    parser.add_argument("--target-dbfs", type=float, default=TARGET_DBFS)
    args = parser.parse_args()

    sys.path.insert(0, str(PROJECT_ROOT))
    import torch  # noqa: PLC0415

    from server.backends.midibrave_backend import MidiBraveBackend  # noqa: PLC0415

    atlas_path = Path(args.atlas)
    atlas = json.loads(atlas_path.read_text(encoding="utf-8"))
    anchors = atlas.get("anchors", [])
    if not anchors:
        print("atlas 里没有锚点", file=sys.stderr)
        return 1

    backend = MidiBraveBackend()
    sample_rate = backend.geometry.sample_rate
    skip = int(SKIP_ATTACK_SECONDS * sample_rate)

    print(f"标定条件: midi {REF_NOTE} / v{REF_VELOCITY} / {REF_SECONDS}s，"
          f"掐掉前 {SKIP_ATTACK_SECONDS}s 起音；目标 {args.target_dbfs:.1f} dBFS(K)\n")
    print(f"{'锚点':<20} {'K响度dBFS':>11} {'裸RMS':>9} {'修正dB':>8} {'增益':>7}")

    results = []
    for anchor in anchors:
        z = torch.tensor(anchor["z_timbre"], dtype=torch.float32).view(1, -1)
        wave = backend.render_note(z, REF_NOTE, REF_VELOCITY, REF_SECONDS)
        body = wave[skip:]
        loud = loudness_dbfs(body, sample_rate)
        raw_rms = float(np.sqrt(np.mean(body**2)))
        correction = float(np.clip(args.target_dbfs - loud, GAIN_DB_MIN, GAIN_DB_MAX))
        gain = float(10 ** (correction / 20.0))
        results.append((anchor, loud, raw_rms, correction, gain))
        clipped = "" if GAIN_DB_MIN < correction < GAIN_DB_MAX else "  ← 触顶"
        print(f"{anchor['id']:<20} {loud:11.2f} {raw_rms:9.4f} "
              f"{correction:8.2f} {gain:7.3f}{clipped}")

    louds = np.array([r[1] for r in results])
    print(f"\n标定前跨锚点响度极差 {louds.max() - louds.min():.1f} dB")
    after = louds + np.array([r[3] for r in results])
    print(f"标定后极差 {after.max() - after.min():.1f} dB"
          f"（残差来自增益上下限的钳制）")

    if args.dry_run:
        print("\n--dry-run，未写回")
        return 0

    for anchor, loud, raw_rms, correction, gain in results:
        anchor["loudness"] = {
            "k_weighted_dbfs": round(loud, 3),
            "raw_rms": round(raw_rms, 6),
            "gain_db": round(correction, 3),
            "gain": round(gain, 6),
        }
    atlas["loudness_calibration"] = {
        "target_dbfs": args.target_dbfs,
        "method": "BS.1770-simplified K-weighting (highpass 60Hz + 1.5kHz shelf +4dB)",
        "reference": {"note": REF_NOTE, "velocity": REF_VELOCITY,
                      "seconds": REF_SECONDS, "skip_attack_seconds": SKIP_ATTACK_SECONDS},
        "gain_db_clamp": [GAIN_DB_MIN, GAIN_DB_MAX],
    }
    atlas_path.write_text(json.dumps(atlas, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写回 {atlas_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
