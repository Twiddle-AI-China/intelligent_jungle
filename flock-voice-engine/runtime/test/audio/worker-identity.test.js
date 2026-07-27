import test from 'node:test';
import assert from 'node:assert/strict';

import { assertExactWorkerIdentity, compareWorkerIdentity } from '../../src/audio/worker-identity.js';

const expected = Object.freeze({
  releaseRevision: '1'.repeat(40),
  sourceManifestSha256: '2'.repeat(64),
  protocolFamily: 'flock-audio-ipc',
  protocolVersion: 1,
  audioArtifactKind: 'release-artifact',
  audioArtifactSha256: '3'.repeat(64),
});

const CASES = [
  ['releaseRevision', '0'.repeat(40), 'WORKER_IDENTITY_RELEASE_MISMATCH'],
  ['sourceManifestSha256', '0'.repeat(64), 'WORKER_IDENTITY_SOURCE_MANIFEST_MISMATCH'],
  ['protocolFamily', 'other', 'WORKER_IDENTITY_PROTOCOL_FAMILY_MISMATCH'],
  ['protocolVersion', 2, 'WORKER_IDENTITY_PROTOCOL_VERSION_MISMATCH'],
  ['audioArtifactKind', 'vendor-tree', 'WORKER_IDENTITY_ARTIFACT_KIND_MISMATCH'],
  ['audioArtifactSha256', '0'.repeat(64), 'WORKER_IDENTITY_AUDIO_ARTIFACT_MISMATCH'],
];

test('worker identity exact tuple matches', () => {
  assert.deepEqual(compareWorkerIdentity(expected, { ...expected }), { ok: true, reason: null });
  assert.doesNotThrow(() => assertExactWorkerIdentity(expected, expected));
});

for (const [field, value, reason] of CASES) {
  test(`${field} mismatch is isolated with a stable reason`, () => {
    const reported = { ...expected, [field]: value };
    assert.deepEqual(compareWorkerIdentity(expected, reported), { ok: false, reason });
    assert.throws(() => assertExactWorkerIdentity(expected, reported), new RegExp(reason));
  });
}

test('missing reported identity fails closed at the first field', () => {
  assert.equal(compareWorkerIdentity(expected, undefined).reason, 'WORKER_IDENTITY_RELEASE_MISMATCH');
});
