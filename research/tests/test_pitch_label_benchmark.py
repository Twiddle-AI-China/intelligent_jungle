import importlib.util
import unittest

import numpy as np

from latent_cosmos_research.pitch_label_benchmark import (
    build_synthetic_suite,
    evaluate_cases,
    evaluate_pyin_cases,
    summarize_predictions,
)


rave_available = importlib.util.find_spec("torch") is not None and importlib.util.find_spec("rave") is not None
analysis_available = importlib.util.find_spec("librosa") is not None


class PitchLabelMetricsTest(unittest.TestCase):
    def test_summary_reports_cents_octaves_voicing_and_gate(self):
        true_f0 = np.asarray([[100.0, 100.0, 0.0, 0.0]])
        predicted_f0 = np.asarray([[100.0, 200.0, 80.0, 0.0]])
        true_gate = np.asarray([[1.0, 1.0, 1.0, 0.0]])
        predicted_gate = np.asarray([[1.0, 1.0, 0.0, 0.0]])
        result = summarize_predictions(true_f0, true_gate, predicted_f0, predicted_gate)

        self.assertEqual(result["frames"], 4)
        self.assertAlmostEqual(result["median_abs_cents"], 600.0)
        self.assertAlmostEqual(result["gross_pitch_error_ratio"], 0.5)
        self.assertAlmostEqual(result["octave_error_ratio"], 0.5)
        self.assertAlmostEqual(result["unvoiced_false_positive_ratio"], 0.5)
        self.assertAlmostEqual(result["gate_error_ratio"], 0.25)

    def test_synthetic_suite_contains_timbre_noise_and_transition_truth(self):
        cases = build_synthetic_suite(
            frames=64, midi_notes=(45,), target_rms_values=(0.04,), profiles=("sine", "saw")
        )
        categories = {case.category for case in cases}
        self.assertIn("voiced/sine", categories)
        self.assertIn("voiced/saw", categories)
        self.assertIn("unvoiced/silence", categories)
        self.assertIn("unvoiced/noise-white", categories)
        self.assertIn("transition/voiced-silence", categories)
        for case in cases:
            self.assertEqual(case.waveform.shape, (64 * 128,))
            self.assertEqual(case.true_f0_hz.shape, (64,))
            self.assertEqual(case.true_gate.shape, (64,))


@unittest.skipUnless(rave_available, "pitch label integration test requires the rave extra")
class PitchLabelBenchmarkIntegrationTest(unittest.TestCase):
    def test_exact_training_extractor_produces_versioned_report(self):
        cases = build_synthetic_suite(
            frames=64, midi_notes=(45,), target_rms_values=(0.12,), profiles=("sine",)
        )
        report = evaluate_cases(cases, batch_size=4)

        self.assertEqual(report["estimator"]["algorithm"], "NCCF + median smoothing")
        self.assertGreater(report["aggregate"]["pitch_compared_frames"], 0)
        self.assertIn(report["decision"], {
            "provisionally_accept_nccf_pending_real_corpus_audit",
            "keep_nccf_pitch_candidate_but_add_separate_voicing_estimator",
            "replace_or_reconfigure_nccf_before_long_training",
        })

    @unittest.skipUnless(analysis_available, "pYIN comparison requires the analysis extra")
    def test_pyin_candidate_uses_the_same_versioned_metrics(self):
        cases = build_synthetic_suite(
            frames=64, midi_notes=(45,), target_rms_values=(0.12,), profiles=("sine",)
        )
        report = evaluate_pyin_cases(cases)
        self.assertEqual(report["estimator"]["algorithm"], "probabilistic YIN")
        self.assertGreater(report["aggregate"]["pitch_compared_frames"], 0)
        self.assertIn("by_midi_note", report)


if __name__ == "__main__":
    unittest.main()
