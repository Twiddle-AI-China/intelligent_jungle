import assert from 'node:assert/strict';
import test from 'node:test';

import { createLeaseManager } from '../../src/control/lease-manager.js';
import { createLatentRuntime } from '../../src/latent/latent-runtime.js';
import { createLatentMapRepository } from '../../src/latent/map-repository.js';
import { LATENT_VOICES } from '../../src/latent/voice-config.js';

const ASSET_ROOT = new URL('../../../assets/timbre/voice_maps/', import.meta.url);

function snapshot(energy = 0.2) {
  return {
    trees: ['bass', 'pad', 'melody'].map((species) => ({
      id: `${species}-tree`, species, branches: new Array(5).fill({}),
      birds: [
        { state: 'perched', branchId: 1, energy, dwellBeatTime: 4, switchesUsed: 1, activeToday: true },
        { state: 'flying', branchId: 3, energy, dwellBeatTime: 0, switchesUsed: 2, activeToday: true },
      ],
    })),
  };
}

function fixture({ throwing = false } = {}) {
  let now = 0;
  let token = 0;
  const accepted = [];
  const clock = { now: () => now };
  const leaseManager = createLeaseManager({
    clock, tokenFactory: () => `token-${token += 1}`, defaultTtlMs: 3_000, maxTtlMs: 10_000,
  });
  const audioSink = {
    accept(commands) {
      if (throwing) throw new Error('sink failed');
      accepted.push(structuredClone(commands));
    },
  };
  const runtime = createLatentRuntime({
    voiceConfig: LATENT_VOICES,
    mapRepository: createLatentMapRepository({ assetRoot: ASSET_ROOT }),
    audioSink,
    clock,
    leaseManager,
  });
  return { runtime, accepted, advance: (ms) => { now += ms; }, leaseManager };
}

function take(runtime, voice = 'melody', clientId = 'c1', connectionGeneration = 's1') {
  return runtime.takeControl({ voice, clientId, connectionGeneration, ttlMs: 3_000 });
}

test('ecology updates at 10Hz with alpha=1-exp(-dt/4)', () => {
  const { runtime, accepted } = fixture();
  assert.equal(runtime.updateEcology(snapshot(0.2), 0.05).changed, false);
  const first = runtime.updateEcology(snapshot(0.2), 0.05);
  assert.equal(first.changed, true);
  assert.equal(accepted.length, 1);
  const before = runtime.getPublicState().melody.cursor;
  const targetBefore = runtime.getPublicState().melody.target;
  runtime.updateEcology(snapshot(1), 0.1);
  const after = runtime.getPublicState().melody.cursor;
  const targetAfter = runtime.getPublicState().melody.target;
  const alpha = 1 - Math.exp(-0.1 / 4);
  assert.ok(Math.abs(after.x - (before.x + (targetAfter.x - before.x) * alpha)) < 1e-12);
  assert.notDeepEqual(targetAfter, targetBefore);
});

test('takeover starts at current cursor and release glides back to ecology', () => {
  const { runtime, advance } = fixture();
  runtime.updateEcology(snapshot(0.2), 0.1);
  const before = runtime.getPublicState().melody.cursor;
  const lease = take(runtime);
  assert.equal(lease.ok, true);
  assert.deepEqual(runtime.getPublicState().melody.cursor, before);
  runtime.updateEcology(snapshot(1), 0.1);
  assert.deepEqual(runtime.getPublicState().melody.cursor, before);
  runtime.releaseControl({
    voice: 'melody', clientId: 'c1', connectionGeneration: 's1', leaseToken: lease.leaseToken,
  });
  advance(100);
  runtime.tick(100);
  assert.notDeepEqual(runtime.getPublicState().melody.cursor, before);
  assert.equal(runtime.getPublicState().melody.owner, 'AGENT');
});

