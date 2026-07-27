import assert from 'node:assert/strict';
import test from 'node:test';

import { projectAgentStatus } from '../../src/agents/status-projector.js';

test('snapshot and decision projection never expose provider or model payloads', () => {
  const internal = {
    species: { enabled: true, status: 'ok', source: 'llm', reason: null, requestId: 'r1', latencyMs: 5, circuitState: 'closed' },
    master: { enabled: true, status: 'provider_error', source: 'policy', reason: 'HTTP_500', requestId: 'r1', latencyMs: 9, circuitState: 'open' },
    lastDecision: {
      requestId: 'r1', scheduleSeq: 1, reviewedDay: 1, applyBoundary: { kind: 'dawn', day: 2 },
      species: { source: 'llm', status: 'ok', reason: null, value: { flocks: [{ rawResponse: 'secret' }] } },
      master: { source: 'policy', status: 'provider_error', reason: 'HTTP_500', value: { prompt: 'secret' } },
    },
    apiKey: 'server-only', backendRow: 17, pcaBasis: [1, 2], leaseToken: 'secret',
  };
  const json = JSON.stringify(projectAgentStatus(internal));
  for (const forbidden of [
    'apiKey', 'server-only', 'rawResponse', 'prompt', 'backendRow',
    'pcaBasis', 'leaseToken', '8081', 'api.deepseek.com',
  ]) assert.equal(json.includes(forbidden), false, forbidden);
});
