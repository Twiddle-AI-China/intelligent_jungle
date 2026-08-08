#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "midibrave-roamer"
ENGINE = ROOT / "flock-voice-engine"
sys.path.insert(0, str(ENGINE))

from assemble import main as assemble  # noqa: E402
from verify_assets import verify_assets  # noqa: E402
from server.app import main as engine_main  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Model-driven latent roamer")
    parser.add_argument("--backend", choices=("synth", "neural"), default="synth")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8092)
    parser.add_argument(
        "--skip-assemble",
        action="store_true",
        help="Serve an already assembled runtime tree (used by the read-only image).",
    )
    args = parser.parse_args()
    if not args.skip_assemble:
        assemble()
    if args.backend == "neural":
        verified = verify_assets(
            PROJECT / "config" / "models.json",
            Path("/data/model_weights/midiBrave"),
            ENGINE / "vendor",
            ENGINE / "assets" / "timbre" / "voice_defaults",
        )
        print(f"[assets] verified {len(verified)} bindings", flush=True)
    backend = "synth" if args.backend == "synth" else "brave-voices"
    pool_size = 4 if args.backend == "synth" else 5
    device = "cpu" if args.backend == "synth" else "cuda"
    engine_main([
        "--host", args.host,
        "--port", str(args.port),
        "--backend", backend,
        "--pool-size", str(pool_size),
        "--block-samples", "4096",
        "--device", device,
        "--static", str(PROJECT / "runtime" / "web"),
    ])


if __name__ == "__main__":
    main()
