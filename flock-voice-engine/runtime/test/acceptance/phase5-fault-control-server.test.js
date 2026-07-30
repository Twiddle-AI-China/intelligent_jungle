import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPhase5FaultControlServer,
  Phase5FaultControlServerError,
} from '../../src/acceptance/phase5-fault-control-server.js';
import {
  decodePhase5FaultControlResponse,
  encodePhase5FaultControlRequest,
} from '../../src/acceptance/phase5-fault-control-protocol.js';

const PEER = Object.freeze({
  pid: 1234,
  uid: 1000,
  socketInode: 5678,
  admissionChallenge: 'a'.repeat(64),
});

function authorityFixture() {
  let eventSequence = 0;
  const calls = [];
  const authority = Object.freeze({
    getAdmission() { return {}; },
    appendTransportObservation() {},
    advance() {
      eventSequence += 1;
      calls.push(['advance', eventSequence]);
      return { sequence: eventSequence };
    },
    closeFaultWindow() {
      calls.push(['close-window']);
      return Buffer.from('{"closed":true}', 'utf8');
    },
    finalizeCapture() {},
  });
  return { authority, calls };
}

function fixture() {
  const value = authorityFixture();
  const clientRegistry = Object.freeze({
    getInitialCapabilities() { return Object.freeze([]); },
    claim() {},
    close() {},
    terminate() {},
  });
  return {
    ...value,
    server: createPhase5FaultControlServer({
      authority: value.authority,
      clientRegistry,
      expectedPeer: { ...PEER },
    }),
  };
}

function errorCode(code) {
  return (error) => (
    error instanceof Phase5FaultControlServerError
    && error.code === code
  );
}

function request(kind, sequence) {
  return encodePhase5FaultControlRequest({
    schemaVersion: 1,
    kind,
    sequence,
  });
}

test('one exact peer owns the connection and a second peer is rejected', () => {
  const { server } = fixture();
  assert.deepEqual(server.acceptPeer({ ...PEER }).clientCapabilities, []);
  assert.throws(
    () => server.acceptPeer({ ...PEER }),
    errorCode('PHASE5_FAULT_CONTROL_SECOND_CONNECTION'),
  );
});

test('credential or admission mismatch consumes the listener before requests', () => {
  for (const field of ['pid', 'uid', 'socketInode', 'admissionChallenge']) {
    const { server } = fixture();
    const peer = { ...PEER };
    peer[field] = field === 'admissionChallenge' ? 'b'.repeat(64) : peer[field] + 1;
    assert.throws(
      () => server.acceptPeer(peer),
      errorCode('PHASE5_FAULT_CONTROL_PEER_INVALID'),
    );
    assert.throws(
      () => server.handleRequestBytes(request(
        'phase5-fault-control-advance',
        1,
      )),
      errorCode('PHASE5_FAULT_CONTROL_WINDOW_INACTIVE'),
    );
  }
});

test('advance sequence is continuous and contains only authority event bytes', () => {
  const { server, calls } = fixture();
  server.acceptPeer({ ...PEER });
  const response = decodePhase5FaultControlResponse(
    server.handleRequestBytes(request(
      'phase5-fault-control-advance',
      1,
    )),
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(response.result.eventBase64, 'base64')),
    { sequence: 1 },
  );
  assert.deepEqual(calls, [['advance', 1]]);
  assert.throws(
    () => server.handleRequestBytes(request(
      'phase5-fault-control-advance',
      1,
    )),
    errorCode('PHASE5_FAULT_CONTROL_SEQUENCE_INVALID'),
  );
});

test('close-window returns exact bytes and permanently closes request handling', () => {
  const { server, calls } = fixture();
  server.acceptPeer({ ...PEER });
  const response = decodePhase5FaultControlResponse(
    server.handleRequestBytes(request(
      'phase5-fault-control-close-window',
      1,
    )),
  );
  assert.equal(
    Buffer.from(response.result.faultEventsBase64, 'base64').toString('utf8'),
    '{"closed":true}',
  );
  assert.deepEqual(calls, [['close-window']]);
  assert.throws(
    () => server.handleRequestBytes(request(
      'phase5-fault-control-advance',
      2,
    )),
    errorCode('PHASE5_FAULT_CONTROL_WINDOW_INACTIVE'),
  );
});

test('async advance rejects a concurrent request instead of queueing it', async () => {
  let resolveAdvance;
  const authority = Object.freeze({
    getAdmission() { return {}; }, appendTransportObservation() {},
    advance() { return new Promise((resolve) => { resolveAdvance = resolve; }); },
    closeFaultWindow() { return Buffer.from('{}'); }, finalizeCapture() {},
  });
  const clientRegistry = Object.freeze({
    getInitialCapabilities() { return []; }, claim() {}, close() {}, terminate() {},
  });
  const server = createPhase5FaultControlServer({
    authority, clientRegistry, expectedPeer: { ...PEER },
  });
  server.acceptPeer({ ...PEER });
  const pending = server.handleRequestBytes(request(
    'phase5-fault-control-advance', 1));
  assert.throws(() => server.handleRequestBytes(request(
    'phase5-fault-control-advance', 2)),
  errorCode('PHASE5_FAULT_CONTROL_CONCURRENT_REQUEST'));
  resolveAdvance({ sequence: 1 });
  await assert.rejects(pending);
});
