import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { loadRuntimeConfig, RUNTIME_PROFILES } from '../src/config.js';
import { createCandidateServer } from '../src/server.js';

test('runtime profiles are fixed and production is unavailable to the local gate', () => {
  assert.deepEqual(loadRuntimeConfig({ FLOCK_RUNTIME_PROFILE: 'container-local' }), {
    host: '0.0.0.0', port: 8090, phaseGate: 'phase5-local',
    runtimeOwner: 'server', audioOwner: 'world', allowedOrigin: 'http://127.0.0.1:4193',
  });
  assert.throws(() => loadRuntimeConfig({ FLOCK_RUNTIME_PROFILE: 'production' }), /RUNTIME_PROFILE_REJECTED/);
  assert.throws(() => loadRuntimeConfig({ PORT: '8090' }), /PHASE_5_LOCAL_CONFIG_REJECTED/);
  assert.equal(Object.isFrozen(RUNTIME_PROFILES), true);
});

test('readyz exposes the exact expected and reported worker identity', async (context) => {
  const identity = Object.freeze({ releaseRevision: 'a'.repeat(40), sourceManifestSha256: 'b'.repeat(64),
    protocolFamily: 'flock-audio-ipc', protocolVersion: 1,
    audioArtifactKind: 'release-artifact', audioArtifactSha256: 'c'.repeat(64) });
  const audio = { workerReady: true, recovering: false, degraded: false,
    runtimeOwner: 'server', audioOwner: 'world' };
  const server = createCandidateServer({ releaseInfo: { runtimeOwner: 'server', audioOwner: 'world' },
    audioStatusStore: { get: () => audio },
    getAudioSupervisorStatus: () => ({ expectedIdentity: identity, reportedIdentity: identity,
      commandAudit: [{ commandSeq: 7, commands: [{ type: 'note.on', row: 2, secret: 'drop' }] }],
      telemetry: { renderP95Ms: 1, renderP99Ms: 2, blockDurationMs: 92,
        recentUnderruns: 0, pcmHeadroomBlocks: 2, queueDepth: 0,
        unifiedMemoryFreeBytes: 1024, appliedCommandSeq: 7,
        rowMasterContributionPeakAbs: [.1, .2, .3, .4, .5] } }),
    phaseGate: 'phase5-local' });
  context.after(() => server.close());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/readyz`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.workerIdentity, { expected: identity, reported: identity });
  assert.deepEqual(body.audioCommandAudit,
    [{ commandSeq: 7, commands: [{ type: 'note.on', row: 2 }] }]);
  assert.equal(body.workerTelemetry.appliedCommandSeq, 7);
  assert.equal(body.runtimeOwner, 'server'); assert.equal(body.audioOwner, 'world');
});
