import json
import tempfile
import unittest
from pathlib import Path

from latent_cosmos_research.real_pitch_audit import (
    LabeledSample,
    note_name_to_midi,
    parse_nsynth_path,
    parse_tinysol_path,
    stratified_sample,
    discover_samples,
)


class RealPitchAuditTest(unittest.TestCase):
    def test_nsynth_filename_is_note_truth(self):
        parsed = parse_nsynth_path(Path("guitar_acoustic_014-060-100.wav"))
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.dataset, "nsynth")
        self.assertEqual(parsed.family, "guitar")
        self.assertEqual(parsed.midi_note, 60)
        self.assertEqual(parsed.velocity, 100)

    def test_tinysol_note_names_support_sharps_and_flats(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sharp = root / "Keyboards" / "Accordion" / "ordinario" / "Acc-ord-A#2-ff.wav"
            flat = root / "Winds" / "Flute" / "ordinario" / "Fl-ord-Eb4-mf.wav"
            self.assertEqual(parse_tinysol_path(sharp, root).midi_note, 46)
            self.assertEqual(parse_tinysol_path(flat, root).midi_note, 63)
        self.assertEqual(note_name_to_midi("C", 4), 60)

    def test_selection_is_deterministic_and_preserves_sources(self):
        samples = [
            LabeledSample(
                path=f"/{dataset}/{family}/{note}-{index}.wav",
                dataset=dataset,
                family=family,
                instrument=family,
                midi_note=note,
                velocity=100,
            )
            for dataset in ("nsynth", "tinysol")
            for family in ("guitar", "reed")
            for note in (48, 60, 72)
            for index in range(3)
        ]
        first = stratified_sample(samples, 5, seed=9)
        second = stratified_sample(samples, 5, seed=9)
        self.assertEqual(first, second)
        self.assertEqual(sum(sample.dataset == "nsynth" for sample in first), 5)
        self.assertEqual(sum(sample.dataset == "tinysol" for sample in first), 5)
        self.assertEqual(
            {sample.family for sample in first if sample.dataset == "nsynth"},
            {"guitar", "reed"},
        )

    def test_dexed_pilot_preserves_acoustic_f0_after_octave_offset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pilot = {
                "selection": {"source_root": str(root)},
                "presets": [{"preset_index": 7, "category": "pad"}],
                "clips": [{
                    "preset_index": 7,
                    "name": "Octave Pad",
                    "source_wav": "000007/note060.wav",
                    "midi_note": 60,
                    "velocity": 75,
                    "expected_f0_hz": 523.251,
                }],
            }
            path = root / "pilot.json"
            path.write_text(json.dumps(pilot), encoding="utf-8")
            samples = discover_samples(dexed_pilot=path)
            self.assertEqual(samples[0].family, "preset-000007")
            self.assertAlmostEqual(samples[0].expected_f0_hz, 523.251)


if __name__ == "__main__":
    unittest.main()
