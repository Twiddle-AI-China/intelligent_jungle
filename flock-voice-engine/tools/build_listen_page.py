"""把四档音频对齐、归一化、算指标，并生成一页可 A/B 的试听页。本地跑（只需 numpy）。

四档：``orig``（Octopus 原始 Serum 渲染）/ ``z_true``（decoder 重建）/
``z_pca2`` / ``z_pca10``（PCA 反投影后重建）。

## 为什么要归一化再听

原始与 decoder 输出的绝对电平差好几 dB，不归一化的话耳朵会把「响」直接听成「好」。
所以试听版本统一 RMS 归一到 -20 dBFS；**真实电平差另外用数字如实报出来**
（``rms_dbfs_raw``），不藏。

## 为什么要截齐长度

原始文件比 decoder 输出长（decoder 固定 49152 样本 ≈1.11 s）。
不截齐的话尾巴长短会干扰判断，所以一律取前 49152 样本。

用法::

    python3 tools/build_listen_page.py
    python3 -m http.server 8777 --directory staging/listen   # 然后开 /index.html
"""
from __future__ import annotations

import json
import struct
import wave
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
LISTEN = REPO / "staging" / "listen"
SR = 44_100
WIN = 49_152
TARGET_DBFS = -20.0
VARIANTS = ("orig", "z_true", "z_pca10", "z_pca2")
LABELS = {
    "orig": "原始 Serum",
    "z_true": "decoder 重建",
    "z_pca10": "PCA-10 反投影",
    "z_pca2": "PCA-2 反投影",
}


def read_wav(path: Path) -> np.ndarray:
    """读 PCM16 / float32 WAV，返回 mono float64。stdlib wave 不认 format 3，所以自己解。"""
    raw = path.read_bytes()
    assert raw[:4] == b"RIFF" and raw[8:12] == b"WAVE", f"不是 WAV: {path}"
    pos, fmt, bits, ch, data = 12, None, None, 1, None
    while pos + 8 <= len(raw):
        cid, size = raw[pos:pos + 4], struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        body = raw[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt, ch, _, _, _, bits = struct.unpack("<HHIIHH", body[:16])
        elif cid == b"data":
            data = body
        pos += 8 + size + (size & 1)
    assert data is not None and fmt is not None, f"缺 fmt/data: {path}"
    if fmt == 3 and bits == 32:
        y = np.frombuffer(data, "<f4").astype(np.float64)
    elif fmt == 1 and bits == 16:
        y = np.frombuffer(data, "<i2").astype(np.float64) / 32768.0
    elif fmt == 1 and bits == 24:
        b = np.frombuffer(data, np.uint8).reshape(-1, 3).astype(np.int32)
        v = (b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16))
        y = np.where(v & 0x800000, v - (1 << 24), v).astype(np.float64) / (1 << 23)
    else:
        raise ValueError(f"不支持的格式 fmt={fmt} bits={bits}: {path}")
    return y.reshape(-1, ch).mean(1) if ch > 1 else y


