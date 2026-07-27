import assert from 'node:assert/strict';
import test from 'node:test';

import { createLeaseManager } from '../../src/control/lease-manager.js';

function fixture() {
  let now = 1_000;
  let token = 0;
  const manager = createLeaseManager({
    clock: { now: () => now },
    tokenFactory: () => `lease-${token += 1}`,
    defaultTtlMs: 3_000,
    maxTtlMs: 10_000,
  });
  return { manager, advance: (ms) => { now += ms; }, now: () => now };
}

test('take conflicts and exact owner heartbeat extends the saved TTL', () => {
  const { manager, advance, now } = fixture();
  const first = manager.take({ resource: 'latent:pad', clientId: 'c1', connectionGeneration: 's1' });
  assert.equal(first.ok, true);
  assert.equal(first.expiresAt, now() + 3_000);
  assert.equal(manager.take({ resource: 'latent:pad', clientId: 'c2', connectionGeneration: 's2' }).code, 'lease_conflict');
  advance(500);
  assert.equal(manager.heartbeat({
    resource: 'latent:pad', clientId: 'c1', connectionGeneration: 's1', leaseToken: first.leaseToken,
  }).expiresAt, now() + 3_000);
  assert.equal(manager.heartbeat({
    resource: 'latent:pad', clientId: 'c1', connectionGeneration: 'old', leaseToken: first.leaseToken,
  }).code, 'lease_mismatch');
});

test('disconnect only releases leases from the exact socket generation', () => {
  const { manager } = fixture();
  const first = manager.take({
    resource: 'latent:pad', clientId: 'c1', connectionGeneration: 'socket-1', ttlMs: 3000,
  });
  assert.equal(first.ok, true);
  assert.equal(manager.disconnect({ clientId: 'c1', connectionGeneration: 'socket-2' }).length, 0);
  const released = manager.disconnect({ clientId: 'c1', connectionGeneration: 'socket-1' });
  assert.equal(released.length, 1);
  assert.equal(released[0].leaseToken, first.leaseToken);
  assert.equal(Object.isFrozen(released), true);
});

test('release is idempotent, expiry is explicit, and public state never contains a token', () => {
  const { manager, advance } = fixture();
  const first = manager.take({
    resource: 'latent:bass', clientId: 'c1', connectionGeneration: 's1', ttlMs: 1_000,
  });
  assert.equal(JSON.stringify(manager.getPublicState('latent:bass')).includes(first.leaseToken), false);
  assert.deepEqual(Object.keys(manager.getPublicState('latent:bass')), ['held', 'expiresAt']);
  assert.equal(manager.release({
    resource: 'latent:bass', clientId: 'c1', connectionGeneration: 's1', leaseToken: first.leaseToken,
  }).released, true);
  assert.equal(manager.release({
    resource: 'latent:bass', clientId: 'c1', connectionGeneration: 's1', leaseToken: first.leaseToken,
  }).released, false);

  manager.take({ resource: 'latent:melody', clientId: 'c2', connectionGeneration: 's2', ttlMs: 1_000 });
  advance(1_001);
  assert.equal(manager.expire().length, 1);
  assert.equal(manager.getPublicState('latent:melody').held, false);
});

test('invalid TTL and identity values fail closed', () => {
  const { manager } = fixture();
  for (const ttlMs of [0, -1, 1.5, 10_001, Infinity]) {
    assert.equal(manager.take({ resource: 'latent:pad', clientId: 'c', connectionGeneration: 's', ttlMs }).code, 'invalid_lease');
  }
  assert.equal(manager.take({ resource: '__proto__', clientId: '', connectionGeneration: 's' }).code, 'invalid_lease');
});
