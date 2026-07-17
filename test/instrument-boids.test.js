import assert from 'node:assert/strict';
import test from 'node:test';
import { createEcosystem, resetEcosystem, setBoidsControl, setBoidsFeature, setGuideTarget, snapshotEcosystem, stepEcosystem } from '../src/instrument/boids.js';

function run(ecosystem, seconds, frame = 1 / 60) {
  for (let time = 0; time < seconds - 1e-9; time += frame) stepEcosystem(ecosystem, Math.min(frame, seconds - time));
  return ecosystem;
}

function spread(ecosystem) {
  return ecosystem.birds.reduce((sum, bird) => sum + Math.hypot(bird.x - ecosystem.centroid.x, bird.y - ecosystem.centroid.y), 0) / ecosystem.birds.length;
}

function alignment(ecosystem) {
  const headings = ecosystem.birds.map((bird) => [bird.vx / Math.hypot(bird.vx, bird.vy), bird.vy / Math.hypot(bird.vx, bird.vy)]);
  return Math.hypot(headings.reduce((sum, item) => sum + item[0], 0), headings.reduce((sum, item) => sum + item[1], 0)) / headings.length;
}

test('ecosystem contains exactly one autonomous, moving and bounded flock', () => {
  const ecosystem = run(createEcosystem({ seed: 42 }), 20);
  assert.equal(ecosystem.birds.length, 18);
  assert.ok(ecosystem.meanSpeed > 0.02);
  assert.ok(ecosystem.birds.every((bird) => bird.x >= 0 && bird.x <= 1 && bird.y >= 0 && bird.y <= 1 && bird.z >= 0 && bird.z <= 1));
  assert.ok(ecosystem.centroid.x > 0 && ecosystem.centroid.x < 1 && ecosystem.centroid.y > 0 && ecosystem.centroid.y < 1 && ecosystem.centroid.z > 0 && ecosystem.centroid.z < 1);
});

test('the three rule controls are explicit and bounded', () => {
  const ecosystem = createEcosystem();
  assert.equal(setBoidsControl(ecosystem, 'cohesion', 99), 2.5);
  assert.equal(setBoidsControl(ecosystem, 'alignment', -1), 0);
  assert.equal(setBoidsControl(ecosystem, 'separation', 1.7), 1.7);
  assert.equal(setBoidsControl(ecosystem, 'depth', 2), 1);
  assert.equal(setBoidsControl(ecosystem, 'space', 0), 0.5);
  assert.equal(setBoidsControl(ecosystem, 'neighborRadius', 0.2), false);
  assert.equal(setBoidsControl(ecosystem, 'unknown', 1), false);
  assert.equal(setBoidsFeature(ecosystem, 'separationEnabled', false), false);
  assert.equal(ecosystem.config.separationEnabled, false);
  assert.equal(setBoidsFeature(ecosystem, 'unknown', true), false);
});

test('cohesion reduces flock spread and alignment aligns headings', () => {
  const quiet = run(createEcosystem({ seed: 11, config: { cohesion: 0, alignment: 0, separation: 0, wander: 0 } }), 5);
  const cohesive = run(createEcosystem({ seed: 11, config: { cohesion: 1.4, alignment: 0, separation: 0, wander: 0 } }), 5);
  const aligned = run(createEcosystem({ seed: 11, config: { cohesion: 0, alignment: 1.8, separation: 0, wander: 0 } }), 5);
  assert.ok(spread(cohesive) < spread(quiet));
  assert.ok(alignment(aligned) > alignment(quiet));
});

test('guide bends the single flock while fixed-step replay stays deterministic', () => {
  const first = createEcosystem({ seed: 9 }); const second = createEcosystem({ seed: 9 });
  setGuideTarget(first, { x: 0.85, y: 0.2 }); setGuideTarget(second, { x: 0.85, y: 0.2 });
  run(first, 4, 1 / 60); run(second, 4, 1 / 40);
  assert.deepEqual(snapshotEcosystem(first), snapshotEcosystem(second));
  assert.ok(first.centroid.x > 0.55); assert.ok(first.centroid.y < 0.45);
});

test('manual reset utility returns every bird to the same seeded starting state', () => {
  const ecosystem = createEcosystem({ seed: 91 }); const initial = snapshotEcosystem(ecosystem);
  run(ecosystem, 8); resetEcosystem(ecosystem);
  assert.deepEqual(snapshotEcosystem(ecosystem), initial);
});
