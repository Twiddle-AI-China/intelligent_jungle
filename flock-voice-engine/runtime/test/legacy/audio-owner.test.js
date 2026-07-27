import assert from 'node:assert/strict';
import test from 'node:test';
import { createAudioOwnerController } from '../../src/legacy/audio-owner.js';
import { createLeaseManager } from '../../src/control/lease-manager.js';
import { createDecoderSessionRegistry } from '../../src/legacy/decoder-session-registry.js';
import { createLegacyWriteAccess } from '../../src/legacy/write-access.js';

function harness({ onEnter = () => {} } = {}) {
  let now = 0; let token = 0; const transitions = [];
  const leaseManager = createLeaseManager({ clock: { now: () => now },
    tokenFactory: () => `lease-${++token}` });
  const sessions = createDecoderSessionRegistry({ tokenFactory: () => `session-${++token}` });
  const decoder = sessions.attach({});
  const legacyAccess = createLegacyWriteAccess();
  const owner = createAudioOwnerController({ leaseManager, sessionRegistry: sessions,
    maintenanceAuth: { verify: ({ maintenanceToken }) => maintenanceToken === 'authorized' },
    legacyAccess,
    controlBarrier: { async enterLegacy(value) { transitions.push(['take', value.decoderSessionId]); onEnter();
      legacyAccess.allowExactGeneration(value.decoderSessionId); },
      async restoreWorld(reason) { legacyAccess.rejectWrites(); transitions.push(['restore', reason]); } },
    clock: { now: () => now } });
  return { owner, sessions, decoder, transitions, leaseManager, setNow: (value) => { now = value; } };
}

test('lease binds exact live decoder generation and disconnect restores world', async () => {
  const h = harness();
  const request = { maintenanceToken: 'authorized', connectionGeneration: 'runtime-1',
    decoderSessionId: h.decoder.decoderSessionId };
  const acquired = await h.owner.takeLegacy(request);
  assert.equal(acquired.ok, true);
  h.sessions.detach(h.decoder.decoderSessionId);
  await h.owner.decoderDisconnected(h.decoder.decoderSessionId);
  assert.deepEqual(h.transitions, [['take', h.decoder.decoderSessionId], ['restore', 'legacy-disconnect']]);
});

test('gone session and TTL release fail closed', async () => {
  const h = harness();
  h.sessions.detach(h.decoder.decoderSessionId);
  await assert.rejects(h.owner.takeLegacy({ maintenanceToken: 'authorized',
    connectionGeneration: 'runtime-1', decoderSessionId: h.decoder.decoderSessionId }),
  /LEGACY_DECODER_SESSION_GONE/);
});

test('competing decoder conflicts, heartbeat refreshes ownership, and expiry restores once', async () => {
  const h = harness();
  const other = h.sessions.attach({});
  const request = { maintenanceToken: 'authorized', connectionGeneration: 'runtime-1',
    decoderSessionId: h.decoder.decoderSessionId };
  const acquired = await h.owner.takeLegacy(request);
  const conflict = await h.owner.takeLegacy({ ...request, decoderSessionId: other.decoderSessionId });
  assert.equal(conflict.code, 'lease_conflict');
  h.setNow(1000);
  assert.equal(h.owner.heartbeat({ ...request, leaseToken: acquired.leaseToken }).ok, true);
  h.setNow(5500);
  assert.equal(h.owner.owns(h.decoder.decoderSessionId), true);
  assert.equal((await h.owner.expire()).length, 0);
  h.setNow(6000);
  assert.equal((await h.owner.expire()).length, 1);
  assert.equal((await h.owner.expire()).length, 0);
  assert.deepEqual(h.transitions, [['take', h.decoder.decoderSessionId], ['restore', 'legacy-expired']]);
});

test('release rejects wrong token and all terminal causes use the one restore operation', async () => {
  for (const cause of ['release', 'disconnect', 'expiry']) {
    const h = harness();
    const request = { maintenanceToken: 'authorized', connectionGeneration: 'runtime-1',
      decoderSessionId: h.decoder.decoderSessionId };
    const acquired = await h.owner.takeLegacy(request);
    assert.equal((await h.owner.releaseLegacy({ ...request, leaseToken: 'wrong' })).ok, false);
    if (cause === 'release') await h.owner.releaseLegacy({ ...request, leaseToken: acquired.leaseToken });
    if (cause === 'disconnect') await h.owner.decoderDisconnected(h.decoder.decoderSessionId);
    if (cause === 'expiry') { h.setNow(5000); await h.owner.expire(); }
    assert.equal(h.transitions.filter(([kind]) => kind === 'restore').length, 1, cause);
    assert.equal(h.owner.getStatus().audioOwner, 'world');
  }
});

test('an expired heartbeat cannot consume the lease without restoring world', async () => {
  const h = harness();
  const request = { maintenanceToken: 'authorized', connectionGeneration: 'runtime-1',
    decoderSessionId: h.decoder.decoderSessionId };
  const acquired = await h.owner.takeLegacy(request);
  h.setNow(5000);
  assert.equal(h.owner.heartbeat({ ...request, leaseToken: acquired.leaseToken }).code, 'lease_expired');
  await h.owner.expire();
  assert.deepEqual(h.transitions, [['take', h.decoder.decoderSessionId], ['restore', 'legacy-expired']]);
  assert.equal(h.owner.getStatus().audioOwner, 'world');
});

test('take that outlives its TTL restores world and never returns an owning lease', async () => {
  let advance;
  const h = harness({ onEnter: () => advance(5000) });
  advance = h.setNow;
  const request = { maintenanceToken: 'authorized', connectionGeneration: 'runtime-1',
    decoderSessionId: h.decoder.decoderSessionId };
  await assert.rejects(h.owner.takeLegacy(request), /LEGACY_LEASE_LOST/);
  assert.deepEqual(h.transitions, [['take', h.decoder.decoderSessionId], ['restore', 'legacy-expired']]);
  assert.equal(h.owner.owns(h.decoder.decoderSessionId), false);
});

test('decoder cannot write during take and a concurrent disconnect restores after commit', async () => {
  let finishTake;
  const entered = new Promise((resolve) => { finishTake = resolve; });
  const now = 0;
  const leaseManager = createLeaseManager({ clock: { now: () => now },
    tokenFactory: () => 'lease-pending' });
  const sessions = createDecoderSessionRegistry({ tokenFactory: () => 'pending-session' });
  const decoder = sessions.attach({}); const trace = [];
  const legacyAccess = createLegacyWriteAccess();
  const owner = createAudioOwnerController({ leaseManager, sessionRegistry: sessions,
    maintenanceAuth: { verify: () => true }, legacyAccess, clock: { now: () => now },
    controlBarrier: { async enterLegacy() { trace.push('take.begin'); await entered;
      legacyAccess.allowExactGeneration(decoder.decoderSessionId); trace.push('take.commit'); },
    async restoreWorld() { legacyAccess.rejectWrites(); trace.push('restore'); } } });
  const request = { maintenanceToken: 'authorized', clientId: 'runtime',
    connectionGeneration: '1', decoderSessionId: decoder.decoderSessionId };
  const taking = owner.takeLegacy(request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owner.owns(decoder.decoderSessionId), false);
  const disconnecting = owner.decoderDisconnected(decoder.decoderSessionId);
  finishTake();
  await taking; await disconnecting;
  assert.deepEqual(trace, ['take.begin', 'take.commit', 'restore']);
  assert.equal(owner.owns(decoder.decoderSessionId), false);
});
