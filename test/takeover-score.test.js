import test from 'node:test';
import assert from 'node:assert/strict';
import { bandForChord, BEAT_GRID, moveNote, quantizeBeat, quantizeRecording, shiftPattern } from '../src/score.js';
import { LiveInstrumentSession } from '../src/instrument/live-session.js';

const A_MINOR = { rootMidi: 57, quality: 'minor' };
const BAND = bandForChord(A_MINOR, 'support');

test('shiftPattern snaps time to the step grid and keeps pitches on chord tones in band', () => {
  const base = [{ beat: 0, midi: 60, durBeats: 1, vel: 0.8 }, { beat: 4, midi: 64, durBeats: 1, vel: 0.8 }];
  const shifted = shiftPattern(base, 1.1, 3.4, A_MINOR, BAND, 16);
  assert.equal(shifted[0].beat, 1, 'beat offset snapped to 0.25 grid');
  for (const note of shifted) {
    assert.ok(note.midi >= BAND.loMidi && note.midi <= BAND.hiMidi);
    assert.ok([57, 60, 64].includes(note.midi), 'chord-safe after transpose');
  }
  assert.equal(shifted[1].beat, 5);
});

test('shiftPattern wraps beats around the loop', () => {
  const base = [{ beat: 15.5, midi: 60, durBeats: 0.5, vel: 0.8 }];
  const shifted = shiftPattern(base, 1, 0, A_MINOR, BAND, 16);
  assert.equal(shifted[0].beat, 0.5);
});

test('moveNote only touches the indexed note', () => {
  const base = [{ beat: 0, midi: 60, durBeats: 1, vel: 0.8 }, { beat: 8, midi: 64, durBeats: 1, vel: 0.8 }];
  const moved = moveNote(base, 1, 9.13, 62.7, A_MINOR, BAND, 16);
  assert.deepEqual(moved[0], base[0]);
  assert.equal(moved[1].beat, 9.25);
  assert.ok([57, 60, 64].includes(moved[1].midi));
});

test('quantizeBeat snaps and wraps', () => {
  assert.equal(quantizeBeat(3.9, 16), 4);
  assert.equal(quantizeBeat(16.1, 16), 0.25 * Math.round(0.1 / 0.25));
  assert.equal(quantizeBeat(-0.1, 16), 0);
});

test('quantizeRecording keeps played pitch, snaps rhythm, drops beat-less events', () => {
  const notes = quantizeRecording([
    { beat: 0.13, midi: 60, durBeats: 0.9, vel: 0.9 },
    { beat: 4.2, midi: 64, durBeats: 0.02, vel: 0.4 },
    { beat: NaN, midi: 60, durBeats: 1, vel: 0.5 },
  ], 16);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((note) => note.beat), [0.25, 4.25]);
  assert.deepEqual(notes.map((note) => note.midi), [60, 64]);
  assert.ok(notes.every((note) => note.durBeats >= BEAT_GRID));
});

test('live session quantizes pitch to the chord at noteOn and records loop-relative beats', () => {
  const session = new LiveInstrumentSession({ flockId: 1, chord: A_MINOR, loopBeats: 16 });
  const sounded = session.noteOn('kb-KeyW', 61, 0.9, 2.05); // C♯4 → 和弦内音
  assert.ok([57, 60, 64].includes(sounded));
  assert.equal(session.controlOverride().noteGroups.length, 1);
  assert.equal(session.controlOverride().pitchSemitones, sounded - 60);
  session.noteOff('kb-KeyW', 2.85);
  const { notes } = session.takeRecording(quantizeRecording);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].beat, 2);
  assert.equal(notes[0].midi, sounded, '回放音高与演奏一致（G5）');
  assert.ok(Math.abs(notes[0].durBeats - 0.75) < 1e-9);
  assert.equal(session.recording.length, 0, 'take clears the ring');
});

test('live session ring dedupes cells and survives missing transport', () => {
  const session = new LiveInstrumentSession({ flockId: 0, chord: A_MINOR });
  session.noteOn('a', 60, 0.5, NaN);
  session.noteOff('a', NaN);
  assert.equal(session.recording.length, 0, 'no transport → nothing recorded, no crash');
  session.noteOn('a', 60, 0.5, 0.1); session.noteOff('a', 0.6);
  session.noteOn('b', 60, 0.9, 0.12); session.noteOff('b', 0.7);
  const { notes } = session.takeRecording(quantizeRecording);
  assert.equal(notes.length, 1, 'same cell keeps the later take');
  assert.equal(notes[0].vel, 0.9);
});

test('trigger serial advances per noteOn so the decoder re-fires', () => {
  const session = new LiveInstrumentSession({ flockId: 0, chord: A_MINOR });
  session.noteOn('a', 60, 0.8, 0);
  const first = session.controlOverride().triggerSerial;
  session.noteOff('a', 0.5);
  session.noteOn('a', 64, 0.8, 1);
  assert.equal(session.controlOverride().triggerSerial, first + 1);
});

test('takeRecording returns the relation trajectory mean as the timbre basis', () => {
  const session = new LiveInstrumentSession({ flockId: 2, chord: A_MINOR, loopBeats: 16 });
  assert.equal(session.takeRecording(quantizeRecording).timbreBasis, null, 'no motion accumulated → no basis');
  for (let frame = 0; frame < 200; frame += 1) session.step(1 / 60);
  assert.equal(session.relationHistory.length, 128, 'history ring caps at 128 frames');
  assert.ok(session.relationHistory.every((frame) => frame.length === 8), 'each frame is an 8D copy');
  session.noteOn('a', 60, 0.8, 0); session.noteOff('a', 0.5);
  const { notes, timbreBasis } = session.takeRecording(quantizeRecording);
  assert.equal(notes.length, 1);
  assert.equal(timbreBasis.length, 8);
  for (let dimension = 0; dimension < 8; dimension += 1) {
    const expected = session.relationHistory.reduce((sum, frame) => sum + frame[dimension], 0) / session.relationHistory.length;
    assert.ok(Math.abs(timbreBasis[dimension] - expected) < 1e-12, `dimension ${dimension} is the trajectory mean`);
  }
  const stored = session.relationHistory.at(-1).slice();
  session.ecosystem.relationState[0] = 99;
  assert.equal(session.relationHistory.at(-1)[0], stored[0], 'history stores copies, not live references');
});
