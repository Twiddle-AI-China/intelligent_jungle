"""Server-side transport and pattern scheduling for the Voice Engine.

The transport clock lives in the same process as PCM generation so note
triggers align to samples instead of a 30 Hz UI control stream. The UI scan
line only visualizes the phase reported back through telemetry.

Vocabulary mapping (organic UI term -> engine term):
    苏醒/休眠 -> playing, 生命节律 -> bpm, 节律类型 -> beats_per_bar,
    和声 -> chord, 生命周期长度 -> loop_bars.
"""

from __future__ import annotations

from dataclasses import dataclass, field


CHORD_QUALITIES: dict[str, tuple[int, ...]] = {
    "minor": (0, 3, 7),
    "major": (0, 4, 7),
    "minor7": (0, 3, 7, 10),
    "major7": (0, 4, 7, 11),
    "sus2": (0, 2, 7),
    "sus4": (0, 5, 7),
}

MAX_VOICES = 6
MAX_SLOTS = 4


@dataclass(frozen=True)
class Chord:
    root_midi: int = 57  # A2, default minor triad per PRD 和声安全
    quality: str = "minor"

    def tones(self) -> tuple[int, ...]:
        return CHORD_QUALITIES.get(self.quality, CHORD_QUALITIES["minor"])


def quantize_to_chord(midi: float, chord: Chord) -> int:
    """Snap any pitch to the nearest chord tone; ties resolve downward."""
    midi = min(127.0, max(0.0, float(midi)))
    pitch_class = (midi - chord.root_midi) % 12.0
    best_interval = min(
        chord.tones(),
        key=lambda tone: (min((pitch_class - tone) % 12.0, (tone - pitch_class) % 12.0), tone),
    )
    upward = (best_interval - pitch_class) % 12.0
    downward = (pitch_class - best_interval) % 12.0
    quantized = midi + upward if upward < downward else midi - downward
    return int(round(min(127.0, max(0.0, quantized))))


@dataclass(frozen=True)
class PatternNote:
    beat: float
    midi: int
    duration_beats: float = 0.5
    velocity: float = 0.8


@dataclass(frozen=True)
class Trigger:
    slot: int
    offset_samples: int
    midi: int
    duration_seconds: float
    velocity: float


@dataclass
class Transport:
    sample_rate: int
    bpm: float = 96.0
    beats_per_bar: int = 4
    loop_bars: int = 4
    playing: bool = False
    position_beats: float = 0.0

    @property
    def loop_beats(self) -> float:
        return float(self.beats_per_bar * self.loop_bars)

    @property
    def samples_per_beat(self) -> float:
        return self.sample_rate * 60.0 / self.bpm

    def advance(self, block_samples: int) -> tuple[float, float]:
        """Advance by one audio block; returns the [start, end) beat window."""
        start = self.position_beats
        if not self.playing:
            return start, start
        end = start + block_samples / self.samples_per_beat
        self.position_beats = end % self.loop_beats
        return start, end


