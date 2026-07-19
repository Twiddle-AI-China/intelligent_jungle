"""给二维音色地图的每个点标定响度增益。

九个锚点的增益覆盖不了 1239 个 preset —— XY 直控可以落在任意位置，
用「最近锚点的增益」近似会残留约 4 倍的响度差（实测 RMS 0.12–0.50）。
这里对每个点实际渲染一次、算 K 加权响度、存回 latent_map.json。

一次性离线任务，约十几分钟。之后 kNN 混合 z 的同时也 kNN 混合增益，
XY 平面上的响度就是连续的。
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools.calibrate_loudness import (  # noqa: E402
    GAIN_DB_MAX, GAIN_DB_MIN, TARGET_DBFS, loudness_dbfs,
)
from server.backends.midibrave_backend import MidiBraveBackend  # noqa: E402

REF_NOTE, REF_VELOCITY = 60, 127
#: 比锚点标定短 —— 1239 个点，时长直接决定总耗时。1.2 s 掐掉 0.4 s 起音后
#: 还剩 0.8 s 稳态，对稳态响度已经足够。
REF_SECONDS, SKIP_SECONDS = 1.2, 0.4


def main() -> int:
    map_path = ROOT / "assets" / "timbre" / "latent_map.json"
    data = json.loads(map_path.read_text(encoding="utf-8"))
    zs = np.asarray(data["z"], dtype=np.float32)

    backend = MidiBraveBackend()
    skip = int(SKIP_SECONDS * backend.geometry.sample_rate)
    gains, louds = [], []
    started = time.time()
    for index, z in enumerate(zs):
        wave = backend.render_note(torch.from_numpy(z).view(1, -1),
                                   REF_NOTE, REF_VELOCITY, REF_SECONDS)
        loud = loudness_dbfs(wave[skip:], backend.geometry.sample_rate)
        correction = float(np.clip(TARGET_DBFS - loud, GAIN_DB_MIN, GAIN_DB_MAX))
        louds.append(loud)
        gains.append(round(float(10 ** (correction / 20.0)), 6))
        if index % 100 == 0:
            rate = (index + 1) / max(time.time() - started, 1e-6)
            print(f"  {index}/{len(zs)}  {rate:.1f} 点/秒  "
                  f"剩余约 {(len(zs)-index)/max(rate,1e-6)/60:.1f} 分钟", flush=True)

    louds = np.array(louds)
    print(f"标定前极差 {louds.max()-louds.min():.1f} dB")
    for point, gain in zip(data["points"], gains):
        point["gain"] = gain
    data["loudness_calibration"] = {
        "target_dbfs": TARGET_DBFS, "per_point": True,
        "reference": {"note": REF_NOTE, "velocity": REF_VELOCITY,
                      "seconds": REF_SECONDS, "skip_seconds": SKIP_SECONDS},
    }
    map_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"已写回 {map_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
