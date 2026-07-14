import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, injectEnergy, measureWorld, setHarmonicCenter, setInteraction, snapshotWorld, stepWorld } from '../src/world.js';
import { replaySession, SessionRecorder } from '../src/session.js';

function run(world, seconds, frame = 1 / 60) {
  for (let time = 0; time < seconds - 1e-9; time += frame) stepWorld(world, Math.min(frame, seconds - time));
  return world;
}

test('world creation is deterministic and defaults to six persistent identities', () => {
  const a = createWorld({ seed: 42 });
  const b = createWorld({ seed: 42 });
  assert.equal(a.objects.length, 6);
  assert.deepEqual(snapshotWorld(a), snapshotWorld(b));
  assert.ok(a.objects.every((object) => object.identityAnchor.length === 6 && object.role));
});

test('fixed-step evolution is independent of display frame partitioning', () => {
  const fast = run(createWorld({ seed: 7 }), 4, 1 / 100);
  const slow = run(createWorld({ seed: 7 }), 4, 1 / 50);
  assert.deepEqual(snapshotWorld(fast), snapshotWorld(slow));
});

test('long autonomous evolution remains finite, bounded and audible', () => {
  const world = run(createWorld({ seed: 7 }), 60, 1 / 120);
  for (const object of world.objects) {
    assert.ok(object.perceptualPosition.every((value) => Number.isFinite(value) && value >= 0.04 && value <= 0.96));
    assert.ok(object.energy >= 0.12 && object.energy <= 0.94);
    assert.ok(object.pan >= -1 && object.pan <= 1);
  }
});

test('context coupling affects phase without collapsing perceptual identity', () => {
  const baseline = run(createWorld({ seed: 33 }), 8);
  const gathered = createWorld({ seed: 33 });
  const initialSpread = measureWorld(gathered).identitySpread;
  setInteraction(gathered, { mode: 'gather', x: 0.5, y: 0.5, strength: 1 });
  run(gathered, 8);
  assert.ok(gathered.metrics.phaseCoherence > baseline.metrics.phaseCoherence);
  assert.ok(gathered.metrics.identitySpread > initialSpread * 0.6);
});

test('common motion aligns velocities without aligning positions', () => {
  const world = createWorld({ seed: 91 });
  const initialSpread = world.metrics.identitySpread || measureWorld(world).identitySpread;
  setInteraction(world, { mode: 'guide', x: 0.5, y: 0.5, dx: 0.8, dy: -0.25, strength: 1 });
  run(world, 5);
  assert.ok(world.metrics.trendAgreement > 0.5);
  assert.ok(world.metrics.identitySpread > initialSpread * 0.6);
});

test('niche formation makes bounded, rate-limited decisions', () => {
  const world = createWorld({ seed: 12, conflictThreshold: 0.2 });
  setInteraction(world, { mode: 'scatter', x: 0.5, y: 0.5, strength: 1 });
  run(world, 10);
  const decisions = world.objects.reduce((sum, object) => sum + object.niche.decisions, 0);
  assert.ok(decisions > 0);
  assert.ok(world.metrics.decisionRate < 2);
  assert.ok(world.objects.every((object) => object.energy >= 0.12));
});

test('harmonic center and energy inputs are normalized', () => {
  const world = createWorld();
  const before = world.objects.reduce((sum, object) => sum + object.energy, 0);
  setHarmonicCenter(world, 74, 0.8);
  injectEnergy(world, 1);
  run(world, 1);
  assert.equal(world.harmonicCenter, 2);
  assert.ok(world.objects.reduce((sum, object) => sum + object.energy, 0) > before);
});

test('recorded sessions replay to the same final world', () => {
  const world = createWorld({ seed: 81 });
  const recorder = new SessionRecorder(world);
  const interaction = { mode: 'guide', x: 0.4, y: 0.6, dx: 0.3, dy: -0.2, strength: 1 };
  recorder.record(world, 'interaction', interaction);
  setInteraction(world, interaction);
  run(world, 1);
  recorder.record(world, 'release');
  setInteraction(world, null);
  run(world, 1);
  const replayed = replaySession(recorder.export(), 2);
  assert.deepEqual(replayed, snapshotWorld(world));
});

test('metrics expose the specified bounded world signals', () => {
  const metrics = measureWorld(createWorld({ seed: 18 }));
  for (const key of ['phaseCoherence', 'trendAgreement', 'maskingCost', 'identityDrift', 'identitySpread']) {
    assert.ok(metrics[key] >= 0 && metrics[key] <= 1, key);
  }
});
