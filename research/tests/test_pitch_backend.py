"""Backend B (decode_pitch facade) inside the realtime server.

The artifact-gated test runs only when the locked pitch-mvp exports and the
corpus are present locally (weights never enter Git); it verifies that the
conditioned decoder actually follows f0 — the P0-C2 lesson is that naive
conditioning can be silently ignored, so the host must check, not trust.
"""
import json
import hashlib
import unittest
from pathlib import Path

import numpy as np

from latent_cosmos_research.realtime_server import PitchRealtimeDecoder, RealtimeDecoder, midi_to_hz

ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / "research" / "pitch-mvp.lock.json"
MODELS = ROOT / "models" / "pitch-mvp"
CORPUS = ROOT / "data" / "corpus" / "v1"


def locked_artifacts() -> tuple[Path, Path] | None:
    if not (LOCK.exists() and CORPUS.exists()):
        return None
    lock = json.loads(LOCK.read_text())
    streaming = MODELS / lock["artifacts"]["streaming"]["filename"]
    offline = MODELS / lock["artifacts"]["offline"]["filename"]
    if not (streaming.exists() and offline.exists()):
        return None
    for path, spec in ((streaming, lock["artifacts"]["streaming"]), (offline, lock["artifacts"]["offline"])):
        if hashlib.sha256(path.read_bytes()).hexdigest() != spec["sha256"]:
            raise AssertionError(f"artifact {path.name} does not match pitch-mvp.lock.json")
    return streaming, offline


class MidiToHzTest(unittest.TestCase):
    def test_reference_points(self) -> None:
        self.assertAlmostEqual(midi_to_hz(69), 440.0)
        self.assertAlmostEqual(midi_to_hz(60), 261.6255653, places=5)
        self.assertAlmostEqual(midi_to_hz(72) / midi_to_hz(60), 2.0, places=9)

    def test_backend_flags(self) -> None:
        self.assertFalse(RealtimeDecoder.pitch_in_model)
        self.assertTrue(PitchRealtimeDecoder.pitch_in_model)


@unittest.skipUnless(locked_artifacts() is not None, "locked pitch-mvp artifacts or corpus not present")
class PitchBackendDecodeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        streaming, offline = locked_artifacts()
        cls.decoder = PitchRealtimeDecoder("brave-pitch", streaming, offline, CORPUS)

    def _render(self, midi: float, blocks: int = 6) -> np.ndarray:
        from latent_cosmos_research.realtime_server import ClientState, VoiceControl

        state = ClientState()
        state.voices = [VoiceControl(
            object_id=0, species="pulse", decoder_id="brave-pitch",
            relation_state=np.zeros(8, dtype=np.float32), latent_step=0.2,
            note_groups=[{"id": 0, "pitchSemitones": float(midi - 60), "durationSeconds": 1.5,
                          "strength": 1.0, "x": 0.5, "triggerSerial": 1, "triggerStrength": 1.0}],
            pitch_semitones=float(midi - 60), trigger_serial=1, trigger_strength=1.0,
            pan=0.0, energy=0.8, muted=False, solo=False,
        )]
        chunks = [self.decoder.decode(state)[0].mean(axis=1) for _ in range(blocks)]
        return np.concatenate(chunks)

    def _dominant_hz(self, audio: np.ndarray) -> float:
        tail = audio[len(audio) // 3:]
        spectrum = np.abs(np.fft.rfft(tail * np.hanning(len(tail))))
        frequencies = np.fft.rfftfreq(len(tail), 1.0 / self.decoder.sample_rate)
        audible = frequencies > 40.0
        return float(frequencies[audible][np.argmax(spectrum[audible])])

    def test_schema_is_verified(self) -> None:
        self.assertEqual(str(self.decoder.model.get_pitch_performance_schema()), PitchRealtimeDecoder.PERFORMANCE_SCHEMA)

    def test_f0_condition_moves_the_output_pitch(self) -> None:
        low = self._dominant_hz(self._render(60))
        high = self._dominant_hz(self._render(67))
        self.assertGreater(np.abs(self._render(60)).max(), 1e-4, "gated decode must produce audio")
        ratio = high / low
        self.assertAlmostEqual(ratio, midi_to_hz(67) / midi_to_hz(60), delta=0.12,
                               msg=f"decode_pitch ignored f0: dominant ratio {ratio:.3f}")


if __name__ == "__main__":
    unittest.main()
