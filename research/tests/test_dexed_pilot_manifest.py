import unittest

import numpy as np

from latent_cosmos_research.dexed_pilot_manifest import (
    FEATURE_NAMES,
    farthest_point_selection,
    octave_residual_cents,
    verify_pilot_manifest,
)


class DexedPilotManifestTest(unittest.TestCase):
    def test_octave_transposed_tonal_presets_have_zero_residual(self):
        self.assertAlmostEqual(octave_residual_cents(261.6255653), 0.0, places=5)
        self.assertAlmostEqual(octave_residual_cents(130.81278265), 0.0, places=5)
        self.assertAlmostEqual(octave_residual_cents(523.2511306), 0.0, places=5)

    def test_farthest_point_selection_is_deterministic_and_diverse(self):
        candidates = []
        for index, value in enumerate((-3.0, -1.0, 0.0, 1.0, 3.0)):
            item = {"preset_index": index}
            item.update({name: value if feature_index == 0 else 0.0 for feature_index, name in enumerate(FEATURE_NAMES)})
            candidates.append(item)
        selected = farthest_point_selection(candidates, 3)
        self.assertEqual([item["preset_index"] for item in selected], [2, 0, 4])

    def test_verification_requires_all_four_accurate_pitch_conditions(self):
        pilot = {
            "schema_version": "p0c-dexed-pilot-v1",
            "selection": {"selected_presets": 2, "clips": 12},
            "presets": [{"preset_index": 1}, {"preset_index": 2}],
            "clips": [
                {"preset_index": preset, "midi_note": note, "velocity": velocity}
                for preset in (1, 2)
                for note, velocity in ((41, 75), (48, 75), (56, 25), (56, 75), (56, 127), (63, 75))
            ],
        }
        records = []
        for preset in (1, 2):
            for note, velocity in ((41, 75), (48, 75), (56, 75), (63, 75)):
                records.append({
                    "dataset": "dexed",
                    "family": f"preset-{preset:06d}",
                    "midi_note": note,
                    "velocity": velocity,
                    "core_voiced_ratio": 1.0,
                    "core_median_abs_cents": 5.0 if preset == 1 else 1200.0,
                    "core_p95_abs_cents": 15.0 if preset == 1 else 1210.0,
                })
        verified = verify_pilot_manifest(pilot, {"records": records})
        self.assertEqual([item["preset_index"] for item in verified["presets"]], [1])
        self.assertEqual(len(verified["clips"]), 6)

    def test_verification_can_trim_an_overselected_pool_in_original_order(self):
        pilot = {
            "schema_version": "p0c-dexed-pilot-v1",
            "selection": {"selected_presets": 3, "clips": 12},
            "presets": [{"preset_index": value} for value in (9, 3, 7)],
            "clips": [
                {"preset_index": preset, "midi_note": note, "velocity": 75}
                for preset in (9, 3, 7)
                for note in (41, 48, 56, 63)
            ],
        }
        records = [
            {
                "dataset": "dexed",
                "family": f"preset-{preset:06d}",
                "midi_note": note,
                "velocity": 75,
                "core_voiced_ratio": 1.0,
                "core_median_abs_cents": 5.0,
                "core_p95_abs_cents": 10.0,
            }
            for preset in (9, 3, 7)
            for note in (41, 48, 56, 63)
        ]
        verified = verify_pilot_manifest(
            pilot, {"records": records}, verified_count=2
        )
        self.assertEqual([item["preset_index"] for item in verified["presets"]], [9, 3])
        self.assertEqual(
            verified["selection"]["verification"]["eligible_passed_presets"], 3
        )
        with self.assertRaisesRegex(ValueError, "only 3 presets"):
            verify_pilot_manifest(pilot, {"records": records}, verified_count=4)


if __name__ == "__main__":
    unittest.main()
