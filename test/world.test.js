import test from 'node:test';
import assert from 'node:assert/strict';
import { addBoid, addFlock, addObstacle, createWorld, eraseAt, injectEnergy, measureWorld, setHarmonicCenter, setInteraction, snapshotWorld, SPECIES, stepWorld } from '../src/world.js';
import { replaySession, SessionRecorder } from '../src/session.js';

function run(world, seconds, frame = 1 / 60) {
  for (let time = 0; time < seconds - 1e-9; time += frame) stepWorld(world, Math.min(frame, seconds - time));
  return world;
}

test('world starts as three species, three voices and twenty-one boids', () => {
  const a = createWorld({ seed: 42 }); const b = createWorld({ seed: 42 });
  assert.equal(a.objects.length, 3); assert.equal(a.boids.length, 21); assert.equal(a.obstacles.length, 0);
  assert.deepEqual(a.objects.map((voice) => voice.speciesId), SPECIES.map((species) => species.id));
  assert.deepEqual(snapshotWorld(a), snapshotWorld(b));
});

test('fixed-step evolution is independent of display frame partitioning', () => {
  assert.deepEqual(snapshotWorld(run(createWorld({ seed: 7 }), 4, 1 / 100)), snapshotWorld(run(createWorld({ seed: 7 }), 4, 1 / 50)));
});

test('autonomous flock remains finite, moving and bounded', () => {
  const world = run(createWorld({ seed: 7 }), 60, 1 / 120);
  for (const boid of world.boids) {
    assert.ok(Number.isFinite(boid.x) && boid.x >= 0 && boid.x < 1 && boid.y >= 0 && boid.y < 1);
    assert.ok(Math.hypot(boid.vx, boid.vy) > 0.01);
  }
  for (const voice of world.objects) assert.ok(voice.perceptualPosition.every((value) => value >= 0.04 && value <= 0.96));
});

test('adding a boid changes flock population and density control without adding a voice', () => {
  const world = createWorld({ seed: 8 }); const voiceCount = world.objects.length; const beforeDensity = world.objects[0].perceptualPosition[5];
  assert.equal(addBoid(world, world.objects[0].id, 0.4, 0.4), true); run(world, 3);
  assert.equal(world.objects.length, voiceCount); assert.equal(world.objects[0].population, 8);
  assert.ok(world.objects[0].perceptualPosition[5] > beforeDensity);
});

test('obstacle creates measurable turn pressure in the perceptual control state', () => {
  const world = createWorld({ seed: 10 }); const bird = world.boids[0];
  addObstacle(world, bird.x, bird.y, 0.08); run(world, 0.2);
  assert.ok(world.boids.some((candidate) => candidate.obstaclePressure > 0));
  assert.ok(world.objects.some((voice) => voice.obstaclePressure > 0));
});

test('guide gesture bends nearby boids in its direction', () => {
  const world = createWorld({ seed: 42 }); const center = world.objects[0].centroid;
  setInteraction(world, { mode: 'guide', x: center.x, y: center.y, dx: 0.8, dy: 0, strength: 1 }); run(world, 0.25);
  assert.ok(world.boids.filter((boid) => boid.flockId === 0).reduce((sum, boid) => sum + boid.vx, 0) > 0.25);
  assert.ok(world.objects[0].latentPosition[2] > 0.65);
});

test('flock position and velocity directly define the four decoder latent controls', () => {
  const world = createWorld({ seed: 13 }); const voice = world.objects[0];
  assert.equal(voice.latentPosition.length, 4);
  assert.ok(Math.abs(voice.latentPosition[0] - voice.centroid.x) < 1e-9);
  assert.ok(Math.abs(voice.latentPosition[1] - voice.centroid.y) < 1e-9);
  setInteraction(world, { mode: 'guide', x: voice.centroid.x, y: voice.centroid.y, dx: -0.8, dy: 0.4, strength: 1 }); run(world, 0.3);
  assert.ok(world.objects[0].latentPosition[2] < 0.45);
  assert.ok(world.objects[0].latentPosition[3] > 0.55);
});

test('eraser removes obstacles first and never deletes the last two birds of a flock', () => {
  const world = createWorld({ seed: 9 }); addObstacle(world, 0.5, 0.5, 0.08);
  assert.equal(eraseAt(world, 0.5, 0.5), 'obstacle'); assert.equal(world.obstacles.length, 0);
  const target = world.boids[0]; assert.equal(eraseAt(world, target.x, target.y, 0.08), 'boid');
});

test('new sources add voices up to the explicit six-voice world budget', () => {
  const world = createWorld({ seed: 3 });
  assert.notEqual(addFlock(world, 'pulse'), false); assert.notEqual(addFlock(world, 'resonance'), false); assert.notEqual(addFlock(world, 'texture'), false);
  assert.equal(world.objects.length, 6); assert.equal(addFlock(world, 'pulse'), false);
});

test('flock centroid, spread and speed produce bounded control-frame signals', () => {
  const world = run(createWorld({ seed: 21 }), 2);
  for (const voice of world.objects) {
    assert.ok(Math.abs(voice.pan - (voice.centroid.x * 2 - 1)) < 0.5);
    assert.ok(voice.perceptualPosition[1] >= voice.identityAnchor[1] - 0.02);
    assert.ok(voice.energy > 0.2);
  }
});

test('harmonic and energy inputs remain bounded', () => {
  const world = createWorld(); setHarmonicCenter(world, 74); injectEnergy(world, 1); run(world, 1);
  assert.equal(world.harmonicCenter, 2); assert.ok(world.boids.every((boid) => Math.hypot(boid.vx, boid.vy) <= world.config.maxSpeed * 1.25 + 1e-6));
});

test('recorded editing actions replay deterministically', () => {
  const world = createWorld({ seed: 81 }); const recorder = new SessionRecorder(world);
  recorder.record(world, 'add-boid', { flockId: 0, x: 0.4, y: 0.6 }); addBoid(world, 0, 0.4, 0.6);
  run(world, 1); recorder.record(world, 'add-obstacle', { x: 0.5, y: 0.5, radius: 0.06 }); addObstacle(world, 0.5, 0.5, 0.06); run(world, 1);
  assert.deepEqual(replaySession(recorder.export(), 2), snapshotWorld(world));
});

test('metrics expose bounded flock signals', () => {
  const metrics = measureWorld(createWorld({ seed: 18 }));
  for (const key of ['context', 'trend', 'clarity', 'collectiveSpeed', 'maskingCost', 'identityDrift', 'identitySpread']) assert.ok(metrics[key] >= 0 && metrics[key] <= 1, key);
});
