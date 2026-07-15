import importlib.util
import math
import unittest

import numpy as np


rave_available = importlib.util.find_spec("rave") is not None


@unittest.skipUnless(rave_available, "intervention tests require the rave extra")
class PitchInterventionTest(unittest.TestCase):
    def test_pitch_summary_tracks_a_clean_sine(self):
        from latent_cosmos_research.pitch_intervention import SAMPLE_RATE, _pitch_summary

        t = np.arange(SAMPLE_RATE, dtype=np.float32) / SAMPLE_RATE
        audio = 0.1 * np.sin(2.0 * math.pi * 220.0 * t)
        result = _pitch_summary(audio, 220.0)
        self.assertGreater(result["voiced_ratio"], 0.95)
        self.assertLess(result["median_abs_cents"], 10.0)

    def test_grouped_probe_generalizes_pitch_across_presets(self):
        from latent_cosmos_research.pitch_intervention import _group_center, _ridge_probe

        notes = np.tile(np.asarray([41.0, 48.0, 56.0, 63.0]), 8)
        groups = np.repeat(np.arange(8), 4)
        features = np.stack(
            [notes, notes**2 / 100.0, np.sin(notes), np.ones_like(notes)], axis=1
        )
        result = _ridge_probe(features, notes, groups)
        self.assertLess(result["leave_one_preset_out_median_abs_cents"], 20.0)
        self.assertGreater(result["leave_one_preset_out_r2"], 0.99)
        biased = features + groups[:, None] * np.asarray([10.0, -20.0, 5.0, 1.0])
        centered_result = _ridge_probe(_group_center(biased, groups), notes, groups)
        self.assertLess(
            centered_result["leave_one_preset_out_median_abs_cents"], 20.0
        )
