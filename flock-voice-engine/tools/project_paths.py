from __future__ import annotations

import os
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[1]
STAGING_ROOT = Path(os.environ.get("FLOCK_STAGING_ROOT", ENGINE_ROOT / "staging"))
VENDOR_MIDIBRAVE = Path(
    os.environ.get("FLOCK_MIDIBRAVE_ROOT", ENGINE_ROOT / "vendor" / "midibrave" / "src")
)
TIMBRE_WEIGHTS = Path(
    os.environ.get("FLOCK_TIMBRE_WEIGHTS", STAGING_ROOT / "timbre_net.npz")
)
