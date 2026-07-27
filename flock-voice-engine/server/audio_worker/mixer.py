"""Stateful server-owned final mix; split remains a dry pre-mix tap."""
from __future__ import annotations

import hashlib
import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt


class ServerMixer:
    def __init__(self, sample_rate: int, block_frames: int, row_voices: list[str],
                 ambience: np.ndarray | None = None, deterministic_seed: object = 0):
        self.sample_rate = int(sample_rate)
        self.block_frames = int(block_frames)
        self.row_voices = tuple(row_voices)
        self.ambience = None if ambience is None else np.asarray(ambience, dtype=np.float32)
        self.ambience_cursor = 0
        seed = int.from_bytes(hashlib.sha256(str(deterministic_seed).encode()).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        seconds = 1.9
        length = max(1, round(self.sample_rate * seconds))
        self.ir = (rng.uniform(-1, 1, length) * (1 - np.arange(length) / length) ** 2.6).astype(np.float32)
        self.ir /= np.float32(max(1.0, np.sqrt(np.sum(self.ir.astype(np.float64) ** 2))))
        self._reverb_tail = np.zeros(length - 1, dtype=np.float32)
        self._low_sos = butter(2, 250, btype="lowpass", fs=self.sample_rate, output="sos")
        self._high_sos = butter(2, 2500, btype="highpass", fs=self.sample_rate, output="sos")
        self._low_zi = [np.zeros((self._low_sos.shape[0], 2), dtype=np.float64)
                        for _ in self.row_voices]
        self._high_zi = [np.zeros((self._high_sos.shape[0], 2), dtype=np.float64)
                         for _ in self.row_voices]
        self.last_row_master_contribution_peak_abs = [0.0 for _ in self.row_voices]

    def reset(self, deterministic_seed: object = 0) -> None:
        self.__init__(self.sample_rate, self.block_frames, list(self.row_voices), self.ambience, deterministic_seed)

    def _state(self, state):
        return state.get("mix", state) if isinstance(state, dict) else {}

    @staticmethod
    def _species(row_voice: str) -> str:
        return {"lead": "melody", "pluck": "texture"}.get(row_voice, row_voice)

    def _assigned_species(self, assignments, row: int, row_voice: str) -> str:
        fallback = self._species(row_voice)
        if isinstance(assignments, list) and row < len(assignments):
            value = assignments[row]
            if isinstance(value, str) and value:
                return value
            if isinstance(value, dict) and isinstance(value.get("species"), str):
                return value["species"]
        if isinstance(assignments, dict):
            direct = assignments.get(str(row), assignments.get(row))
            if isinstance(direct, str) and direct:
                return direct
            for species, rows in assignments.items():
                if ((type(rows) is int and rows == row)
                        or (isinstance(rows, list) and row in rows)):
                    return str(species)
        return fallback

    def process(self, stems: np.ndarray, state: dict) -> tuple[np.ndarray, np.ndarray]:
        raw = np.asarray(stems, dtype=np.float32)
        if raw.shape == (len(self.row_voices), self.block_frames):
            split = raw.T.copy()
        elif raw.shape == (self.block_frames, len(self.row_voices)):
            split = raw.copy()
        else:
            raise RuntimeError("MIXER_STEM_GEOMETRY_INVALID")
        if not np.isfinite(split).all():
            raise RuntimeError("MIXER_NONFINITE_INPUT")
        mix = self._state(state)
        assignments = state.get("assignments", {}) if isinstance(state, dict) else {}
        gains = mix.get("species", {})
        mute = mix.get("mute", {})
        solo = mix.get("solo", {})
        species_by_row = [self._assigned_species(assignments, row, name)
                          for row, name in enumerate(self.row_voices)]
        any_solo = any(solo.get(species, False) for species in species_by_row)
        wet = np.zeros(self.block_frames, dtype=np.float32)
        dry = np.zeros(self.block_frames, dtype=np.float32)
        row_contributions: list[np.ndarray] = []
        sends = mix.get("reverb", {})
        for row, name in enumerate(self.row_voices):
            species = species_by_row[row]
            gate = not mute.get(species, False) and (not any_solo or solo.get(species, False))
            signal = split[:, row] * np.float32(float(gains.get(species, 1.0)) if gate else 0.0)
            # Two persistent biquads split low/mid/high without block seams.
            low, self._low_zi[row] = sosfilt(self._low_sos, signal, zi=self._low_zi[row])
            high, self._high_zi[row] = sosfilt(self._high_sos, signal, zi=self._high_zi[row])
            low = low.astype(np.float32)
            high = high.astype(np.float32)
            eq = mix.get("eq", {}).get(species, {}) if isinstance(mix.get("eq", {}), dict) else {}
            low_db = float(eq.get("low", eq.get("eqLowDb", 0.0)))
            mid_db = float(eq.get("mid", eq.get("eqMidDb", 0.0)))
            high_db = float(eq.get("high", eq.get("eqHighDb", 0.0)))
            low_gain, mid_gain, high_gain = (np.float32(10 ** (db / 20)) for db in (low_db, mid_db, high_db))
            shaped = low * low_gain + (signal - low - high) * mid_gain + high * high_gain
            row_contributions.append(shaped)
            dry += shaped
            wet += shaped * np.float32(float(sends.get(species, 0.0)) if isinstance(sends, dict) else 0.0)
        convolution = fftconvolve(wet, self.ir).astype(np.float32)
        convolution[:self._reverb_tail.size] += self._reverb_tail
        self._reverb_tail = convolution[self.block_frames:self.block_frames + self._reverb_tail.size].copy()
        mono = dry + convolution[:self.block_frames]
        if self.ambience is not None and self.ambience.size:
            idx = (np.arange(self.block_frames) + self.ambience_cursor) % self.ambience.size
            self.ambience_cursor = (self.ambience_cursor + self.block_frames) % self.ambience.size
            mono += self.ambience[idx] * np.float32(.11)
        master_gain = np.float32(float(mix.get("masterGain", 1.0)))
        self.last_row_master_contribution_peak_abs = [
            float(np.max(np.abs(contribution * master_gain)))
            for contribution in row_contributions
        ]
        mono *= master_gain
        mono = np.tanh(mono).astype(np.float32)
        master = np.repeat(mono[:, None], 2, axis=1)
        return master, split
