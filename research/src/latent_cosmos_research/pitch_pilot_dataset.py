"""Aligned audio and renderer-truth conditioning for the Dexed P0-C2 pilot."""
from __future__ import annotations

import json
from pathlib import Path

import soundfile as sf
import torch
import torchaudio
from torch.utils.data import Dataset


class DexedPitchPilotDataset(Dataset):
    """Small in-memory dataset with frame-aligned crops and known MIDI labels.

    The source corpus is only 48 four-second mono clips, so loading and
    resampling once per worker is cheaper and less error-prone than creating a
    second opaque RAVE database. Repeats provide deterministic crop diversity;
    they do not claim additional independent observations.
    """

    def __init__(
        self,
        manifest: str | Path,
        *,
        n_signal: int,
        sample_rate: int,
        samples_per_frame: int = 128,
        repeats: int = 16,
        seed: int = 20260716,
    ) -> None:
        if n_signal <= 0 or n_signal % samples_per_frame:
            raise ValueError("n_signal must be a positive multiple of samples_per_frame")
        if repeats <= 0:
            raise ValueError("repeats must be positive")
        self.manifest_path = Path(manifest)
        report = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        if report.get("schema_version") != "p0c-dexed-pilot-verified-v1":
            raise ValueError("P0-C2 requires a verified Dexed pilot manifest")
        source_root = Path(report["selection"]["source_root"])
        self.n_signal = n_signal
        self.sample_rate = sample_rate
        self.samples_per_frame = samples_per_frame
        self.repeats = repeats
        self.seed = seed
        self.clips: list[dict[str, object]] = []

        for item in report["clips"]:
            path = source_root / str(item["source_wav"])
            waveform, source_rate = sf.read(path, dtype="float32", always_2d=True)
            mono = torch.from_numpy(waveform.mean(axis=1)).reshape(1, -1)
            if source_rate != sample_rate:
                mono = torchaudio.functional.resample(mono, source_rate, sample_rate)
            if mono.shape[-1] < n_signal:
                mono = torch.nn.functional.pad(mono, (0, n_signal - mono.shape[-1]))
            self.clips.append({"metadata": dict(item), "audio": mono.contiguous()})

        if len(self.clips) < 2:
            raise ValueError("pilot manifest must contain at least two clips")

    def __len__(self) -> int:
        return len(self.clips) * self.repeats

    def _crop_start(self, index: int, length: int) -> int:
        maximum_frame = max(0, (length - self.n_signal) // self.samples_per_frame)
        if maximum_frame == 0:
            return 0
        generator = torch.Generator().manual_seed(self.seed + index)
        frame = int(torch.randint(maximum_frame + 1, (1,), generator=generator))
        return frame * self.samples_per_frame

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        clip = self.clips[index % len(self.clips)]
        audio = clip["audio"]
        metadata = clip["metadata"]
        start = self._crop_start(index, audio.shape[-1])
        cropped = audio[..., start : start + self.n_signal].clone()

        frames = self.n_signal // self.samples_per_frame
        framed = cropped.reshape(1, frames, self.samples_per_frame)
        loudness = torch.sqrt(framed.square().mean(dim=-1) + 1e-12)[0].clamp(0.0, 1.0)
        frame_centres = (
            start
            + (torch.arange(frames, dtype=torch.float32) + 0.5) * self.samples_per_frame
        ) / float(self.sample_rate)
        gate = (
            (frame_centres >= float(metadata["note_on_seconds"]))
            & (frame_centres < float(metadata["note_off_seconds"]))
        ).to(torch.float32)
        f0 = torch.full((frames,), float(metadata["expected_f0_hz"])) * gate
        conditioning = torch.stack([f0, loudness, gate], dim=0)
        return {
            "audio": cropped,
            "conditioning": conditioning,
            "preset_index": torch.tensor(int(metadata["preset_index"])),
            "midi_note": torch.tensor(int(metadata["midi_note"])),
            "velocity": torch.tensor(int(metadata["velocity"])),
        }


def pilot_conditioning_diagnostics(dataset: DexedPitchPilotDataset) -> dict[str, float]:
    """Cheap construction-time facts logged before reserving a GPU."""
    examples = [dataset[index] for index in range(min(len(dataset.clips), len(dataset)))]
    conditioning = torch.stack([example["conditioning"] for example in examples])
    return {
        "clips": float(len(dataset.clips)),
        "examples_with_repeats": float(len(dataset)),
        "frames_per_example": float(conditioning.shape[-1]),
        "voiced_ratio": float((conditioning[:, 0] > 0).float().mean()),
        "gate_ratio": float(conditioning[:, 2].mean()),
        "f0_min_voiced": float(conditioning[:, 0][conditioning[:, 0] > 0].min()),
        "f0_max_voiced": float(conditioning[:, 0].max()),
    }
