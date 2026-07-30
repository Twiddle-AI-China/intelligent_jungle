import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePhase5FaultControlCompletion,
  decodePhase5FaultControlInstruction,
  decodePhase5FaultControlAdmission,
  MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES,
  Phase5FaultControlProtocolError,
  decodePhase5FaultControlRequest,
  decodePhase5FaultControlResponse,
  encodePhase5FaultControlAdmission,
  encodePhase5FaultControlCompletion,
  encodePhase5FaultControlInstruction,
  encodePhase5FaultControlRequest,
  encodePhase5FaultControlResponse,
} from '../../src/acceptance/phase5-fault-control-protocol.js';

function errorCode(code) {
  return (error) => (
    error instanceof Phase5FaultControlProtocolError
    && error.code === code
  );
}

test('request vocabulary is exact, canonical and parameter-free', () => {
  for (const kind of [
    'phase5-fault-control-advance',
    'phase5-fault-control-close-window',
  ]) {
    const request = { schemaVersion: 1, kind, sequence: 1 };
    const bytes = encodePhase5FaultControlRequest(request);
    assert.equal(bytes.at(-1), 0x0a);
    assert.deepEqual(decodePhase5FaultControlRequest(bytes), request);
    for (const field of [
      'operation', 'target', 'receipt', 'shell', 'argv', 'pid',
      'container', 'socketPath', 'url', 'fixture', 'timestamp',
    ]) {
      assert.throws(
        () => encodePhase5FaultControlRequest({
          ...request,
          [field]: 'attacker-controlled',
        }),
        errorCode('PHASE5_FAULT_CONTROL_REQUEST_INVALID'),
      );
    }
  }
});

test('request rejects duplicate keys, whitespace, tail and oversize bytes', () => {
  const canonical = encodePhase5FaultControlRequest({
    schemaVersion: 1,
    kind: 'phase5-fault-control-advance',
    sequence: 1,
  });
  const attacks = [
    Buffer.from(` ${canonical.toString('utf8')}`),
    Buffer.concat([canonical, Buffer.from('\n')]),
    Buffer.from('{"kind":"phase5-fault-control-advance","kind":"phase5-fault-control-advance","schemaVersion":1,"sequence":1}\n'),
    Buffer.alloc(MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES + 1, 0x20),
  ];
  for (const bytes of attacks) {
    assert.throws(
      () => decodePhase5FaultControlRequest(bytes),
      errorCode('PHASE5_FAULT_CONTROL_REQUEST_INVALID'),
    );
  }
});

test('response carries only canonical event or closure bytes', () => {
  const eventBytes = Buffer.from('{"sequence":1}', 'utf8');
  const closeBytes = Buffer.from('{"closure":true}', 'utf8');
  const values = [{
    schemaVersion: 1,
    kind: 'phase5-fault-control-advance-response',
    sequence: 1,
    result: { eventBase64: eventBytes.toString('base64') },
  }, {
    schemaVersion: 1,
    kind: 'phase5-fault-control-close-window-response',
    sequence: 2,
    result: { faultEventsBase64: closeBytes.toString('base64') },
  }];
  for (const value of values) {
    assert.deepEqual(
      decodePhase5FaultControlResponse(
        encodePhase5FaultControlResponse(value),
      ),
      value,
    );
  }
});

test('controller admission binds role challenge and listener inode only', () => {
  const value = {
    schemaVersion: 1,
    kind: 'phase5-fault-control-admission',
    role: 'runtime',
    challenge: 'a'.repeat(64),
    socketInode: 42,
  };
  assert.deepEqual(
    decodePhase5FaultControlAdmission(
      encodePhase5FaultControlAdmission(value),
    ),
    value,
  );
  for (const field of ['pid', 'uid', 'operation', 'target', 'window']) {
    assert.throws(
      () => encodePhase5FaultControlAdmission({
        ...value,
        [field]: 1,
      }),
      errorCode('PHASE5_FAULT_CONTROL_ADMISSION_INVALID'),
    );
  }
});

test('fixed instruction binds signed action bytes and one reconnect grant', () => {
  const event = Buffer.from('{"sequence":20}', 'utf8').toString('base64');
  for (const sequence of [1, 5, 6, 13]) {
    const value = {
      schemaVersion: 1,
      kind: 'phase5-fixed-instruction',
      sequence,
      actionEventBase64: event,
      runtimeCapability: null,
    };
    assert.deepEqual(decodePhase5FaultControlInstruction(
      encodePhase5FaultControlInstruction(value)), value);
  }
  for (const sequence of [4, 8]) {
    const value = {
      schemaVersion: 1,
      kind: 'phase5-fixed-instruction',
      sequence,
      actionEventBase64: event,
      runtimeCapability: 'a'.repeat(43),
    };
    assert.deepEqual(decodePhase5FaultControlInstruction(
      encodePhase5FaultControlInstruction(value)), value);
  }
  assert.throws(() => encodePhase5FaultControlInstruction({
    schemaVersion: 1,
    kind: 'phase5-fixed-instruction',
    sequence: 5,
    actionEventBase64: event,
    runtimeCapability: 'a'.repeat(43),
  }), errorCode('PHASE5_FAULT_CONTROL_INSTRUCTION_INVALID'));
});

test('instruction completion is exact and action-event bound', () => {
  const value = {
    schemaVersion: 1,
    kind: 'phase5-fixed-instruction-complete',
    sequence: 5,
    actionEventSha256: 'b'.repeat(64),
    accepted: true,
  };
  assert.deepEqual(decodePhase5FaultControlCompletion(
    encodePhase5FaultControlCompletion(value)), value);
  assert.throws(() => encodePhase5FaultControlCompletion({
    ...value, accepted: false,
  }), errorCode('PHASE5_FAULT_CONTROL_COMPLETION_INVALID'));
});
