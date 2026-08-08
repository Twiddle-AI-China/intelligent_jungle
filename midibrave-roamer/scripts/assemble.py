#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "midibrave-roamer"
OUTPUT = PROJECT / "runtime" / "web"


def copy_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def main() -> None:
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir(parents=True)
    for source in (PROJECT / "web").iterdir():
        if source.is_file():
            copy_file(source, OUTPUT / source.name)

    client = ROOT / "flock-voice-engine" / "client"
    copy_file(client / "voice-client.js", OUTPUT / "voice-client.js")
    copy_file(client / "pcm-player-worklet.js", OUTPUT / "pcm-player-worklet.js")

    manifest_path = PROJECT / "config" / "models.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    copy_file(manifest_path, OUTPUT / "models.json")
    maps = ROOT / "flock-voice-engine" / "assets" / "timbre" / "voice_maps"
    for model in manifest["models"]:
        copy_file(maps / model["map"], OUTPUT / "models" / "maps" / model["map"])
    print(OUTPUT)


if __name__ == "__main__":
    main()
