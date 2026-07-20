from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--checkpoint",
        default="/data/model_weights/laion-clap/music_audioset_epoch_15_esc_90.14.pt",
    )
    args = parser.parse_args()
    checkpoint = Path(args.checkpoint)
    if not checkpoint.is_file():
        raise FileNotFoundError(checkpoint)

    import laion_clap

    model = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-base", device="cpu")
    model.load_ckpt(str(checkpoint))
    print(json.dumps({
        "checkpoint": str(checkpoint),
        "bytes": checkpoint.stat().st_size,
        "sha256": sha256(checkpoint),
        "model": "HTSAT-base",
        "fusion": False,
        "offline_load": "ok",
    }, sort_keys=True))


if __name__ == "__main__":
    main()