def write_pcm16(path: Path, y: np.ndarray) -> None:
    d = np.clip(y, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((d * 32767).astype("<i2").tobytes())


def fit(y: np.ndarray) -> np.ndarray:
    """截/补到 WIN 样本。"""
    return y[:WIN] if len(y) >= WIN else np.pad(y, (0, WIN - len(y)))


def rms_dbfs(y: np.ndarray) -> float:
    r = float(np.sqrt(np.mean(y**2)))
    return 20 * np.log10(max(r, 1e-12))


def melbank(n_fft: int = 2048, n_mel: int = 64) -> np.ndarray:
    """与 roam_probe.py 同一套 mel 定义，保证两处数字可比。"""
    f = np.fft.rfftfreq(n_fft, 1 / SR)
    to_mel = lambda hz: 2595 * np.log10(1 + hz / 700)
    to_hz = lambda mel: 700 * (10 ** (mel / 2595) - 1)
    pts = to_hz(np.linspace(to_mel(30), to_mel(SR / 2 * 0.99), n_mel + 2))
    b = np.zeros((n_mel, len(f)))
    for i in range(n_mel):
        lo, ct, hi = pts[i], pts[i + 1], pts[i + 2]
        left, right = (f >= lo) & (f <= ct), (f > ct) & (f <= hi)
        b[i, left] = (f[left] - lo) / max(ct - lo, 1e-9)
        b[i, right] = (hi - f[right]) / max(hi - ct, 1e-9)
    return b


MB = melbank()


def logmel(x: np.ndarray, n_fft: int = 2048, hop: int = 512) -> np.ndarray:
    frames = np.array([x[i:i + n_fft] * np.hanning(n_fft)
                       for i in range(0, len(x) - n_fft, hop)])
    spec = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    return np.log10(spec @ MB.T + 1e-10)


def logmel_dist(a: np.ndarray, b: np.ndarray) -> float:
    A, B = logmel(a), logmel(b)
    n = min(len(A), len(B))
    return float(np.sqrt(np.mean((A[:n] - B[:n]) ** 2)))


def centroid(y: np.ndarray) -> float:
    spec = np.abs(np.fft.rfft(y * np.hanning(len(y))))
    f = np.fft.rfftfreq(len(y), 1 / SR)
    return float((spec * f).sum() / max(spec.sum(), 1e-12))


def main() -> None:
    manifest = json.loads((LISTEN / "renders" / "manifest.json").read_text())
    out_dir = LISTEN / "clips"
    out_dir.mkdir(exist_ok=True)

    rows = []
    for item in manifest["items"]:
        pid = item["id"]
        srcs = {
            "orig": LISTEN / "orig" / f"{pid}__orig.wav",
            **{v: LISTEN / "renders" / f"{pid}__{v}.wav" for v in
               ("z_true", "z_pca2", "z_pca10")},
        }
        audio, row = {}, {"id": pid, "note": item["note"], "velocity": item["velocity"],
                          "src_note": item["src_note"], "metrics": {}}
        for key, path in srcs.items():
            y = fit(read_wav(path))
            raw_db = rms_dbfs(y)
            gain = 10 ** ((TARGET_DBFS - raw_db) / 20) if raw_db > -np.inf else 0.0
            norm = y * min(gain, 10 ** (30 / 20))  # 增益封顶 +30 dB，防近静音被放大成噪声
            write_pcm16(out_dir / f"{pid}__{key}.wav", norm)
            audio[key] = norm
            row["metrics"][key] = {
                "rms_dbfs_raw": round(raw_db, 2),
                "centroid_hz": round(centroid(norm), 1),
            }
        row["metrics"]["dist"] = {
            "orig_vs_true": round(logmel_dist(audio["orig"], audio["z_true"]), 4),
            "true_vs_pca10": round(logmel_dist(audio["z_true"], audio["z_pca10"]), 4),
            "true_vs_pca2": round(logmel_dist(audio["z_true"], audio["z_pca2"]), 4),
            "orig_vs_pca2": round(logmel_dist(audio["orig"], audio["z_pca2"]), 4),
        }
        rows.append(row)

    agg = {k: round(float(np.median([r["metrics"]["dist"][k] for r in rows])), 4)
           for k in rows[0]["metrics"]["dist"]}
    lvl = {v: round(float(np.median([r["metrics"][v]["rms_dbfs_raw"] for r in rows])), 2)
           for v in VARIANTS}
    cen = {v: round(float(np.median([r["metrics"][v]["centroid_hz"] for r in rows])), 1)
           for v in VARIANTS}
    summary = {"logmel_median": agg, "rms_dbfs_raw_median": lvl,
               "centroid_hz_median": cen, "pca": manifest["pca"],
               "coverage_cosine": manifest["coverage_cosine"],
               "checkpoint": manifest["checkpoint"], "count": len(rows)}
    (LISTEN / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))

    print(json.dumps(summary, indent=2, ensure_ascii=False))
    (LISTEN / "data.js").write_text(
        "window.DATA=" + json.dumps({"rows": rows, "summary": summary,
                                     "labels": LABELS, "variants": list(VARIANTS)}) + ";")
    print(f"\n{len(rows)} 行 × 4 档写入 {out_dir}")


if __name__ == "__main__":
    main()
