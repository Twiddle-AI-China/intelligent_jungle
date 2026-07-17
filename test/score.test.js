import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorsForPattern, chordTones, DEFAULT_BUDGET, defaultPattern, midiToY, patternsEqual, performPattern, quantizeToChord, ROLE_BANDS } from '../src/score.js';
import { createWorld, setFlockAnchors, stepWorld } from '../src/world.js';

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
    const pattern = defaultPattern(role, A_MINOR, 16);
    assert.ok(pattern.length > 0);
    for (const note of pattern) {
      assert.ok(note.beat >= 0 && note.beat < 16);
      assert.ok(note.midi >= ROLE_BANDS[role].loMidi && note.midi <= ROLE_BANDS[role].hiMidi);
      assert.equal(quantizeToChord(note.midi, A_MINOR), note.midi);
    }
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
  const anchors = anchorsForPattern([{ beat: 0, midi: 60, durBeats: 1, vel: 0.8 }], 16);
  const upward = performPattern(anchors, [{ dx: 0, dy: -0.05 }], A_MINOR, 16);
  assert.equal(upward[0].midi, 64);
  const downward = performPattern(anchors, [{ dx: 0, dy: 0.05 }], A_MINOR, 16);
  assert.equal(downward[0].midi, 57);
  const tiny = performPattern(anchors, [{ dx: 0, dy: -0.01 }], A_MINOR, 16);
  assert.equal(tiny[0].midi, 60);
});

test('anchored flocks contract around their pattern anchors', () => {
  const free = createWorld({ seed: 11 });
  const anchored = createWorld({ seed: 11 });
  anchored.config.anchorStiffness = 2.4;
  const anchor = { x: 0.3, y: 0.4 };
  for (const voice of anchored.objects) setFlockAnchors(anchored, voice.id, [anchor]);
  for (let i = 0; i < 600; i += 1) { stepWorld(free, 1 / 60); stepWorld(anchored, 1 / 60); }
  const wrapped = (target, source) => ((target - source + 1.5) % 1) - 0.5;
  const meanDistance = (world) => world.boids.reduce((sum, boid) => sum + Math.hypot(wrapped(boid.x, anchor.x), wrapped(boid.y, anchor.y)), 0) / world.boids.length;
  assert.ok(meanDistance(anchored) < 0.12, `anchored flocks stay near the anchor, got ${meanDistance(anchored)}`);
  assert.ok(meanDistance(anchored) < meanDistance(free) * 0.6, 'anchored world is markedly tighter than the free world');
  for (const boid of anchored.boids) assert.ok(Math.hypot(boid.vx, boid.vy) > 0.01, 'birds keep moving — alive, not frozen');
});
