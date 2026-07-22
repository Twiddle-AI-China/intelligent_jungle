from __future__ import annotations

import wave
from pathlib import Path

import numpy as np


def write_wav(path: Path, samples: np.ndarray, sample_rate: int = 48_000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    audio = np.asarray(samples, dtype=np.float64)
    audio = np.clip(audio, -1.0, 1.0)
    pcm = (audio * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm.tobytes())


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        sample_rate = source.getframerate()
        width = source.getsampwidth()
        frames = source.readframes(source.getnframes())
    if width != 2:
        raise ValueError(f"only 16-bit PCM is supported by the lightweight reader: {path}")
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float64) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, sample_rate
