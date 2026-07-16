import importlib.util
import unittest


dependencies_available = all(
    importlib.util.find_spec(name) is not None
    for name in ("torch", "rave", "librosa", "sklearn")
)


def _record(
    onset_error=0,
    correct=True,
    periodicity_delta=0.05,
    correlation=0.95,
):
    return {
        "onset_frame_error": onset_error,
        "spectral_correct": correct,
        "periodicity_abs_delta": periodicity_delta,
        "envelope_correlation": correlation,
    }


@unittest.skipUnless(dependencies_available, "inharmonic eval tests require rave+analysis extras")
class PitchInharmonicEvalTest(unittest.TestCase):
    def test_onset_frame_finds_the_first_energetic_frame(self):
        import numpy as np
        from latent_cosmos_research.pitch_inharmonic_eval import frame_rms, onset_frame

        audio = np.zeros(128 * 10, dtype=np.float32)
        audio[128 * 4 :] = 0.5
        self.assertEqual(onset_frame(frame_rms(audio)), 4)
        self.assertEqual(onset_frame(frame_rms(np.zeros(1280, dtype=np.float32))), 10)

    def test_envelope_correlation_tracks_shared_decay_shape(self):
        import numpy as np
        from latent_cosmos_research.pitch_inharmonic_eval import envelope_correlation

        decay = np.repeat(np.geomspace(0.5, 0.01, 32), 128).astype(np.float32)
        rise = decay[::-1].copy()
        self.assertGreater(envelope_correlation(decay, decay * 0.5), 0.99)
        self.assertLess(envelope_correlation(decay, rise), 0.0)

    def test_spectral_identification_separates_notes_by_mel_distance(self):
        import numpy as np
        from latent_cosmos_research.pitch_inharmonic_eval import log_mel, mel_distance

        t = np.arange(44_100, dtype=np.float32) / 44_100.0
        low = np.sin(2 * np.pi * 110.0 * t).astype(np.float32)
        high = np.sin(2 * np.pi * 311.0 * t).astype(np.float32)
        self.assertLess(
            mel_distance(log_mel(low), log_mel(low * 0.8)),
            mel_distance(log_mel(low), log_mel(high)),
        )

    def test_summarize_preset_applies_every_registered_gate(self):
        from latent_cosmos_research.pitch_inharmonic_eval import GATES, summarize_preset

        passing = summarize_preset([_record() for _ in range(4)])
        self.assertTrue(passing["passed"])
        self.assertTrue(all(passing["gates"].values()))

        late = summarize_preset(
            [_record(onset_error=GATES["onset_max_frame_error"] + 1)] + [_record()] * 3
        )
        self.assertFalse(late["gates"]["onset_passed"])
        self.assertFalse(late["passed"])

        confused = summarize_preset([_record(correct=False)] * 2 + [_record()] * 2)
        self.assertFalse(confused["gates"]["spectral_id_passed"])

        hallucinated = summarize_preset(
            [_record(periodicity_delta=GATES["periodicity_max_abs_delta"] + 0.05)]
            + [_record()] * 3
        )
        self.assertFalse(hallucinated["gates"]["periodicity_passed"])

        flat = summarize_preset([_record(correlation=0.2)] * 4)
        self.assertFalse(flat["gates"]["envelope_passed"])
        self.assertFalse(summarize_preset([])["passed"])


if __name__ == "__main__":
    unittest.main()
