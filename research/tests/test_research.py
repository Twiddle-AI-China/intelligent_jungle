import tempfile
import unittest
from pathlib import Path

from latent_cosmos_research.atlas import build_atlas
from latent_cosmos_research.corpus import generate
from latent_cosmos_research.gate import evaluate
from latent_cosmos_research.realtime_server import parse_controls


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
                {"objectId": index, "species": "pulse", "latentPosition": [0.1] * 9, "pan": 0, "energy": 0.5}
                for index in range(8)
            ]
        }
        controls = parse_controls(payload)
        self.assertEqual(len(controls), 6)
        self.assertTrue(all(control.latent_position.shape == (4,) for control in controls))


if __name__ == "__main__":
    unittest.main()
