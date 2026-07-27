import assert from 'node:assert/strict';
import test from 'node:test';

import { createLeaseManager } from '../../src/control/lease-manager.js';
import { createLatentRuntime } from '../../src/latent/latent-runtime.js';
import { createLatentMapRepository } from '../../src/latent/map-repository.js';
import { LATENT_VOICES } from '../../src/latent/voice-config.js';

function createFixture({ tokenFactory } = {}) {
  let now = 0;
  let token = 0;
  const clock = { now: () => now };
  const leases = createLeaseManager({
    clock,
    tokenFactory: tokenFactory ?? (() => `lease-${token += 1}`),
  });
  const runtime = createLatentRuntime({
    voiceConfig: LATENT_VOICES,
    mapRepository: createLatentMapRepository({
      assetRoot: new URL('../../../assets/timbre/voice_maps/', import.meta.url),
    }),
    audioSink: { accept() {} },
    clock,
    leaseManager: leases,
  });
  return { runtime, advance: (ms) => { now += ms; } };
}

test('one voice has one exact owner and old generations cannot mutate or release it', () => {
  const { runtime } = createFixture();
  const first = runtime.takeControl({ voice: 'pad', clientId: 'c1', connectionGeneration: 's1' });
  assert.equal(first.ok, true);
  assert.equal(runtime.takeControl({ voice: 'pad', clientId: 'c2', connectionGeneration: 's2' }).code, 'lease_conflict');
  assert.equal(runtime.setCursor({
    voice: 'pad', clientId: 'c1', connectionGeneration: 'old', leaseToken: first.leaseToken,
    eventSeq: 1, cursor: { x: 0, y: 0, pca: [] },
  }).code, 'lease_required');
  assert.equal(runtime.releaseControl({
    voice: 'pad', clientId: 'c1', connectionGeneration: 'old', leaseToken: first.leaseToken,
  }).code, 'lease_mismatch');
  assert.equal(runtime.getPublicState().pad.owner, 'USER');
});

test('TTL and exact disconnect return control to AGENT without exposing token', () => {
  const { runtime, advance } = createFixture();
  const lease = runtime.takeControl({ voice: 'bass', clientId: 'c1', connectionGeneration: 's1', ttlMs: 1_000 });
  assert.equal(JSON.stringify(runtime.getPublicState()).includes(lease.leaseToken), false);
  assert.equal(runtime.disconnect({ clientId: 'c1', connectionGeneration: 'old' }).changed, false);
  assert.equal(runtime.getPublicState().bass.owner, 'USER');
  advance(1_001);
  runtime.tick(1_001);
  assert.equal(runtime.getPublicState().bass.owner, 'AGENT');

  runtime.takeControl({ voice: 'melody', clientId: 'c1', connectionGeneration: 's2' });
  assert.equal(runtime.disconnect({ clientId: 'c1', connectionGeneration: 's2' }).changed, true);
  assert.equal(runtime.getPublicState().melody.owner, 'AGENT');
});

test('an expired heartbeat cannot strand USER state after removing its lease', () => {
  const { runtime, advance } = createFixture();
  const lease = runtime.takeControl({
    voice: 'pad', clientId: 'c1', connectionGeneration: 's1', ttlMs: 1_000,
  });
  advance(1_001);
  const heartbeat = runtime.heartbeat({
    voice: 'pad', clientId: 'c1', connectionGeneration: 's1', leaseToken: lease.leaseToken,
  });
  assert.equal(heartbeat.code, 'lease_expired');
  assert.equal(heartbeat.changed, true);
  assert.equal(runtime.getPublicState().pad.owner, 'AGENT');
  assert.equal(runtime.getPublicState().pad.control.held, false);
});

test('terminal release clears cursor ordering for the next lease', () => {
  const { runtime } = createFixture();
  const first = runtime.takeControl({ voice: 'pad', clientId: 'c1', connectionGeneration: 's1' });
  runtime.setCursor({
    voice: 'pad', clientId: 'c1', connectionGeneration: 's1', leaseToken: first.leaseToken,
    eventSeq: 50, cursor: { x: 0.5, y: 0, pca: [] },
  });
  runtime.releaseControl({
    voice: 'pad', clientId: 'c1', connectionGeneration: 's1', leaseToken: first.leaseToken,
  });
  const second = runtime.takeControl({ voice: 'pad', clientId: 'c1', connectionGeneration: 's1' });
  assert.equal(runtime.setCursor({
    voice: 'pad', clientId: 'c1', connectionGeneration: 's1', leaseToken: second.leaseToken,
    eventSeq: 1, cursor: { x: -0.5, y: 0, pca: [] },
  }).ok, true);
});

test('failed replacement after expiry cannot strand USER without a lease', () => {
  let calls = 0;
  const { runtime, advance } = createFixture({
    tokenFactory() {
      calls += 1;
      if (calls === 1) return 'lease-first';
      throw new Error('entropy unavailable');
    },
  });
  runtime.takeControl({
    voice: 'bass', clientId: 'c1', connectionGeneration: 's1', ttlMs: 1_000,
  });
  advance(1_001);
  const replacement = runtime.takeControl({
    voice: 'bass', clientId: 'c2', connectionGeneration: 's2', ttlMs: 1_000,
  });
  assert.equal(replacement.code, 'token_unavailable');
  assert.equal(replacement.changed, true);
  assert.equal(runtime.getPublicState().bass.owner, 'AGENT');
  assert.equal(runtime.getPublicState().bass.control.held, false);
  assert.equal(runtime.tick(1_001).changed, false);
});