test('cursor updates coalesce by voice/eventSeq and publish only the latest intent', () => {
  const { runtime, accepted, advance } = fixture();
  runtime.updateEcology(snapshot(), 0.1);
  accepted.length = 0;
  const lease = take(runtime, 'pad');
  assert.equal(runtime.setCursor({
    voice: 'pad', clientId: 'c1', connectionGeneration: 's1', leaseToken: lease.leaseToken,
    eventSeq: 10, cursor: { x: -0.5, y: 0.2, pca: [] },
  }).ok, true);
  assert.equal(runtime.setCursor({
    voice: 'pad', clientId: 'c1', connectionGeneration: 's1', leaseToken: lease.leaseToken,
    eventSeq: 11, cursor: { x: 0.75, y: -0.25, pca: [] },
  }).ok, true);
  assert.equal(runtime.setCursor({
    voice: 'pad', clientId: 'c1', connectionGeneration: 's1', leaseToken: lease.leaseToken,
    eventSeq: 9, cursor: { x: 0, y: 0, pca: [] },
  }).code, 'stale_cursor');
  advance(100);
  runtime.tick(100);
  assert.equal(accepted.length, 1);
  assert.deepEqual(runtime.getPublicState().pad.cursor, { x: 0.75, y: -0.25, pca: [] });
});

test('same-owner take retry preserves pending cursor and monotonic eventSeq', () => {
  const { runtime, accepted, advance } = fixture();
  const lease = take(runtime, 'pad');
  runtime.setCursor({
    voice: 'pad', clientId: 'c1', connectionGeneration: 's1', leaseToken: lease.leaseToken,
    eventSeq: 10, cursor: { x: 0.8, y: 0, pca: [] },
  });
  const retried = take(runtime, 'pad');
  assert.equal(retried.code, 'already_held');
  assert.equal(retried.changed, false);
  assert.equal(runtime.setCursor({
    voice: 'pad', clientId: 'c1', connectionGeneration: 's1', leaseToken: lease.leaseToken,
    eventSeq: 9, cursor: { x: -0.8, y: 0, pca: [] },
  }).code, 'stale_cursor');
  accepted.length = 0;
  advance(100);
  runtime.tick(100);
  assert.deepEqual(runtime.getPublicState().pad.cursor, { x: 0.8, y: 0, pca: [] });
  assert.equal(accepted.length, 1);
});

test('audio rejection leaves authoritative cursor unchanged', () => {
  const { runtime, advance } = fixture({ throwing: true });
  const lease = take(runtime, 'bass');
  const before = runtime.getPublicState().bass.cursor;
  runtime.setCursor({
    voice: 'bass', clientId: 'c1', connectionGeneration: 's1', leaseToken: lease.leaseToken,
    eventSeq: 1, cursor: { x: 0.5, y: 0.5, pca: [] },
  });
  advance(100);
  assert.throws(() => runtime.tick(100), /AUDIO_INTENT_REJECTED/);
  assert.deepEqual(runtime.getPublicState().bass.cursor, before);
});

test('expiry commits control loss without audio before a fallible glide', () => {
  const { runtime, advance } = fixture({ throwing: true });
  const lease = runtime.takeControl({
    voice: 'melody', clientId: 'c1', connectionGeneration: 's1', ttlMs: 1_000,
  });
  assert.equal(lease.ok, true);
  const before = runtime.getPublicState().melody.cursor;
  const changedEcology = snapshot(1);
  changedEcology.trees = changedEcology.trees.filter(({ species }) => species === 'melody');
  runtime.updateEcology(changedEcology, 0.1);
  assert.notDeepEqual(runtime.getPublicState().melody.target, before);
  advance(1_001);
  const expired = runtime.tick(1_001);
  assert.equal(expired.changed, true);
  assert.deepEqual(expired.audioCommands, []);
  assert.equal(runtime.getPublicState().melody.owner, 'AGENT');
  assert.deepEqual(runtime.getPublicState().melody.cursor, before);
});
