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
  const releaseInfo = loadReleaseInfo({
    FLOCK_RELEASE_REVISION: 'unknown',
    FLOCK_SOURCE_MANIFEST_SHA256: 'unknown',
  });
  assert.equal(releaseInfo.releaseRevision, 'unknown');
  assert.equal(releaseInfo.protocolFamily, 'flock-runtime');
  assert.equal(releaseInfo.protocolVersion, 1);

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

test('exposes Phase 5 ownership while keeping readiness behind missing-audio gate', async (context) => {
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
  assert.equal(health.body.runtimeOwner, 'server');
  assert.equal(health.body.audioOwner, 'world');
  assert.equal(health.body.protocolFamily, 'flock-runtime');
  assert.equal(health.body.protocolVersion, 1);
  assert.equal(health.body.workerReady, false);
  assert.equal(ready.status, 503);
  assert.equal(ready.body.phaseGate, 'shadow-no-audio');
  assert.equal(ready.body.workerReady, false);
});

test('health agent provider state is allowlisted and hides internal provider data', async (context) => {
  const releaseInfo = loadReleaseInfo({
    FLOCK_RELEASE_REVISION: 'unknown', FLOCK_SOURCE_MANIFEST_SHA256: 'unknown',
  });
  const server = createCandidateServer({
    releaseInfo,
    getAgentState: () => ({
      species: { enabled: false, status: 'gated', source: 'policy', reason: 'telemetry_unknown', circuitState: 'closed', prompt: 'secret' },
      master: { enabled: true, status: 'Bearer secret', source: 'llm', reason: 'SK_ABC123_SUPER_SECRET_TOKEN', circuitState: 'prompt secret', Authorization: 'Bearer secret' },
      lastDecision: { rawResponse: 'secret', endpoint: 'http://127.0.0.1:8081' },
    }),
  });
  context.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const health = await requestJson(`http://127.0.0.1:${address.port}`, '/healthz');
  assert.equal(health.body.agentProviders.species.reason, 'telemetry_unknown');
  assert.equal(health.body.agentProviders.master.source, 'llm');
  assert.equal(health.body.agentProviders.master.status, 'disabled');
  assert.equal(health.body.agentProviders.master.reason, 'status_unavailable');
  assert.equal(health.body.agentProviders.master.circuitState, 'closed');
  const serialized = JSON.stringify(health.body);
  for (const forbidden of ['Authorization', 'prompt', 'rawResponse', '8081', 'Bearer secret', 'SK_ABC123']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
