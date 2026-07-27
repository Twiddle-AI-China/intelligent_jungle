import assert from 'node:assert/strict';
import test from 'node:test';

import { projectAgentStatus } from '../../src/agents/status-projector.js';

test('agent public state is recursively frozen and allowlisted', () => {
  const projected = projectAgentStatus({
    species: {
      enabled: false, status: 'gated', source: 'policy', reason: 'telemetry_unknown',
      requestId: 'r1', latencyMs: 12, circuitState: 'closed', prompt: 'secret', endpoint: 'http://127.0.0.1:8081',
    },
    master: {
      enabled: true, status: 'ok', source: 'llm', reason: null,
      requestId: 'r1', latencyMs: 20, circuitState: 'closed', Authorization: 'Bearer secret',
    },
    lastDecision: {
      requestId: 'r1', scheduleSeq: 1, reviewedDay: 2,
      applyBoundary: { kind: 'dawn', day: 3 },
      species: { source: 'policy', status: 'gated', reason: 'telemetry_unknown', value: { private: true } },
      master: { source: 'llm', status: 'ok', reason: 'OK', value: { private: true } },
    },
  });
  assert.deepEqual(Object.keys(projected.species), [
    'enabled', 'status', 'source', 'reason', 'requestId', 'latencyMs', 'circuitState',
  ]);
  assert.equal(projected.species.source, 'policy');
  assert.equal(projected.lastDecision.master.source, 'llm');
  assert.equal(Object.hasOwn(projected.lastDecision.master, 'value'), false);
  assert.equal(Object.isFrozen(projected.lastDecision.master), true);
  const json = JSON.stringify(projected);
  for (const forbidden of ['Authorization', 'prompt', 'private', '8081', 'Bearer secret']) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
});

test('unknown values cannot smuggle secrets through allowed fields', () => {
  const projected = projectAgentStatus({
    species: {
      enabled: true, status: 'Bearer secret', source: 'raw',
      reason: 'SK_ABC123_SUPER_SECRET_TOKEN', requestId: 'secret with spaces',
      latencyMs: Number.NaN, circuitState: 'prompt secret',
    },
  });
  assert.deepEqual(projected.species, {
    enabled: true, status: 'disabled', source: 'policy', reason: 'status_unavailable',
    requestId: null, latencyMs: null, circuitState: 'closed',
  });
});
