import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePhase5FaultControlRequest,
  encodePhase5FaultControlResponse,
} from '../../src/acceptance/phase5-fault-control-protocol.js';
import {
  createPhase5FaultControlClient,
  Phase5FaultControlClientError,
} from '../../tools/lib/phase5-fault-control-client.mjs';

function errorCode(code) {
  return (error) => (
    error instanceof Phase5FaultControlClientError
    && error.code === code
  );
}

test('client owns sequence and exposes only zero-argument operations', async () => {
  const requests = [];
  const client = createPhase5FaultControlClient({
    async sendRequestBytes(bytes) {
      const request = decodePhase5FaultControlRequest(bytes);
      requests.push(request);
      return encodePhase5FaultControlResponse({
        schemaVersion: 1,
        kind: request.kind === 'phase5-fault-control-advance'
          ? 'phase5-fault-control-advance-response'
          : 'phase5-fault-control-close-window-response',
        sequence: request.sequence,
        result: request.kind === 'phase5-fault-control-advance'
          ? { eventBase64: Buffer.from('{}').toString('base64') }
          : { faultEventsBase64: Buffer.from('{}').toString('base64') },
      });
    },
  });

  await client.advance();
  await client.advance();
  await client.closeWindow();
  assert.deepEqual(requests.map(({ sequence }) => sequence), [1, 2, 3]);
  assert.deepEqual(Object.keys(client).sort(), ['advance', 'closeWindow']);
  await assert.rejects(
    client.advance(),
    errorCode('PHASE5_FAULT_CONTROL_CLIENT_TERMINAL'),
  );
});

test('concurrent, replayed or cross-kind responses permanently fail closed', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const client = createPhase5FaultControlClient({
    async sendRequestBytes() {
      return pending;
    },
  });
  const first = client.advance();
  await assert.rejects(
    client.advance(),
    errorCode('PHASE5_FAULT_CONTROL_CLIENT_CONCURRENT'),
  );
  release(encodePhase5FaultControlResponse({
    schemaVersion: 1,
    kind: 'phase5-fault-control-advance-response',
    sequence: 1,
    result: { eventBase64: Buffer.from('{}').toString('base64') },
  }));
  await assert.rejects(first);
});

test('caller cannot inject operation, target or request sequence', () => {
  const client = createPhase5FaultControlClient({
    async sendRequestBytes() {
      throw new Error('must not send');
    },
  });
  assert.throws(
    () => client.advance({ operation: 'kill', target: 'anything' }),
    errorCode('PHASE5_FAULT_CONTROL_CLIENT_INPUT_INVALID'),
  );
});
