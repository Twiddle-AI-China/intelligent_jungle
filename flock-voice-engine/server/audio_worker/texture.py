"""Deterministic controlled-sample rendering for Amen and forest ambience."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from .jungle import jungle_grain_plan, jungle_slice_for_cell, reverse_amen_offset


def _decode(path: Path, sample_rate: int) -> np.ndarray:
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    if data.size == 0 or rate <= 0 or not np.isfinite(data).all():
        raise RuntimeError("CONTROLLED_AUDIO_DECODE_FAILED")
    mono = data.mean(axis=1, dtype=np.float32)
    if rate != sample_rate:
        x = np.arange(mono.size, dtype=np.float64)
        target = np.arange(round(mono.size * sample_rate / rate), dtype=np.float64) * rate / sample_rate
        mono = np.interp(target, x, mono).astype(np.float32)
    return mono


class TextureRenderer:
    def __init__(self, amen_path: Path, forest_path: Path, sample_rate: int, deterministic_seed: object = 0):
        self.sample_rate = int(sample_rate)
        self.amen = _decode(Path(amen_path), self.sample_rate)
        self.forest = _decode(Path(forest_path), self.sample_rate)
        self.seed = str(deterministic_seed)
        self.forest_cursor = 0

    @classmethod
    def from_bundle(cls, bundle, sample_rate: int, deterministic_seed: object = 0):
        return cls(bundle.path("audio/amen.wav"), bundle.path("audio/forest.wav"), sample_rate, deterministic_seed)

    def reset(self, deterministic_seed: object) -> None:
        self.seed = str(deterministic_seed)
        self.forest_cursor = 0

    def ambience(self, frames: int) -> np.ndarray:
        indices = (np.arange(frames) + self.forest_cursor) % self.forest.size
        self.forest_cursor = (self.forest_cursor + frames) % self.forest.size
        return self.forest[indices].astype(np.float32, copy=False)

    def render(self, event: dict[str, Any], frames: int) -> np.ndarray:
        identity = json.dumps(event, sort_keys=True, separators=(",", ":"), default=str)
        seed = int.from_bytes(hashlib.sha256(f"{self.seed}:{identity}".encode()).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        slice_value = jungle_slice_for_cell(**event)
        edit = event.get("jungleEditPlan") or {}
        if edit.get("breakEdit") == "dropout":
            return np.zeros(frames, dtype=np.float32)
        repeats = 4 if edit.get("breakEdit") == "repeat4" else 2 if edit.get("breakEdit") == "repeat2" else 1
        output = np.zeros(frames, dtype=np.float32)
        amen_duration = self.amen.size / self.sample_rate
        base = min(slice_value["amenStep"] * amen_duration / 32, max(0, amen_duration - .01))
        reverse = edit.get("toneEdit") == "reverse"
        source = self.amen[::-1] if reverse else self.amen
        for repeat in range(repeats):
            local = dict(slice_value, outputSeconds=slice_value["outputSeconds"] / repeats)
            for grain in jungle_grain_plan(local, grainSeconds=event.get("grainSeconds", .1),
                                           overlap=event.get("overlap", .5)):
                start = round((repeat * local["outputSeconds"] + grain["outputOffset"]) * self.sample_rate)
                count = min(frames - start, max(0, round(grain["outputDuration"] * self.sample_rate)))
                if count <= 0:
                    continue
                forward = (base + grain["sourceOffset"]) % amen_duration
                source_offset = reverse_amen_offset(amen_duration, forward, grain["sourceDuration"]) if reverse else forward
                positions = (source_offset * self.sample_rate
                             + np.arange(count, dtype=np.float64) * grain["playbackRate"]) % source.size
                samples = np.interp(positions, np.arange(source.size), source).astype(np.float32)
                fade = max(1, min(count // 2, round(count * event.get("overlap", .5))))
                window = np.ones(count, dtype=np.float32)
                window[:fade] = np.linspace(0, 1, fade, dtype=np.float32)
                window[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
                output[start:start + count] += samples * window
        if edit.get("toneEdit") == "crush":
            output = np.round(output * 12) / 12
        elif edit.get("toneEdit") == "filter":
            output = np.concatenate(([output[0]], np.diff(output))).astype(np.float32)
        elif edit.get("toneEdit") == "dub":
            delay = min(frames - 1, round(min(.32, slice_value["outputSeconds"] * .5) * self.sample_rate))
            if delay > 0:
                output[delay:] += output[:-delay] * .18
        note_velocity = max(0.0, min(1.0, float(event.get("velocity", 1.0))))
        output *= np.float32(note_velocity * slice_value["velocity"] * (.999 + rng.random() * .001))
        return np.nan_to_num(output, copy=False).astype(np.float32)
