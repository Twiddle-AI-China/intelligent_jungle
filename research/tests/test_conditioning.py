import unittest

import numpy as np

from latent_cosmos_research.conditioning import (
    CONDITIONING_SCHEMA,
    HarmonicExcitationState,
    build_note_conditioning,
    midi_to_hz,
    validate_conditioning,
    velocity_to_loudness,
)


class PitchConditioningTest(unittest.TestCase):
    def test_midi_and_fractional_pitch_are_not_quantized(self):
        self.assertAlmostEqual(midi_to_hz(69), 440.0, places=6)
        self.assertAlmostEqual(midi_to_hz(69.5), 440.0 * 2 ** (0.5 / 12), places=6)

    def test_note_controls_have_explicit_f0_loudness_gate_and_periodicity_channels(self):
        controls = build_note_conditioning(
            [{"pitchSemitones": 9, "velocity": 0.5, "gate": False}],
            frames=4,
        )
        self.assertEqual(
            CONDITIONING_SCHEMA, "pitch-conditioning-v2:f0_hz,loudness,gate,periodicity"
        )
        self.assertEqual(controls.shape, (1, 4, 4))
        np.testing.assert_allclose(controls[0, 0], 440.0, rtol=1e-6)
        np.testing.assert_allclose(controls[0, 1], velocity_to_loudness(0.5), rtol=1e-6)
        np.testing.assert_array_equal(controls[0, 2], 0.0)
        np.testing.assert_array_equal(controls[0, 3], 1.0)

        breathy = build_note_conditioning(
            [{"pitchSemitones": 0, "velocity": 0.5, "gate": True, "periodicity": 0.25}],
            frames=2,
        )
        np.testing.assert_allclose(breathy[0, 3], 0.25, rtol=1e-6)

    def test_empty_keyboard_state_keeps_the_eternal_c4_condition(self):
        controls = build_note_conditioning([], frames=3)
        np.testing.assert_allclose(controls[0, 0], midi_to_hz(60), rtol=1e-6)
        np.testing.assert_array_equal(controls[0, 2], 1.0)

    def test_reference_excitation_tracks_target_rms_and_gate(self):
        state = HarmonicExcitationState(sample_rate=8_000)
        open_note = build_note_conditioning([{"pitchSemitones": -12, "velocity": 0.7, "gate": True}], 5)
        audio = state.render(open_note, samples_per_frame=64).reshape(5, 64)
        measured = np.sqrt(np.mean(np.square(audio), axis=1))
        np.testing.assert_allclose(measured, open_note[0, 1], rtol=0.02, atol=1e-4)

        closed_note = open_note.copy(); closed_note[:, 2] = 0
        np.testing.assert_array_equal(state.render(closed_note, 64), 0.0)

    def test_reference_excitation_preserves_phase_across_blocks(self):
        controls = build_note_conditioning([{"pitchSemitones": 0, "velocity": 0.8, "gate": True}], 2)
        continuous = HarmonicExcitationState(sample_rate=44_100)
        first = continuous.render(controls, 128)
        second = continuous.render(controls, 128)
        restarted = HarmonicExcitationState(sample_rate=44_100).render(controls, 128)
        self.assertFalse(np.allclose(second, restarted))
        self.assertGreater(np.sqrt(np.mean(np.square(np.concatenate((first, second))))), 0.01)

    def test_periodicity_blends_oscillator_against_noise_at_the_same_target_rms(self):
        pure = build_note_conditioning([{"pitchSemitones": -12, "velocity": 0.7, "gate": True}], 5)
        noisy = pure.copy(); noisy[:, 3] = 0.0

        first_run = HarmonicExcitationState(sample_rate=8_000, seed=1).render(pure, 64)
        second_run = HarmonicExcitationState(sample_rate=8_000, seed=2).render(pure, 64)
        np.testing.assert_array_equal(first_run, second_run)

        noise_a = HarmonicExcitationState(sample_rate=8_000, seed=1).render(noisy, 64)
        noise_b = HarmonicExcitationState(sample_rate=8_000, seed=2).render(noisy, 64)
        self.assertFalse(np.allclose(noise_a, noise_b))
        measured = np.sqrt(np.mean(np.square(noise_a.reshape(5, 64)), axis=1))
        np.testing.assert_allclose(measured, noisy[0, 1], rtol=0.02, atol=1e-4)

    def test_invalid_conditioning_is_rejected_at_the_model_boundary(self):
        with self.assertRaisesRegex(ValueError, "shape"):
            validate_conditioning(np.zeros((1, 3, 8), dtype=np.float32))
        invalid = np.zeros((1, 4, 8), dtype=np.float32); invalid[:, 1] = 2
        with self.assertRaisesRegex(ValueError, "loudness, gate and periodicity"):
            validate_conditioning(invalid)


if __name__ == "__main__":
    unittest.main()
