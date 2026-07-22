from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .audio import read_wav
from .descriptors import describe

FEATURES = ("brightness", "noisiness", "transientness", "roughness_proxy", "harmonicity")


def build_atlas(input_dir: Path, output: Path, window_seconds: float = 0.5, neighbors: int = 6) -> dict:
    nodes: list[dict] = []
    for wav in sorted(input_dir.glob("*.wav")):
        audio, sample_rate = read_wav(wav)
        window = max(256, int(window_seconds * sample_rate))
        for offset in range(0, max(1, len(audio) - window + 1), window):
            values = describe(audio[offset : offset + window], sample_rate)
            nodes.append({"id": len(nodes), "file": wav.name, "offset": offset, "sample_rate": sample_rate, "descriptors": values, "safe": bool(values.get("valid", 0))})
    safe = [node for node in nodes if node["safe"]]
    if safe:
        matrix = np.array([[node["descriptors"][name] for name in FEATURES] for node in safe])
        scale = np.std(matrix, axis=0) + 1e-6
        normalized = (matrix - np.mean(matrix, axis=0)) / scale
        # Blocked exact kNN avoids allocating an O(n²) matrix for long renders.
        for start in range(0, len(safe), 256):
            block = normalized[start : start + 256]
            distances = np.sqrt(np.sum((block[:, None, :] - normalized[None, :, :]) ** 2, axis=2))
            for local_row, row in enumerate(range(start, min(start + 256, len(safe)))):
                order = np.argpartition(distances[local_row], min(neighbors + 1, len(safe) - 1))[: neighbors + 1]
                order = order[np.argsort(distances[local_row, order])]
                safe[row]["neighbors"] = [safe[index]["id"] for index in order if index != row][:neighbors]
    atlas = {"schema": 1, "features": FEATURES, "nodes": nodes, "safe_count": len(safe), "unsafe_count": len(nodes) - len(safe)}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(atlas, indent=2), encoding="utf-8")
    return atlas


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a perceptual kNN atlas and reject unsafe rendered windows.")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--window", type=float, default=0.5)
    parser.add_argument("--neighbors", type=int, default=6)
    args = parser.parse_args()
    atlas = build_atlas(args.input, args.output, args.window, args.neighbors)
    print(json.dumps({"safe_count": atlas["safe_count"], "unsafe_count": atlas["unsafe_count"]}))


if __name__ == "__main__":
    main()
