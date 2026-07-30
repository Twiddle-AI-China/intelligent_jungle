import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePhase5FaultControlRequest,
  encodePhase5FaultControlResponse,
} from '../../src/acceptance/phase5-fault-control-protocol.js';
import { signedFixture } from './phase5-fault-validation-fixture.js';
import {
  createPhase5SoakOrchestrator,
} from '../../tools/lib/phase5-soak-orchestrator.mjs';

test('raw-only orchestrator runs 35 fixed phases, waits for sampling, then closes', async () => {
  const evidence = signedFixture().evidence;
  const calls = [];
  let samplingReleased;
  const samplingDone = new Promise((resolve) => { samplingReleased = resolve; });
  const controllerSession = {
    async receiveAdmission() {
      calls.push('admission');
      return { descriptor: { binding: {}, window: {} }, clientCapabilities: [] };
    },
    async sendRequestBytes(bytes) {
      const request = decodePhase5FaultControlRequest(bytes);
      calls.push(`${request.kind}:${request.sequence}`);
      if (request.kind === 'phase5-fault-control-close-window') {
        return encodePhase5FaultControlResponse({ schemaVersion: 1,
          kind: 'phase5-fault-control-close-window-response', sequence: request.sequence,
          result: { faultEventsBase64: Buffer.from(JSON.stringify(evidence)).toString('base64') } });
      }
      if (request.sequence === 35) samplingReleased('sampled');
      return encodePhase5FaultControlResponse({ schemaVersion: 1,
        kind: 'phase5-fault-control-advance-response', sequence: request.sequence,
        result: { eventBase64: Buffer.from('{}').toString('base64') } });
    },
  };
  let closed = 0;
  const orchestrator = createPhase5SoakOrchestrator({
    controllerSession,
    async openClients() {
      calls.push('open');
      return { async handleInstruction() {}, async close() { closed += 1; } };
    },
    async sampleWindow() { calls.push('sample'); return samplingDone; },
    async finalizeAndPublish(value) {
      calls.push('publish');
      assert.equal(value.sampled, 'sampled');
      assert.equal(value.signedClientProjection.runId, evidence.runId);
      return 'published';
    },
  });
  assert.equal(await orchestrator.run(), 'published');
  assert.equal(closed, 1);
  assert.equal(calls.at(-1), 'publish');
  assert.equal(calls.filter((value) => value.startsWith(
    'phase5-fault-control-advance')).length, 35);
  assert.equal(calls.at(-2), 'phase5-fault-control-close-window:36');
});
