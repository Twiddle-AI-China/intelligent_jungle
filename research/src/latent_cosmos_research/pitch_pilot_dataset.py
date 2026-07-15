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
        preset_indices: set[int] | None = None,
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

        requested_presets = set(preset_indices) if preset_indices else None
        available_presets = {int(item["preset_index"]) for item in report["clips"]}
        missing = (requested_presets or set()) - available_presets
        if missing:
            raise ValueError(f"requested pilot presets are missing: {sorted(missing)}")

        for item in report["clips"]:
            if requested_presets and int(item["preset_index"]) not in requested_presets:
                continue
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
        start = self._crop_start(index, audio.shape[-1])
        return self._example_from_clip(clip, start)

    def _example_from_clip(
        self, clip: dict[str, object], start: int
    ) -> dict[str, torch.Tensor]:
        audio = clip["audio"]
        metadata = clip["metadata"]
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


class DexedPitchSwapDataset(DexedPitchPilotDataset):
    """Same-preset, different-note pairs for forcing use of target pitch."""

    PITCH_NOTES = (41, 48, 56, 63)

    def __init__(self, *args, preset_indices: set[int] | None = None, **kwargs) -> None:
        super().__init__(*args, preset_indices=preset_indices, **kwargs)
        self.pitch_clips = [
            clip
            for clip in self.clips
            if int(clip["metadata"]["velocity"]) == 75
            and int(clip["metadata"]["midi_note"]) in self.PITCH_NOTES
        ]
        self.by_preset: dict[int, dict[int, dict[str, object]]] = {}
        for clip in self.pitch_clips:
            metadata = clip["metadata"]
            self.by_preset.setdefault(int(metadata["preset_index"]), {})[
                int(metadata["midi_note"])
            ] = clip
        incomplete = [
            preset
            for preset, clips in self.by_preset.items()
            if set(clips) != set(self.PITCH_NOTES)
        ]
        if incomplete:
            raise ValueError(f"pitch-swap presets lack four notes: {incomplete}")

    def __len__(self) -> int:
        return len(self.pitch_clips) * self.repeats

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        target = self.pitch_clips[index % len(self.pitch_clips)]
        target_metadata = target["metadata"]
        target_note = int(target_metadata["midi_note"])
        source_notes = [note for note in self.PITCH_NOTES if note != target_note]
        repeat_index = index // len(self.pitch_clips)
        source_note = source_notes[repeat_index % len(source_notes)]
        source = self.by_preset[int(target_metadata["preset_index"])][source_note]
        maximum_length = min(target["audio"].shape[-1], source["audio"].shape[-1])
        start = self._crop_start(index, maximum_length)
        target_example = self._example_from_clip(target, start)
        source_example = self._example_from_clip(source, start)
        return {
            "source_audio": source_example["audio"],
            "target_audio": target_example["audio"],
            "conditioning": target_example["conditioning"],
            "preset_index": target_example["preset_index"],
            "source_midi_note": source_example["midi_note"],
            "source_pitch_class": torch.tensor(
                self.PITCH_NOTES.index(source_note), dtype=torch.long
            ),
            "target_midi_note": target_example["midi_note"],
            "velocity": target_example["velocity"],
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
