import tempfile
import unittest
from pathlib import Path

from latent_cosmos_research.atlas import build_atlas
from latent_cosmos_research.corpus import generate
from latent_cosmos_research.gate import evaluate


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


if __name__ == "__main__":
    unittest.main()