class Sequencer:
    """Schedules per-voice patterns against the shared transport."""

    def __init__(self, sample_rate: int) -> None:
        self.transport = Transport(sample_rate=sample_rate)
        self.chord = Chord()
        self.patterns: dict[int, list[PatternNote]] = {}
        self._serials: dict[tuple[int, int], int] = {}
        self._slot_state: dict[int, dict[int, dict[str, float]]] = {}

    # -- state mutation -------------------------------------------------
    def set_transport(self, bpm: float | None = None, beats_per_bar: int | None = None,
                      loop_bars: int | None = None, playing: bool | None = None) -> None:
        transport = self.transport
        if bpm is not None:
            transport.bpm = float(min(220.0, max(30.0, bpm)))
        if beats_per_bar is not None:
            transport.beats_per_bar = int(min(12, max(1, beats_per_bar)))
        if loop_bars is not None:
            transport.loop_bars = int(min(16, max(1, loop_bars)))
        if playing is not None:
            transport.playing = bool(playing)
        transport.position_beats %= transport.loop_beats

    def set_chord(self, root_midi: int, quality: str) -> None:
        if quality not in CHORD_QUALITIES:
            raise ValueError(f"unknown chord quality: {quality}")
        self.chord = Chord(int(min(96, max(24, root_midi))), quality)

    def set_pattern(self, voice_id: int, notes: list[dict]) -> None:
        """An empty pattern hands the voice back to client-driven triggers."""
        if not notes:
            self.patterns.pop(voice_id, None)
            self._slot_state.pop(voice_id, None)
            return
        parsed = []
        for note in notes[: MAX_SLOTS * 8]:
            parsed.append(PatternNote(
                beat=max(0.0, float(note.get("beat", 0.0))),
                midi=int(min(127, max(0, int(note.get("midi", 60))))),
                duration_beats=min(8.0, max(0.05, float(note.get("durBeats", 0.5)))),
                velocity=min(1.0, max(0.0, float(note.get("vel", 0.8)))),
            ))
        parsed.sort(key=lambda item: item.beat)
        self.patterns[voice_id] = parsed

    def apply_message(self, payload: dict) -> bool:
        """Route one WebSocket JSON payload; returns True when consumed."""
        kind = payload.get("type")
        if kind == "transport":
            self.set_transport(payload.get("bpm"), payload.get("beatsPerBar"),
                               payload.get("loopBars"), payload.get("playing"))
            return True
        if kind == "chord":
            self.set_chord(int(payload.get("rootMidi", 57)), str(payload.get("quality", "minor")))
            return True
        if kind == "pattern":
            self.set_pattern(int(payload.get("objectId", 0)), payload.get("notes") or [])
            return True
        return False

    # -- scheduling -----------------------------------------------------
    def collect(self, block_samples: int) -> dict[int, list[Trigger]]:
        """Collect sample-accurate triggers for the next audio block."""
        transport = self.transport
        start, end = transport.advance(block_samples)
        if end <= start or not self.patterns:
            return {}
        loop_beats = transport.loop_beats
        block_beats = end - start
        seconds_per_beat = 60.0 / transport.bpm
        triggers: dict[int, list[Trigger]] = {}
        for voice_id, notes in self.patterns.items():
            fired = []
            for index, note in enumerate(notes):
                if note.beat >= loop_beats:
                    continue
                delta = (note.beat - start) % loop_beats
                if delta < block_beats:
                    slot = index % MAX_SLOTS
                    fired.append(Trigger(
                        slot=slot,
                        offset_samples=min(block_samples - 1, int(round(delta * transport.samples_per_beat))),
                        midi=quantize_to_chord(note.midi, self.chord),
                        duration_seconds=note.duration_beats * seconds_per_beat,
                        velocity=note.velocity,
                    ))
            if fired:
                triggers[voice_id] = fired
        return triggers

    def note_groups(self, voice_id: int, triggers: list[Trigger]) -> list[dict[str, float]] | None:
        """Fold triggers into persistent per-slot note groups for the decoder.

        Slots persist across blocks so envelopes keep decaying between hits.
        Returns None when the voice has no server pattern (client fallback).
        """
        if voice_id not in self.patterns:
            return None
        slots = self._slot_state.setdefault(voice_id, {})
        for stale in slots.values():
            stale.pop("offsetSamples", None)
        loop_beats = self.transport.loop_beats
        for trigger in triggers:
            key = (voice_id, trigger.slot)
            serial = self._serials.get(key, 0) + 1
            self._serials[key] = serial
            note_beat = next((n.beat for i, n in enumerate(self.patterns[voice_id]) if i % MAX_SLOTS == trigger.slot), 0.0)
            slots[trigger.slot] = {
                "id": trigger.slot,
                # Backend C (post-decoder shifter) is bounded to ±6 semitones
                # around C4; the unclipped midi rides along for backend B,
                # whose decode_pitch conditioning has no such bound.
                "midi": float(trigger.midi),
                "pitchSemitones": float(min(6.0, max(-6.0, trigger.midi - 60.0))),
                "durationSeconds": float(min(1.5, max(0.06, trigger.duration_seconds))),
                "strength": max(0.1, trigger.velocity),
                "x": (note_beat % loop_beats) / loop_beats,
                "triggerSerial": serial,
                "triggerStrength": trigger.velocity,
                "offsetSamples": trigger.offset_samples,
            }
        return [dict(slots[slot]) for slot in sorted(slots)]

    def telemetry(self) -> dict[str, float | bool]:
        transport = self.transport
        return {
            "beat": transport.position_beats,
            "loopBeats": transport.loop_beats,
            "bar": int(transport.position_beats // transport.beats_per_bar),
            "bpm": transport.bpm,
            "playing": transport.playing,
            "chordRootMidi": self.chord.root_midi,
            "chordQuality": self.chord.quality,
        }
