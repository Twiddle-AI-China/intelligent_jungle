import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorsForPattern, bandForChord, chordTones, DEFAULT_BUDGET, defaultPattern, midiToY, PITCH_AXIS, patternsEqual, performPattern, quantizeToChord, ROLE_BANDS, yToMidiDrift } from '../src/score.js';

const A_MINOR = { rootMidi: 57, quality: 'minor' };

test('chord tones enumerate only chord pitches inside the band', () => {
  const tones = chordTones(A_MINOR, 54, 66);
  assert.deepEqual(tones, [57, 60, 64]);
});

test('quantize matches the server rule: nearest tone, ties resolve downward', () => {
  assert.equal(quantizeToChord(60, A_MINOR), 60);
  assert.equal(quantizeToChord(58, A_MINOR), 57);
  assert.equal(quantizeToChord(62, A_MINOR), 60);
  assert.equal(quantizeToChord(66, A_MINOR), 64);
});

test('default patterns stay inside the role band and on chord tones', () => {
  for (const role of Object.keys(ROLE_BANDS)) {
    const band = bandForChord(A_MINOR, role);
    const pattern = defaultPattern(role, A_MINOR, 16);
    assert.ok(pattern.length > 0);
    for (const note of pattern) {
      assert.ok(note.beat >= 0 && note.beat < 16);
      assert.ok(note.midi >= band.loMidi && note.midi <= band.hiMidi);
      assert.equal(quantizeToChord(note.midi, A_MINOR), note.midi);
    }
  }
  // 音域带是相对根音的偏移：换根音（C→D）整个带与默认乐句跟着移调，
  // pitch class 相对根音不变（和声安全，PRD §4）。
  const C_MINOR = { rootMidi: 48, quality: 'minor' };
  const D_MINOR = { rootMidi: 50, quality: 'minor' };
  assert.deepEqual(bandForChord(C_MINOR, 'bass'), { loMidi: 36, hiMidi: 41 });
  assert.deepEqual(bandForChord(D_MINOR, 'bass'), { loMidi: 38, hiMidi: 43 });
  for (const role of Object.keys(ROLE_BANDS)) {
    const onC = defaultPattern(role, C_MINOR, 16).map((note) => note.midi);
    const onD = defaultPattern(role, D_MINOR, 16).map((note) => note.midi);
    assert.deepEqual(onD, onC.map((midi) => midi + 2), `${role} pattern transposes with the chord root`);
  }
});

test('anchors map beats to x and pitch to y', () => {
  const anchors = anchorsForPattern([{ beat: 4, midi: 60, durBeats: 1, vel: 0.8 }], 16);
  assert.equal(anchors[0].x, 0.25);
  assert.equal(anchors[0].y, midiToY(60));
});

test('zero drift performs the pattern verbatim', () => {
  const pattern = defaultPattern('bass', A_MINOR, 16);
  const anchors = anchorsForPattern(pattern, 16);
  const performed = performPattern(anchors, anchors.map(() => ({ dx: 0, dy: 0 })), A_MINOR, 16);
  assert.ok(patternsEqual(performed, pattern));
});

test('horizontal drift becomes swing bounded by the budget', () => {
  const anchors = anchorsForPattern([{ beat: 4, midi: 60, durBeats: 1, vel: 0.8 }], 16);
  const nudged = performPattern(anchors, [{ dx: 0.003, dy: 0 }], A_MINOR, 16);
  assert.ok(Math.abs(nudged[0].beat - 4.048) < 1e-6);
  const extreme = performPattern(anchors, [{ dx: 0.4, dy: 0 }], A_MINOR, 16);
  assert.equal(extreme[0].beat, 4 + DEFAULT_BUDGET.swingBeats);
  assert.equal(extreme[0].midi, 60);
});

test('vertical drift borrows the adjacent chord tone in that direction', () => {
  // yToMidiDrift 的 dy 约定「向上为正」并直接映射：向上漂移 → 音升高（y 减小 → pitch 升高）。
  assert.ok(yToMidiDrift(0.05) > 0, 'up-positive drift raises pitch');
  assert.ok(yToMidiDrift(-0.05) < 0, 'down-positive drift lowers pitch');
  assert.equal(yToMidiDrift(1), PITCH_AXIS.hiMidi - PITCH_AXIS.loMidi);
  const anchors = anchorsForPattern([{ beat: 0, midi: 60, durBeats: 1, vel: 0.8 }], 16);
  const upward = performPattern(anchors, [{ dx: 0, dy: -0.05 }], A_MINOR, 16);
  assert.equal(upward[0].midi, 64);
  const downward = performPattern(anchors, [{ dx: 0, dy: 0.05 }], A_MINOR, 16);
  assert.equal(downward[0].midi, 57);
  const tiny = performPattern(anchors, [{ dx: 0, dy: -0.01 }], A_MINOR, 16);
  assert.equal(tiny[0].midi, 60);
});
