import importlib.util
import math
import unittest
from unittest import mock

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

    def test_intervention_pairwise_metric_uses_each_presets_own_outputs(self):
        import torch
        from latent_cosmos_research.pitch_intervention import run_intervention

        clips = []
        for preset, base in ((1, 0.1), (2, 0.7)):
            for note in (41, 48, 56, 63):
                clips.append(
                    {
                        "metadata": {
                            "preset_index": preset,
                            "velocity": 75,
                            "midi_note": note,
                            "expected_f0_hz": float(note),
                            "name": str(preset),
                        },
                        "audio": torch.full((1, 131_072), base),
                    }
                )
        dataset = type("Dataset", (), {"clips": clips})()

        class Model:
            def encode(self, audio):
                mean = audio[..., ::128].repeat(1, 128, 1)
                return torch.cat([mean, torch.zeros_like(mean)], dim=1)

            def decode_conditioned(self, latent, conditioning):
                value = latent[:, :1, :1] + conditioning[:, :1, :1] / 1000.0
                return value.repeat(1, 1, 131_072), torch.zeros(1)

        summary = {
            "voiced_ratio": 1.0,
            "median_f0_hz": 220.0,
            "median_abs_cents": 0.0,
            "median_voiced_probability": 1.0,
        }
        with mock.patch(
            "latent_cosmos_research.pitch_intervention._pitch_summary",
            return_value=summary,
        ), mock.patch(
            "latent_cosmos_research.pitch_intervention._harmonic_envelope",
            return_value=np.ones(16) / 4,
        ):
            result = run_intervention(Model(), dataset, torch.device("cpu"), None)
        self.assertEqual(result["summary"]["interventions"], 8)
        self.assertGreater(result["summary"]["median_pairwise_waveform_rms_difference"], 0)
        self.assertEqual(len(result["per_preset"]), 2)

    def test_disentanglement_probes_separate_pitch_and_preset_identity(self):
        from latent_cosmos_research.pitch_intervention import _disentanglement_probes

        features, notes, presets = [], [], []
        for preset in range(6):
            for note_index, note in enumerate((41, 48, 56, 63)):
                for repeat in range(4):
                    vector = np.zeros(10, dtype=np.float64)
                    vector[note_index] = 5.0
                    vector[4 + preset] = 5.0
                    vector += repeat * 1e-4
                    features.append(vector)
                    notes.append(note)
                    presets.append(preset)
        result = _disentanglement_probes(
            np.asarray(features), np.asarray(notes), np.asarray(presets)
        )
        self.assertGreater(
            result["source_pitch_leave_one_preset_out"]["balanced_accuracy"], 0.95
        )
        self.assertGreater(
            result["preset_identity_leave_one_pitch_out"]["balanced_accuracy"], 0.95
        )
