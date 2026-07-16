import importlib.util
import unittest


torch_available = importlib.util.find_spec("torch") is not None and importlib.util.find_spec("rave") is not None


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
        conditioning = torch.tensor([[[200.0, 300.0], [0.08, 0.15], [1.0, 1.0], [1.0, 1.0]]])
        audio, phase = model(conditioning, torch.zeros(1))
        measured = torch.sqrt(torch.mean(audio.reshape(1, 2, 64).square(), dim=-1))
        torch.testing.assert_close(measured, conditioning[:, 1], rtol=0.02, atol=1e-4)
        self.assertEqual(tuple(audio.shape), (1, 1, 128))
        self.assertEqual(tuple(phase.shape), (1,))

    def test_explicit_phase_state_changes_the_next_streaming_block(self):
        torch = self.torch
        model = self.HarmonicExcitation(sample_rate=44_100, samples_per_frame=128, max_harmonics=64)
        conditioning = torch.tensor([[[261.6256], [0.1], [1.0], [1.0]]])
        _first, phase = model(conditioning, torch.zeros(1))
        continued, _ = model(conditioning, phase)
        restarted, _ = model(conditioning, torch.zeros(1))
        self.assertFalse(torch.allclose(continued, restarted))

    def test_periodicity_channel_blends_oscillator_against_noise(self):
        torch = self.torch
        model = self.HarmonicExcitation(sample_rate=8_000, samples_per_frame=64, max_harmonics=32)
        voiced = torch.tensor([[[200.0, 200.0], [0.1, 0.1], [1.0, 1.0], [1.0, 1.0]]])

        # Full periodicity multiplies the noise source by zero: the output is
        # deterministic across RNG states, i.e. exactly the v1 voiced path.
        torch.manual_seed(1)
        first, _ = model(voiced, torch.zeros(1))
        torch.manual_seed(2)
        second, _ = model(voiced, torch.zeros(1))
        torch.testing.assert_close(first, second, rtol=0, atol=0)

        # Zero periodicity is pure noise at the same target RMS, even though
        # f0 stays at its nominal value for the inharmonic timbre.
        noisy = voiced.clone(); noisy[:, 3] = 0.0
        torch.manual_seed(1)
        noise_a, _ = model(noisy, torch.zeros(1))
        torch.manual_seed(2)
        noise_b, _ = model(noisy, torch.zeros(1))
        self.assertFalse(torch.allclose(noise_a, noise_b))
        measured = torch.sqrt(torch.mean(noise_a.reshape(1, 2, 64).square(), dim=-1))
        torch.testing.assert_close(measured, noisy[:, 1], rtol=0.05, atol=1e-4)

        # Intermediate periodicity correlates with the oscillator monotonically.
        def oscillator_correlation(mix: float) -> float:
            blended = voiced.clone(); blended[:, 3] = mix
            torch.manual_seed(3)
            output, _ = model(blended, torch.zeros(1))
            flat, reference = output.reshape(-1), first.reshape(-1)
            return float(
                (flat * reference).sum()
                / (flat.norm() * reference.norm() + 1e-12)
            )

        self.assertGreater(oscillator_correlation(0.75), oscillator_correlation(0.25))

    def test_film_starts_as_exact_pass_through_and_remains_scriptable(self):
        torch = self.torch
        film = torch.jit.script(self.FiLMConditioner(condition_channels=16, feature_channels=32))
        features = torch.randn(2, 32, 7)
        condition = torch.randn(2, 16, 14)
        torch.testing.assert_close(film(features, condition), features, rtol=0, atol=0)

    def test_brave_film_generator_has_matching_condition_rates_and_pass_through_sites(self):
        import cached_conv as cc
        import gin
        from rave import blocks
        from latent_cosmos_research.pitch_generator import PitchConditionedGenerator

        torch = self.torch
        gin.clear_config()
        gin.bind_parameter("normalization.mode", "identity")
        gin.bind_parameter("ResidualStack.kernel_sizes", [3])
        gin.bind_parameter("ResidualStack.dilations_list", [[3, 1], [9, 1]])
        gin.bind_parameter("cc.get_padding.mode", "causal")
        cc.use_cached_conv(False)
        baseline = blocks.Generator(16, 4, 16, [2, 2, 2, 1], 1, False)
        generator = PitchConditionedGenerator(16, 4, 16, [2, 2, 2, 1], 1, False)
        generator.initial.load_state_dict(baseline.net[0].state_dict())
        for index in range(4):
            generator.upsamples[index].load_state_dict(baseline.net[1 + index * 2].state_dict())
            generator.residuals[index].load_state_dict(baseline.net[2 + index * 2].state_dict())
        generator.synth.load_state_dict(baseline.synth.state_dict())
        latent = torch.randn(2, 16, 3)
        excitation = torch.randn(2, 16, 24)
        levels = generator.conditioning_levels(excitation)
        self.assertEqual([level.shape[-1] for level in levels], [6, 12, 24, 24])
        output = generator(latent, excitation)
        self.assertEqual(tuple(output.shape), (2, 16, 24))
        torch.testing.assert_close(output, baseline(latent), rtol=0, atol=0)
        self.assertEqual([site.feature_delay for site in generator.film_sites], [0, 0, 0, 0])

        cc.use_cached_conv(True)
        streaming = PitchConditionedGenerator(16, 4, 16, [2, 2, 2, 1], 1, False)
        self.assertEqual([site.feature_delay for site in streaming.film_sites], [1, 3, 7, 7])
        self.assertEqual(streaming.cumulative_delay, 7)
        streamed = streaming(latent[:1], excitation[:1])
        self.assertEqual(tuple(streamed.shape), (1, 16, 24))
        self.assertTrue(torch.isfinite(streamed).all())
        cc.use_cached_conv(False)
        gin.clear_config()


if __name__ == "__main__":
    unittest.main()
