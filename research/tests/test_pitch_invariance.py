import importlib.util
import math
import unittest


dependencies_available = all(
    importlib.util.find_spec(name) is not None
    for name in ("torch", "rave", "librosa", "sklearn")
)


def _grid_record(preset, source, target, target_hz, observed_hz, cents, voiced=1.0):
    return {
        "preset_index": preset,
        "source_midi_note": source,
        "target_midi_note": target,
        "target_f0_hz": target_hz,
        "median_f0_hz": observed_hz,
        "median_abs_cents": cents,
        "voiced_ratio": voiced,
    }


@unittest.skipUnless(dependencies_available, "invariance tests require rave+analysis extras")
class PitchInvarianceTest(unittest.TestCase):
    def test_cell_spread_measures_pitch_range_across_sources(self):
        from latent_cosmos_research.pitch_invariance import cell_spread_cents

        self.assertAlmostEqual(cell_spread_cents([220.0, 220.0, 220.0, 220.0]), 0.0)
        self.assertAlmostEqual(cell_spread_cents([220.0, 440.0]), 1200.0)
        self.assertTrue(math.isinf(cell_spread_cents([220.0, 0.0])))
        self.assertTrue(math.isinf(cell_spread_cents([float("inf"), 220.0])))

    def test_response_slope_is_one_for_perfect_tracking_and_zero_for_constant(self):
        from latent_cosmos_research.pitch_invariance import response_slope

        targets = [110.0, 146.83, 207.65, 311.13]
        self.assertAlmostEqual(response_slope(targets, targets), 1.0, places=6)
        self.assertAlmostEqual(response_slope(targets, [207.65] * 4), 0.0, places=6)

    def test_summarize_grid_passes_only_invariant_and_controllable_models(self):
        from latent_cosmos_research.pitch_invariance import PITCH_NOTES, summarize_grid

        notes_hz = {41: 110.0, 48: 146.83, 56: 207.65, 63: 311.13}
        invariant = [
            _grid_record(1, source, target, notes_hz[target], notes_hz[target], 0.0)
            for source in PITCH_NOTES
            for target in PITCH_NOTES
        ]
        result = summarize_grid(invariant)
        self.assertEqual(result["summary"]["cells"], 4)
        self.assertEqual(result["summary"]["spread_median_cents"], 0.0)
        self.assertTrue(result["gates"]["grid_spread_passed"])
        self.assertTrue(result["gates"]["control_passed"])

        # Output follows the SOURCE latent instead of the condition: control
        # collapses (slope 0) and spread across sources explodes.
        leaky = [
            _grid_record(
                1,
                source,
                target,
                notes_hz[target],
                notes_hz[source],
                abs(1200.0 * math.log2(notes_hz[source] / notes_hz[target])),
            )
            for source in PITCH_NOTES
            for target in PITCH_NOTES
        ]
        result = summarize_grid(leaky)
        self.assertGreater(result["summary"]["spread_median_cents"], 1000.0)
        self.assertFalse(result["gates"]["grid_spread_passed"])
        self.assertFalse(result["gates"]["control_passed"])

    def test_octave_pairs_gate_only_matching_octave_groups(self):
        from latent_cosmos_research.pitch_invariance import octave_pairs

        gated, informational = octave_pairs(
            {1: 207.65, 2: 207.65, 3: 830.61}
        )
        self.assertEqual([(pair[0], pair[1]) for pair in gated], [(1, 2)])
        self.assertEqual(gated[0][2], 207.65)
        self.assertEqual(
            sorted((pair[0], pair[1]) for pair in informational), [(1, 3), (2, 3)]
        )
        for pair in informational:
            self.assertAlmostEqual(pair[2], math.sqrt(207.65 * 830.61), places=6)

    def test_summarize_paths_requires_every_gated_path_to_pass(self):
        from latent_cosmos_research.pitch_invariance import summarize_paths

        reports = [
            {"gated": True, "passed": True, "max_abs_cents": 10.0},
            {"gated": False, "passed": False, "max_abs_cents": 900.0},
        ]
        summary = summarize_paths(reports)
        self.assertTrue(summary["paths_passed"])
        self.assertEqual(summary["gated_paths"], 1)

        reports[0]["passed"] = False
        self.assertFalse(summarize_paths(reports)["paths_passed"])
        self.assertFalse(summarize_paths([])["paths_passed"])


if __name__ == "__main__":
    unittest.main()
