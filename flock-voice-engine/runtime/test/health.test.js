import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { loadReleaseInfo } from '../src/release-info.js';
import { createCandidateServer } from '../src/server.js';

async function requestJson(origin, path) {
  const response = await fetch(`${origin}${path}`);
  return {
    status: response.status,
    body: await response.json(),
  };
}

test('accepts only an honest unknown pair or a complete pinned release identity', () => {
  assert.equal(loadReleaseInfo({
    FLOCK_RELEASE_REVISION: 'unknown',
    FLOCK_SOURCE_MANIFEST_SHA256: 'unknown',
  }).releaseRevision, 'unknown');

  assert.doesNotThrow(() => loadReleaseInfo({
    FLOCK_RELEASE_REVISION: 'a'.repeat(40),
    FLOCK_SOURCE_MANIFEST_SHA256: 'b'.repeat(64),
  }));

  for (const env of [
    {},
    {
      FLOCK_RELEASE_REVISION: 'a'.repeat(40),
      FLOCK_SOURCE_MANIFEST_SHA256: 'unknown',
    },
    {
      FLOCK_RELEASE_REVISION: 'unknown',
      FLOCK_SOURCE_MANIFEST_SHA256: 'b'.repeat(64),
    },
    {
      FLOCK_RELEASE_REVISION: 'not-a-revision',
      FLOCK_SOURCE_MANIFEST_SHA256: 'b'.repeat(64),
    },
    {
      FLOCK_RELEASE_REVISION: 'a'.repeat(40),
      FLOCK_SOURCE_MANIFEST_SHA256: 'not-a-manifest',
    },
  ]) {
    assert.throws(() => loadReleaseInfo(env), /RELEASE_IDENTITY_PAIR_REQUIRED/);
  }
});

test('exposes health while keeping readiness behind the shadow-no-audio gate', async (context) => {
  const releaseInfo = loadReleaseInfo({
    FLOCK_RELEASE_REVISION: 'unknown',
    FLOCK_SOURCE_MANIFEST_SHA256: 'unknown',
  });
  const server = createCandidateServer({ releaseInfo });
  context.after(() => server.close());

  assert.equal(server.listening, false);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const health = await requestJson(origin, '/healthz');
  const ready = await requestJson(origin, '/readyz');

  assert.equal(health.status, 200);
  assert.equal(health.body.releaseRevision, 'unknown');
  assert.equal(health.body.sourceManifestSha256, 'unknown');
  assert.equal(health.body.runtimeOwner, 'browser');
  assert.equal(health.body.audioOwner, 'legacy');
  assert.equal(health.body.workerReady, false);
  assert.equal(ready.status, 503);
  assert.equal(ready.body.phaseGate, 'shadow-no-audio');
  assert.equal(ready.body.workerReady, false);
});
