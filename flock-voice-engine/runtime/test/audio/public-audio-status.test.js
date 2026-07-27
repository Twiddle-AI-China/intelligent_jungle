import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicAudioStatusStore } from '../../src/audio/public-audio-status.js';
import { normalizeAudioStatusFrame, normalizeMixCommandPayload } from '../../src/protocol/v1.js';

test('public audio status is frozen, monotonic, and observer-isolated', async () => {
  const store = createPublicAudioStatusStore();
  const seen = []; store.subscribe((value) => seen.push(value.statusRevision));
  await store.update({ workerReady: true }); await store.update({ recovering: false });
  assert.deepEqual(seen, [1, 2]); assert.equal(store.get().statusRevision, 2);
  assert.ok(Object.isFrozen(store.get()));
});

test('ready guard, deferred flush, and publication share one mailbox operation', async () => {
  let degraded = false;
  const session = { runExclusive(_kind, operation) { degraded = true; return operation(); } };
  const store = createPublicAudioStatusStore({ session });
  const blocked = await store.guardedUpdate({ workerReady: true }, () => !degraded,
    () => ({ accepted: true }));
  assert.equal(blocked.updated, false);
  assert.equal(store.get().workerReady, false);
  assert.equal(store.get().statusRevision, 0);

  const ordered = [];
  const direct = createPublicAudioStatusStore();
  const published = await direct.guardedUpdate({ workerReady: true }, () => {
    ordered.push('guard'); return true;
  }, () => { ordered.push('flush'); return { accepted: true }; });
  ordered.push('published');
  assert.equal(published.updated, true);
  assert.deepEqual(ordered, ['guard', 'flush', 'published']);
  assert.equal(direct.get().workerReady, true);
});

test('server-owned mix payloads are strict and bounded', () => {
  assert.deepEqual(normalizeMixCommandPayload('mix.setParam', {
    species: 'pad', param: 'eq', value: { low: -2, mid: 1, high: 3 },
  }), { species: 'pad', param: 'eq', value: { low: -2, mid: 1, high: 3 } });
  assert.deepEqual(normalizeMixCommandPayload('mix.setMute', { species: 'texture', muted: true }),
    { species: 'texture', muted: true });
  assert.equal(normalizeMixCommandPayload('mix.setParam', {
    species: 'pad', param: 'eq', value: { low: -20, mid: 1, high: 3 },
  }), null);
});

test('audio.status validator accepts only the documented public geometry DTO', () => {
  const frame = { type: 'audio.status', protocolVersion: 1, statusRevision: 3,
    runtimeOwner: 'server', audioOwner: 'world', workerReady: true, recovering: false,
    degraded: false, degradedReason: null, audio: { audioEpoch: 'e',
      manifestGeometrySha256: 'a'.repeat(64), sampleRate: 48000, blockFrames: 2048,
      channels: 2, format: 'f32le', binaryHeaderVersion: 1, headerBytes: 32 } };
  assert.deepEqual(normalizeAudioStatusFrame(frame), frame);
  assert.equal(normalizeAudioStatusFrame({ ...frame, audioOwner: 'local-guess' }), null);
  assert.equal(normalizeAudioStatusFrame({ ...frame, audio: { ...frame.audio, channels: 1 } }), null);
});
