"""发行版运行路径；默认值全部由源码位置推导。"""
from __future__ import annotations

import os
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ENGINE_ROOT.parent
MODEL_DIR = Path(
    os.environ.get("LCS_MODEL_DIR", str(ENGINE_ROOT / "model_weights" / "midiBrave"))
).resolve()
LOAD_LOG_PATH = Path(
    os.environ.get(
        "LCS_LOAD_LOG_PATH",
        str(REPOSITORY_ROOT / "runtime" / "logs" / "flock-voice-load.jsonl"),
    )
).resolve()
