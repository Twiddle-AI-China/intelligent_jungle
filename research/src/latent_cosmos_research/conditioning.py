from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np


CONDITIONING_SCHEMA = "pitch-conditioning-v2:f0_hz,loudness,gate,periodicity"
CONDITIONING_CHANNELS = ("f0_hz", "loudness", "gate", "periodicity")
PITCH_PERFORMANCE_SCHEMA = "pitch-performance-v1:f0_hz,loudness,gate;periodicity=gate"
PITCH_PERFORMANCE_CHANNELS = ("f0_hz", "loudness", "gate")
REFERENCE_MIDI = 60.0
REFERENCE_HZ = 261.6255653005986


def midi_to_hz(note: float | np.ndarray) -> float | np.ndarray:
    """Convert fractional MIDI notes to Hz without quantizing pitch bend."""
    value = np.asarray(note, dtype=np.float64)
    result = 440.0 * np.power(2.0, (value - 69.0) / 12.0)
    return float(result) if result.ndim == 0 else result


def semitones_to_hz(semitones: float | np.ndarray, reference_midi: float = REFERENCE_MIDI) -> float | np.ndarray:
    return midi_to_hz(np.asarray(semitones, dtype=np.float64) + reference_midi)


def velocity_to_loudness(velocity: float | np.ndarray, floor: float = 0.02, ceiling: float = 0.2) -> float | np.ndarray:
    """Map performance intent to a bounded target RMS, not to an audio gain claim."""
    value = np.clip(np.asarray(velocity, dtype=np.float64), 0.0, 1.0)
    result = floor + (ceiling - floor) * np.power(value, 1.5)
    return float(result) if result.ndim == 0 else result


def build_note_conditioning(
    notes: Sequence[Mapping[str, object]],
    frames: int,
    *,
    default_semitones: float = 0.0,
    default_velocity: float = 0.8,
    default_gate: bool = True,
    default_periodicity: float = 1.0,
    max_notes: int = 3,
) -> np.ndarray:
    """Build [note, channel, latent-frame] controls for a conditioned decoder.

    f0=0 is reserved for unvoiced/noise excitation. A closed musical gate is
    therefore represented by the independent gate channel rather than by
    overwriting f0. The v2 periodicity channel blends the harmonic oscillator
    against noise so inharmonic timbres are not forced through a pure
    oscillator; MIDI performance of harmonic timbres uses 1.0.
    """
    if frames <= 0:
        raise ValueError("frames must be positive")
    selected = list(notes[:max_notes])
    if not selected:
        selected = [{"pitchSemitones": default_semitones, "velocity": default_velocity, "gate": default_gate}]

    result = np.zeros((len(selected), len(CONDITIONING_CHANNELS), frames), dtype=np.float32)
    for index, note in enumerate(selected):
        semitones = float(np.clip(note.get("pitchSemitones", default_semitones), -48.0, 48.0))
        velocity = float(np.clip(note.get("velocity", default_velocity), 0.0, 1.0))
        gate = float(bool(note.get("gate", default_gate)))
        periodicity = float(np.clip(note.get("periodicity", default_periodicity), 0.0, 1.0))
        result[index, 0, :] = semitones_to_hz(semitones)
        result[index, 1, :] = velocity_to_loudness(velocity)
        result[index, 2, :] = gate
        result[index, 3, :] = periodicity
    return result


def validate_conditioning(conditioning: np.ndarray, frames: int | None = None) -> np.ndarray:
    value = np.asarray(conditioning, dtype=np.float32)
    if value.ndim != 3 or value.shape[1] != len(CONDITIONING_CHANNELS):
        raise ValueError(f"conditioning must have shape [batch, 4, frames], got {value.shape}")
    if frames is not None and value.shape[-1] != frames:
        raise ValueError(f"conditioning has {value.shape[-1]} frames, expected {frames}")
    if not np.isfinite(value).all():
        raise ValueError("conditioning contains non-finite values")
    if np.any(value[:, 0] < 0):
        raise ValueError("f0_hz must be non-negative")
    if np.any((value[:, 1:] < 0) | (value[:, 1:] > 1)):
        raise ValueError("loudness, gate and periodicity must be in [0, 1]")
    return value


@dataclass
class HarmonicExcitationState:
    """Reference P-RAVE excitation renderer used for tests and corpus probes.

    This intentionally favors a readable implementation of equations 1-5 in
    the paper, extended by the v2 periodicity mix: the harmonic oscillator and
    the noise source are blended linearly by the periodicity channel, so
    periodicity=1 on voiced frames and 0 on unvoiced frames reproduces the v1
    renderer exactly. The trainable Torch implementation may optimize the same
    contract, but must match this renderer on deterministic voiced inputs.
    """

    sample_rate: int
    phase: float = 0.0
    seed: int = 0

    def render(self, conditioning: np.ndarray, samples_per_frame: int) -> np.ndarray:
        controls = validate_conditioning(conditioning)
        if controls.shape[0] != 1:
            raise ValueError("reference renderer accepts one note at a time")
        if samples_per_frame <= 0:
            raise ValueError("samples_per_frame must be positive")

        f0 = np.repeat(controls[0, 0], samples_per_frame).astype(np.float64)
        loudness = np.repeat(controls[0, 1], samples_per_frame).astype(np.float64)
        gate = np.repeat(controls[0, 2], samples_per_frame).astype(np.float64)
        periodicity = np.repeat(controls[0, 3], samples_per_frame).astype(np.float64)
        excitation = np.empty_like(f0)
        rng = np.random.default_rng(self.seed)
        phase = float(self.phase)
        nyquist = self.sample_rate / 2.0

        for sample, frequency in enumerate(f0):
            noise = rng.normal()
            if frequency <= 0.0:
                periodic = 0.0
            else:
                phase = (phase + 2.0 * np.pi * frequency / self.sample_rate) % (2.0 * np.pi)
                harmonics = max(1, int(nyquist // frequency))
                indices = np.arange(1, harmonics + 1, dtype=np.float64)
                periodic = float(np.sum(np.sin(indices * phase) / indices))
            mix = periodicity[sample]
            excitation[sample] = mix * periodic + (1.0 - mix) * noise

        self.phase = phase
        self.seed += 1
        framed = excitation.reshape(-1, samples_per_frame)
        frame_rms = np.sqrt(np.mean(np.square(framed), axis=1) + 1e-12)
        target = controls[0, 1].astype(np.float64)
        scaled = framed * ((target + 1e-5) / (frame_rms + 1e-5))[:, None]
        scaled *= gate.reshape(-1, samples_per_frame)
        return scaled.reshape(-1).astype(np.float32)
