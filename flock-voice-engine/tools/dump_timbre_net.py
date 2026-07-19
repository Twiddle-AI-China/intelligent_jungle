"""把 checkpoint 里的 timbre.net（6 个张量）导成 npz。

给 tools/build_latent_map.py 用 —— 那个脚本要在 Octopus 上跑（CLAP 缓存在那），
但 Octopus 既没装 torch 也没有本工程树。搬 6 个小张量过去，比把 438 MB 的
CLAP 缓存拉回 Spark 划算。
"""
import sys
from pathlib import Path

import numpy as np
import torch

CKPT = sys.argv[1] if len(sys.argv) > 1 else \
    "/data/model_weights/midiBrave/midibrave-full-c9-phase1-step-000075365.pt"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/home/rolf/staging/timbre_net.npz"

state = torch.load(CKPT, map_location="cpu", weights_only=False)["model"]
g = lambda k: state[f"timbre.net.{k}"].numpy()
np.savez(OUT,
         ln_weight=g("0.weight"), ln_bias=g("0.bias"),
         fc1_weight=g("1.weight"), fc1_bias=g("1.bias"),
         fc2_weight=g("3.weight"), fc2_bias=g("3.bias"))
print("已写", OUT, {k: v.shape for k, v in np.load(OUT).items()})
