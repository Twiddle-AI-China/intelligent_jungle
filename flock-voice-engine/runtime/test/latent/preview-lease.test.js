import assert from 'node:assert/strict';
import test from 'node:test';

import { createLeaseManager } from '../../src/control/lease-manager.js';
import { createPreviewLease } from '../../src/latent/preview-lease.js';

function fixture({ throwing = false } = {}) {
  let now = 0;
  let token = 0;
  const accepted = [];
  const clock = { now: () => now };
  const leases = createLeaseManager({ clock, tokenFactory: () => `token-${token += 1}` });
  const preview = createPreviewLease({
    audioSink: {
      accept(commands) {
        if (throwing) throw new Error('sink failed');
        accepted.push(structuredClone(commands));
      },
    },
    clock,
    leaseManager: leases,
  });
  return { preview, leases, accepted, advance: (ms) => { now += ms; } };
}

function takeControl(leases, voice, clientId = 'owner', connectionGeneration = 'owner-1') {
  return leases.take({ resource: `latent:${voice}`, clientId, connectionGeneration, ttlMs: 3_000 });
}

test('preview requires the same voice control lease and always releases', () => {
  const { preview, leases, accepted } = fixture();
  assert.equal(preview.start({
    voice: 'pad', clientId: 'observer', connectionGeneration: 'observer-1', leaseToken: 'missing',
  }).code, 'lease_required');
  const lease = takeControl(leases, 'pad');
  assert.equal(preview.start({
    voice: 'pad', clientId: 'owner', connectionGeneration: 'owner-1', leaseToken: lease.leaseToken,
  }).ok, true);
  assert.equal(preview.getPublicState('pad').active, true);
  assert.equal(preview.disconnect({ clientId: 'owner', connectionGeneration: 'owner-1' }).changed, true);
  assert.equal(accepted.at(-1)[0].type, 'preview.allOff');
  assert.equal(preview.getPublicState('pad').active, false);
});

test('start is idempotent and every TTL/control-loss path sends all-off once', () => {
  const { preview, leases, accepted, advance } = fixture();
  const lease = takeControl(leases, 'bass');
  const command = {
    voice: 'bass', clientId: 'owner', connectionGeneration: 'owner-1', leaseToken: lease.leaseToken,
  };
  assert.equal(preview.start(command).code, 'ok');
  assert.equal(preview.start(command).code, 'already_active');
  assert.equal(accepted.flat().filter(({ type }) => type === 'preview.start').length, 1);
  advance(2_001);
  assert.equal(preview.tick(2_001).changed, true);
  assert.equal(preview.tick(2_001).changed, false);
  assert.equal(accepted.flat().filter(({ type }) => type === 'preview.allOff').length, 1);
  assert.deepEqual(preview.getPublicState('bass'), {
    active: false, audible: false, phaseGate: 'shadow-no-audio', expiresAt: null,
  });
});

test('audio rejection rolls back a newly acquired preview lease and public state', () => {
  const { preview, leases } = fixture({ throwing: true });
  const lease = takeControl(leases, 'melody');
  const started = preview.start({
    voice: 'melody', clientId: 'owner', connectionGeneration: 'owner-1', leaseToken: lease.leaseToken,
  });
  assert.equal(started.code, 'audio_intent_rejected');
  assert.equal(preview.getPublicState('melody').active, false);
  assert.equal(leases.get('preview:melody'), null);
});

test('old socket stop/disconnect cannot release a new preview owner', () => {
  const { preview, leases } = fixture();
  const old = takeControl(leases, 'pad', 'owner', 'old');
  preview.start({ voice: 'pad', clientId: 'owner', connectionGeneration: 'old', leaseToken: old.leaseToken });
  preview.disconnect({ clientId: 'owner', connectionGeneration: 'old' });
  leases.release({ resource: 'latent:pad', clientId: 'owner', connectionGeneration: 'old', leaseToken: old.leaseToken });
  const current = takeControl(leases, 'pad', 'owner', 'new');
  preview.start({ voice: 'pad', clientId: 'owner', connectionGeneration: 'new', leaseToken: current.leaseToken });
  assert.equal(preview.stop({
    voice: 'pad', clientId: 'owner', connectionGeneration: 'old', leaseToken: old.leaseToken,
  }).code, 'lease_required');
  assert.equal(preview.disconnect({ clientId: 'owner', connectionGeneration: 'old' }).changed, false);
  assert.equal(preview.getPublicState('pad').active, true);
});
