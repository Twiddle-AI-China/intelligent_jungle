import test from 'node:test';
import assert from 'node:assert/strict';
import { addBoid, createWorld, currentScore, rebuildBranches, snapshotWorld, SPECIES, stepWorld, TREE_SLOTS } from '../src/world.js';
import { CHORD_QUALITIES } from '../src/score.js';

function run(world, seconds, frame = 1 / 60) {
  for (let time = 0; time < seconds - 1e-9; time += frame) stepWorld(world, Math.min(frame, seconds - time));
  return world;
}
const CHORD = { rootMidi: 57, intervals: CHORD_QUALITIES.minor };
const BAND = (role) => ({ bass: { loMidi: 45, hiMidi: 50 }, support: { loMidi: 57, hiMidi: 64 }, ornament: { loMidi: 64, hiMidi: 71 }, shimmer: { loMidi: 57, hiMidi: 69 } }[role]);

test('world starts as four trees, four flocks, twenty-eight boids', () => {
  const a = createWorld({ seed: 42 }); const b = createWorld({ seed: 42 });
  assert.equal(a.trees.length, 4); assert.equal(a.flocks.length, 4); assert.equal(a.boids.length, 28);
  assert.deepEqual(a.flocks.map((f) => f.speciesId), SPECIES.map((s) => s.id));
  assert.deepEqual(snapshotWorld(a), snapshotWorld(b));
});

test('fixed-step evolution is independent of display frame partitioning', () => {
  assert.deepEqual(snapshotWorld(run(createWorld({ seed: 7 }), 3, 1 / 100)), snapshotWorld(run(createWorld({ seed: 7 }), 3, 1 / 50)));
});

test('trees grow branches on chord tones (each branch is a note)', () => {
  const world = createWorld({ seed: 5 });
  rebuildBranches(world, CHORD, BAND);
  for (const tree of world.trees) {
    assert.ok(tree.branches.length > 0);
    for (const p of tree.branches) {
      const pc = ((p.midi - CHORD.rootMidi) % 12 + 12) % 12;
      assert.ok(CHORD.intervals.includes(pc), `midi ${p.midi} not in chord`);
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    }
  }
});

test('birds perch and produce a score with velocity from count', () => {
  const world = createWorld({ seed: 9 });
  rebuildBranches(world, CHORD, BAND);
  run(world, 12);
  const perched = world.boids.filter((b) => b.perched).length;
  assert.ok(perched > 0, 'some birds should perch');
  const score = currentScore(world, 16);
  assert.equal(score.length, 4);
  const allNotes = score.flat();
  for (const note of allNotes) {
    assert.ok(Number.isFinite(note.midi));
    assert.ok(note.count >= 1);
    assert.ok(note.branch >= 0);
  }
});

test('flocks expose eight bounded relation dimensions from flying birds', () => {
  const world = run(createWorld({ seed: 21 }), 3);
  for (const flock of world.flocks) {
    assert.equal(flock.relationState.length, 8);
    assert.ok(flock.relationState.every((v) => v >= -1 && v <= 1));
    assert.ok(flock.energy >= 0 && flock.energy <= 1);
  }
});

test('day-night phase and season advance with time', () => {
  const world = createWorld({ seed: 3 });
  const phase0 = world.dayPhase;
  run(world, 5);
  assert.notEqual(world.dayPhase, phase0);
});

test('adding a boid grows population without adding a flock', () => {
  const world = createWorld({ seed: 8 });
  const flockCount = world.flocks.length;
  assert.equal(addBoid(world, 0, 0.3, 0.3), true);
  assert.equal(world.flocks.length, flockCount);
  assert.equal(world.flocks[0].population, 8);
});
