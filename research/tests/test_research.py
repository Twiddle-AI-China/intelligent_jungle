import tempfile
import unittest
from pathlib import Path

from latent_cosmos_research.atlas import build_atlas
from latent_cosmos_research.corpus import generate
from latent_cosmos_research.gate import evaluate
from latent_cosmos_research.realtime_server import StreamingPitchShifter, atlas_latent_point, limited_step, parse_controls, read_stratified_audio, relation_latent_point, svd_plane_point


class ResearchToolsTest(unittest.TestCase):
    def test_corpus_and_atlas_are_reproducible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = generate(root / "corpus", duration=0.2, sample_rate=8_000, seed=42)
            atlas = build_atlas(root / "corpus", root / "atlas.json", window_seconds=0.1, neighbors=2)
            self.assertEqual(len(manifest["files"]), 3)
            self.assertGreater(atlas["safe_count"], 0)

    def test_fixture_can_never_pass_the_model_gate(self):
        result = evaluate({"gate_eligible": False, "target": {"system": "Darwin", "machine": "arm64", "memory_bytes": 17_179_869_184}, "voices": 8, "estimated_control_latency_ms": 1, "latency_ms": {"jitter_stdev": 0.1}, "rtf": 0.1, "continuous_minutes": 30, "deadline_misses": 0})
        self.assertFalse(result["passed"])

    def test_realtime_contract_is_one_bounded_relational_voice_with_independent_pitch(self):
        controls = parse_controls({"voices": [{"objectId": i, "relationState": [-2, 2] * 5, "gate": True, "gateSerial": 4, "velocity": 2, "pitchSemitones": 99, "notes": [{"id": n, "pitchSemitones": n * 20, "velocity": 2} for n in range(5)], "timbreRange": 99, "latentStep": 99, "attackSeconds": 0, "releaseSeconds": 99, "maxDurationSeconds": 99} for i in range(4)]})
        self.assertEqual(len(controls), 1)
        control = controls[0]
        self.assertEqual(control.relation_state.tolist(), [-1, 1] * 4)
        self.assertEqual(control.pitch_semitones, 12)
        self.assertEqual(control.timbre_range, 6)
        self.assertEqual(len(control.notes), 3)
        self.assertEqual(control.notes[-1]["pitchSemitones"], 12)
        self.assertEqual((control.latent_step, control.attack_seconds, control.release_seconds, control.max_duration_seconds), (0.5, 0.001, 4, 30))

    def test_whole_flock_relations_change_the_full_latent_vector(self):
        import numpy as np
        rng = np.random.default_rng(8)
        basis, _ = np.linalg.qr(rng.normal(size=(16, 16)))
        anchor = np.zeros(16, dtype=np.float32); scale = np.ones(16, dtype=np.float32)
        low = relation_latent_point(anchor, basis, scale, np.full(8, -0.5, dtype=np.float32))
        high = relation_latent_point(anchor, basis, scale, np.full(8, 0.5, dtype=np.float32))
        self.assertGreater(np.count_nonzero(np.abs(high - low) > 1e-5), 12)
        deep = relation_latent_point(anchor, basis, scale, np.full(8, 0.5, dtype=np.float32), 3.0)
        self.assertAlmostEqual(float(np.linalg.norm(deep)), float(np.linalg.norm(high)) * 3, places=5)

    def test_atlas_mapping_stays_in_a_local_blend_of_real_nodes(self):
        import numpy as np
        latents = np.asarray([[0, 1, 2, 3], [0, 2, 4, 6], [1, 1, 1, 1]], dtype=np.float32)
        features = np.asarray([[-1, -0.3, 0.3, 1], [0, 0.2, 0.7, 1]], dtype=np.float32)
        point, distance, node = atlas_latent_point(latents, features, np.asarray([0.4, 0.8]), 1.0, neighbors=2)
        self.assertIn(node, range(4)); self.assertGreaterEqual(distance, 0)
        self.assertGreaterEqual(point[0], 1); self.assertLessEqual(point[0], 3)
        self.assertAlmostEqual(point[2], 1, places=6)

    def test_svd_xy_plane_returns_a_full_vector_and_center_is_anchor(self):
        import numpy as np
        rng = np.random.default_rng(42)
        basis, _ = np.linalg.qr(rng.normal(size=(16, 16)))
        anchor = np.linspace(-1, 1, 16, dtype=np.float32)
        scale = np.linspace(0.2, 1.2, 16, dtype=np.float32)
        center = svd_plane_point(anchor, basis, scale, 0.5, 0.5)
        corner = svd_plane_point(anchor, basis, scale, 1.0, 0.0)
        np.testing.assert_allclose(center, anchor, atol=1e-6)
        self.assertEqual(corner.shape, (16,))
        self.assertGreater(np.count_nonzero(np.abs(corner - anchor) > 1e-5), 8)

    def test_latent_step_moves_toward_target_without_overshoot(self):
        import numpy as np
        previous = np.zeros(4, dtype=np.float32); target = np.array([3, 4, 0, 0], dtype=np.float32)
        moved, remaining = limited_step(previous, target, 0.5)
        self.assertAlmostEqual(float(np.linalg.norm(moved - previous)), 0.5, places=6)
        self.assertAlmostEqual(remaining, 4.5, places=6)

    def test_stratified_audio_samples_the_whole_file(self):
        import numpy as np
        import soundfile as sf
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "ramp.wav"
            sf.write(path, np.linspace(-1, 1, 8000, dtype=np.float32), 8000)
            sampled = read_stratified_audio(path, 8000, segment_seconds=0.1, segments=3)
            self.assertLess(sampled[:800].mean(), -0.8)
            self.assertGreater(sampled[-800:].mean(), 0.8)

    def test_post_decoder_keyboard_pitch_changes_sine_frequency(self):
        import numpy as np
        rate = 44_100
        source = np.sin(2 * np.pi * 440 * np.arange(40 * 1024, dtype=np.float32) / rate)
        shifter = StreamingPitchShifter()
        output = np.concatenate([shifter.process(block, 12) for block in source.reshape(-1, 1024)])[8192:]
        spectrum = np.abs(np.fft.rfft(output * np.hanning(len(output))))
        peak = np.fft.rfftfreq(len(output), 1 / rate)[np.argmax(spectrum)]
        self.assertGreater(peak, 840); self.assertLess(peak, 920)


if __name__ == "__main__":
    unittest.main()
