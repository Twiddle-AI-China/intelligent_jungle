import test from 'node:test';
import assert from 'node:assert/strict';
import { addBoid, addFlock, addObstacle, createWorld, eraseAt, injectEnergy, measureWorld, setHarmonicCenter, setInteraction, setWorldControl, snapshotWorld, SPECIES, stepWorld } from '../src/world.js';
import { replaySession, SessionRecorder } from '../src/session.js';

function run(world, seconds, frame = 1 / 60) {
  for (let time = 0; time < seconds - 1e-9; time += frame) stepWorld(world, Math.min(frame, seconds - time));
  return world;
}

test('world starts as four voices across four species, twenty-eight boids', () => {
  const a = createWorld({ seed: 42 }); const b = createWorld({ seed: 42 });
  assert.equal(a.objects.length, 4); assert.equal(a.boids.length, 28); assert.equal(a.obstacles.length, 0);
  assert.deepEqual(a.objects.map((voice) => voice.speciesId), [0, 1, 2, 3].map((index) => SPECIES[index].id));
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
  for (const voice of world.objects) assert.ok(voice.relationState.length === 8 && voice.relationState.every((value) => value >= -1 && value <= 1));
});

test('adding a boid changes relational state without adding a voice', () => {
  const world = createWorld({ seed: 8 }); const voiceCount = world.objects.length; const before = [...world.objects[0].relationState];
  assert.equal(addBoid(world, world.objects[0].id, 0.4, 0.4), true); run(world, 3);
  assert.equal(world.objects.length, voiceCount); assert.equal(world.objects[0].population, 8);
  assert.notDeepEqual(world.objects[0].relationState, before);
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
});

test('flock exposes XY for the score plane and a separate eight-dimensional relation state', () => {
  const world = createWorld({ seed: 13 }); const voice = world.objects[0];
  const before = { ...voice.centroid };
  assert.equal(voice.relationState.length, 8);
  assert.equal('chartPosition' in voice, false);
  setInteraction(world, { mode: 'guide', x: voice.centroid.x, y: voice.centroid.y, dx: -0.8, dy: 0.4, strength: 1 }); run(world, 0.3);
  assert.notDeepEqual(world.objects[0].centroid, before);
});

test('visible pulse field crossings create flock trigger events', () => {
  const world = createWorld({ seed: 31, tempo: 120 });
  const before = world.objects.map((voice) => voice.triggerSerial);
  run(world, 1.1);
  assert.ok(world.objects.some((voice, index) => voice.triggerSerial > before[index]));
  assert.ok(world.pulsePosition >= 0 && world.pulsePosition < 1);
});

test('vertical Dorian field selects pitch and root transposes it', () => {
  const world = createWorld({ seed: 41 }); const before = world.objects.map((voice) => voice.pitchClass);
  setHarmonicCenter(world, 2);
  assert.deepEqual(world.objects.map((voice) => voice.pitchClass), before.map((pitch) => (pitch + 2) % 12));
  assert.ok(world.objects.every((voice) => Number.isInteger(voice.pitchZone) && Math.abs(voice.pitchSemitones) <= 6));
});

test('connected bird groups become one note each with bounded pitch and duration', () => {
  const world = createWorld({ seed: 51 });
  const birds = world.boids.filter((boid) => boid.flockId === 0);
  birds.forEach((bird, index) => {
    const second = index >= 3;
    bird.x = (second ? 0.68 : 0.22) + (index % 3) * 0.008;
    bird.y = second ? 0.78 : 0.2;
    bird.vx = 0; bird.vy = second ? world.config.maxSpeed : -world.config.maxSpeed;
  });
  setWorldControl(world, 'clusterRadius', 0.06);
  setWorldControl(world, 'minNoteBirds', 2);
  const groups = world.objects[0].noteGroups;
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.durationSeconds >= 0.08 && group.durationSeconds <= 1.28));
  assert.notEqual(groups[0].pitchClass, groups[1].pitchClass);
  setWorldControl(world, 'minNoteBirds', 5);
  assert.equal(world.objects[0].noteGroups.length, 1);
});

test('pulse timeline triggers note groups independently by their X position', () => {
  const world = createWorld({ seed: 52, tempo: 120, wanderStrength: 0 });
  const birds = world.boids.filter((boid) => boid.flockId === 0);
  birds.forEach((bird, index) => {
    const second = index >= 3;
    bird.x = (second ? 0.72 : 0.2) + (index % 3) * 0.006;
    bird.y = second ? 0.7 : 0.25;
    bird.vx = 0; bird.vy = 0;
  });
  setWorldControl(world, 'clusterRadius', 0.05);
  setWorldControl(world, 'minNoteBirds', 2);
  run(world, 0.14, 1 / 100);
  const groups = world.objects[0].noteGroups.sort((a, b) => a.x - b.x);
  assert.equal(groups.length, 2);
  assert.ok(groups[0].triggerSerial > groups[1].triggerSerial);
});

test('playability controls are clamped and update live world config', () => {
  const world = createWorld();
  assert.equal(setWorldControl(world, 'latentStep', 99), 0.8);
  assert.equal(setWorldControl(world, 'cohesionStrength', -1), 0);
  assert.equal(setWorldControl(world, 'minNoteBirds', 3.6), 4);
  assert.equal(setWorldControl(world, 'wanderStrength', 99), 0.8);
  assert.equal(setWorldControl(world, 'unknown', 1), false);
});

test('eraser removes obstacles first and never deletes the last two birds of a flock', () => {
  const world = createWorld({ seed: 9 }); addObstacle(world, 0.5, 0.5, 0.08);
  assert.equal(eraseAt(world, 0.5, 0.5), 'obstacle'); assert.equal(world.obstacles.length, 0);
  const target = world.boids[0]; assert.equal(eraseAt(world, target.x, target.y, 0.08), 'boid');
});

test('new sources add voices up to the explicit six-voice world budget', () => {
  const world = createWorld({ seed: 3 });
  assert.notEqual(addFlock(world, 'pulse'), false); assert.notEqual(addFlock(world, 'resonance'), false);
  assert.equal(world.objects.length, 6); assert.equal(addFlock(world, 'pulse'), false);
});

test('flock relationships produce eight bounded and changing latent controls', () => {
  const world = run(createWorld({ seed: 21 }), 2);
  for (const voice of world.objects) {
    assert.ok(Math.abs(voice.pan - (voice.centroid.x * 2 - 1)) < 0.5);
    assert.equal(voice.relationState.length, 8);
    assert.ok(voice.relationState.every((value) => value >= -1 && value <= 1));
    assert.ok(voice.energy > 0.2);
  }
});

test('seeded low-frequency wander changes motion without breaking replay determinism', () => {
  const moving = run(createWorld({ seed: 88, wanderStrength: 0.8 }), 4);
  const repeat = run(createWorld({ seed: 88, wanderStrength: 0.8 }), 4);
  const still = run(createWorld({ seed: 88, wanderStrength: 0 }), 4);
  assert.deepEqual(snapshotWorld(moving), snapshotWorld(repeat));
  assert.notDeepEqual(moving.boids.map(({ x, y }) => [x, y]), still.boids.map(({ x, y }) => [x, y]));
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
