import unittest

from latent_cosmos_research.sequencer import Chord, Sequencer, quantize_to_chord


class ChordQuantizeTest(unittest.TestCase):
    def test_chord_tones_pass_through(self):
        chord = Chord(57, "minor")  # A minor: A C E
        for midi in (57, 60, 64, 69, 72):
            self.assertEqual(quantize_to_chord(midi, chord), midi)

    def test_non_chord_tones_snap_to_nearest_tone(self):
        chord = Chord(57, "minor")
        self.assertEqual(quantize_to_chord(58, chord), 57)
        self.assertEqual(quantize_to_chord(63, chord), 64)
        self.assertEqual(quantize_to_chord(66, chord), 64)

    def test_tie_resolves_downward(self):
        chord = Chord(57, "minor")
        # D (62) is two semitones from both C (60) and E (64).
        self.assertEqual(quantize_to_chord(62, chord), 60)


class TransportTest(unittest.TestCase):
    def test_paused_transport_does_not_advance(self):
        sequencer = Sequencer(44_100)
        start, end = sequencer.transport.advance(2048)
        self.assertEqual(start, end)

    def test_position_wraps_at_loop_end(self):
        sequencer = Sequencer(44_100)
        sequencer.set_transport(bpm=120, beats_per_bar=4, loop_bars=1, playing=True)
        samples_per_loop = int(4 * 44_100 * 60 / 120)
        sequencer.transport.advance(samples_per_loop + 100)
        self.assertLess(sequencer.transport.position_beats, 4.0)
        self.assertGreater(sequencer.transport.position_beats, 0.0)


class SchedulingTest(unittest.TestCase):
    def make_sequencer(self):
        sequencer = Sequencer(44_100)
        sequencer.set_transport(bpm=120, beats_per_bar=4, loop_bars=1, playing=True)
        sequencer.set_pattern(3, [{"beat": 1.0, "midi": 60, "durBeats": 0.5, "vel": 0.9}])
        return sequencer

    def test_trigger_fires_with_sample_accurate_offset(self):
        sequencer = self.make_sequencer()
        block = 2048
        samples_per_beat = 44_100 * 60 / 120  # 22050
        fired = []
        for index in range(64):
            triggers = sequencer.collect(block)
            if 3 in triggers:
                fired.append((index, triggers[3][0]))
        self.assertGreaterEqual(len(fired), 2)  # loops at least twice
        index, trigger = fired[0]
        absolute = index * block + trigger.offset_samples
        self.assertAlmostEqual(absolute, samples_per_beat, delta=1.0)
        self.assertEqual(trigger.midi, 60)  # chord tone of default A minor
        self.assertAlmostEqual(trigger.duration_seconds, 0.25, places=6)
        # second loop lands exactly one loop later
        index2, trigger2 = fired[1]
        absolute2 = index2 * block + trigger2.offset_samples
        self.assertAlmostEqual(absolute2 - absolute, 4 * samples_per_beat, delta=1.0)

    def test_trigger_pitch_is_quantized_to_master_chord(self):
        sequencer = self.make_sequencer()
        sequencer.set_pattern(3, [{"beat": 0.0, "midi": 61, "durBeats": 0.5, "vel": 0.9}])
        triggers = sequencer.collect(2048)
        self.assertEqual(triggers[3][0].midi, 60)

    def test_note_groups_persist_between_triggers(self):
        sequencer = self.make_sequencer()
        block = 2048
        seen_offset_blocks = 0
        groups_when_quiet = None
        for _ in range(16):
            triggers = sequencer.collect(block)
            groups = sequencer.note_groups(3, triggers.get(3, []))
            self.assertIsNotNone(groups)
            if triggers.get(3):
                seen_offset_blocks += 1
                self.assertIn("offsetSamples", groups[0])
            elif groups:
                groups_when_quiet = groups
                self.assertNotIn("offsetSamples", groups[0])
        self.assertEqual(seen_offset_blocks, 1)
        self.assertIsNotNone(groups_when_quiet)
        self.assertEqual(groups_when_quiet[0]["triggerSerial"], 1)

    def test_empty_pattern_returns_voice_to_client_control(self):
        sequencer = self.make_sequencer()
        sequencer.apply_message({"type": "pattern", "objectId": 3, "notes": []})
        self.assertIsNone(sequencer.note_groups(3, []))

    def test_apply_message_routes_transport_chord_pattern(self):
        sequencer = Sequencer(44_100)
        self.assertTrue(sequencer.apply_message({"type": "transport", "bpm": 90, "playing": True}))
        self.assertTrue(sequencer.apply_message({"type": "chord", "rootMidi": 60, "quality": "major"}))
        self.assertTrue(sequencer.apply_message({"type": "pattern", "objectId": 1, "notes": [{"beat": 0, "midi": 64}]}))
        self.assertFalse(sequencer.apply_message({"type": "nonsense"}))
        self.assertEqual(sequencer.transport.bpm, 90)
        self.assertEqual(sequencer.chord.quality, "major")
        triggers = sequencer.collect(2048)
        self.assertEqual(triggers[1][0].midi, 64)  # E is a C major chord tone


if __name__ == "__main__":
    unittest.main()
