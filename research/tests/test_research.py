import tempfile
import unittest
from pathlib import Path

from latent_cosmos_research.atlas import build_atlas
from latent_cosmos_research.corpus import generate
from latent_cosmos_research.gate import evaluate
from latent_cosmos_research.realtime_server import StreamingPitchShifter, parse_controls


class ResearchToolsTest(unittest.TestCase):
    def test_corpus_and_atlas_are_reproducible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = generate(root / "corpus", duration=0.2, sample_rate=8_000, seed=42)
            atlas = build_atlas(root / "corpus", root / "atlas.json", window_seconds=0.1, neighbors=2)
            self.assertEqual(len(manifest["files"]), 3)
            self.assertGreater(atlas["safe_count"], 0)
            self.assertTrue((root / "atlas.json").exists())

    def test_fixture_can_never_pass_the_model_gate(self):
        result = evaluate({
            "gate_eligible": False,
            "target": {"system": "Darwin", "machine": "arm64", "memory_bytes": 17_179_869_184},
            "voices": 8,
            "estimated_control_latency_ms": 1,
            "latency_ms": {"jitter_stdev": 0.1},
            "rtf": 0.1,
            "continuous_minutes": 30,
            "deadline_misses": 0,
        })
        self.assertFalse(result["passed"])
        self.assertFalse(result["checks"]["real_model"])

    def test_realtime_controls_are_bounded_to_six_voices_and_four_latent_inputs(self):
        payload = {
            "voices": [
                {"objectId": index, "species": "pulse", "chartPosition": [0.1] * 9, "pitchSemitones": 20, "pan": 0, "energy": 0.5}
                for index in range(8)
            ]
        }
        controls = parse_controls(payload)
        self.assertEqual(len(controls), 6)
        self.assertTrue(all(control.chart_position.shape == (2,) for control in controls))
        self.assertTrue(all(control.pitch_semitones == 6 for control in controls))

    def test_streaming_pitch_shifter_changes_sine_frequency(self):
        import numpy as np

        sample_rate = 44_100
        source = np.sin(2 * np.pi * 440 * np.arange(sample_rate, dtype=np.float32) / sample_rate)
        shifter = StreamingPitchShifter()
        output = np.concatenate([shifter.process(block, 6) for block in source[:40 * 1024].reshape(-1, 1024)])
        analysis = output[8192:]
        spectrum = np.abs(np.fft.rfft(analysis * np.hanning(len(analysis))))
        peak = np.fft.rfftfreq(len(analysis), 1 / sample_rate)[np.argmax(spectrum)]
        self.assertGreater(peak, 600)
        self.assertLess(peak, 660)


if __name__ == "__main__":
    unittest.main()
