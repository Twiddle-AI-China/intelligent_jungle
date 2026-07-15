import importlib.util
import unittest


torch_available = importlib.util.find_spec("torch") is not None


@unittest.skipUnless(torch_available, "pitch model tests require the rave extra")
class PitchModelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import torch
        from latent_cosmos_research.pitch_model import FiLMConditioner, HarmonicExcitation
        cls.torch = torch
        cls.FiLMConditioner = FiLMConditioner
        cls.HarmonicExcitation = HarmonicExcitation

    def test_harmonic_excitation_is_scriptable_and_matches_target_rms(self):
        torch = self.torch
        model = torch.jit.script(self.HarmonicExcitation(sample_rate=8_000, samples_per_frame=64, max_harmonics=32))
        conditioning = torch.tensor([[[200.0, 300.0], [0.08, 0.15], [1.0, 1.0]]])
        audio, phase = model(conditioning, torch.zeros(1))
        measured = torch.sqrt(torch.mean(audio.reshape(1, 2, 64).square(), dim=-1))
        torch.testing.assert_close(measured, conditioning[:, 1], rtol=0.02, atol=1e-4)
        self.assertEqual(tuple(audio.shape), (1, 1, 128))
        self.assertEqual(tuple(phase.shape), (1,))

    def test_explicit_phase_state_changes_the_next_streaming_block(self):
        torch = self.torch
        model = self.HarmonicExcitation(sample_rate=44_100, samples_per_frame=128, max_harmonics=64)
        conditioning = torch.tensor([[[261.6256], [0.1], [1.0]]])
        _first, phase = model(conditioning, torch.zeros(1))
        continued, _ = model(conditioning, phase)
        restarted, _ = model(conditioning, torch.zeros(1))
        self.assertFalse(torch.allclose(continued, restarted))

    def test_film_starts_as_exact_pass_through_and_remains_scriptable(self):
        torch = self.torch
        film = torch.jit.script(self.FiLMConditioner(condition_channels=16, feature_channels=32))
        features = torch.randn(2, 32, 7)
        condition = torch.randn(2, 16, 14)
        torch.testing.assert_close(film(features, condition), features, rtol=0, atol=0)


if __name__ == "__main__":
    unittest.main()
