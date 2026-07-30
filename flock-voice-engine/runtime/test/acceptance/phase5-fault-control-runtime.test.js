import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  _createPhase5ClientRegistry,
} from '../../src/acceptance/phase5-client-registry.js';
import {
  encodePhase5FaultControlAdmission,
  decodePhase5FaultControlInstruction,
  encodePhase5FaultControlCompletion,
  encodePhase5FaultControlRequest,
} from '../../src/acceptance/phase5-fault-control-protocol.js';
import {
  _createPhase5FaultControlRuntime,
} from '../../src/acceptance/phase5-fault-control-runtime.js';
import {
  createPhase5FaultInstructionChannel,
} from '../../src/acceptance/phase5-fault-instruction-channel.js';
import {
  createPhase5FaultSessionAuthority,
} from '../../src/acceptance/phase5-fault-session-authority.js';
import {
  signedFixture,
} from '../tools/phase5-fault-validation-fixture.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
  }

  write(bytes, callback) {
    this.writes.push(Buffer.from(bytes));
    callback?.();
    return true;
  }

  destroy() {
    this.destroyed = true;
  }
}

function fixture({ asyncPayload = false } = {}) {
  const source = signedFixture().evidence;
  let cursor = 0;
  const authority = createPhase5FaultSessionAuthority({
    identity: {
      runId: source.runId,
      challenge: source.challenge,
      release: structuredClone(source.release),
      geometry: structuredClone(source.geometry),
      profile: structuredClone(source.profile),
    },
    captureNonceBytes: Buffer.alloc(32, 7),
  });
  const bridge = Object.freeze({
    flushTransportObservations() { return []; },
    payloadFor(plan) {
      const event = source.scenarioEvents[cursor];
      assert.equal(plan.scenario, event.scenario);
      assert.equal(plan.phase, event.phase);
      cursor += 1;
      const value = {
        atMonotonicMs: event.atMonotonicMs,
        atUnixMs: event.atUnixMs,
        payload: structuredClone(event.payload),
      };
      return asyncPayload ? new Promise(() => {}) : value;
    },
    commitSignedAction() {},
    dispatchFixedInstruction() {},
  });
  let randomCounter = 0;
  const clientRegistry = _createPhase5ClientRegistry({
    runId: source.runId,
    randomBytes(size) {
      randomCounter += 1;
      return Buffer.alloc(size, randomCounter);
    },
  });
  const instructionChannel = Object.freeze({
    instructionSink: Object.freeze({ dispatch() {} }),
    bindTransport() {},
    acceptCompletion() { throw new Error('unexpected completion'); },
    close() {},
  });
  return { source, authority, bridge, clientRegistry, instructionChannel };
}

test('runtime verifies the listener ABA and admission before exposing grants', () => {
  const value = fixture();
  const socket = new FakeSocket();
  const runtime = _createPhase5FaultControlRuntime({
    authority: value.authority,
    clientRegistry: value.clientRegistry,
    bridge: value.bridge,
    instructionChannel: value.instructionChannel,
    onActivated() {},
    connect: () => socket,
    lstat: () => ({ ino: 91, mode: 0o140600, uid: 1000 }),
    monotonicNow: () => value.source.window.startedAtMonotonicMs,
    unixNow: () => value.source.window.startedAtUnixMs,
    pid: 4242,
    uid: 1000,
  });
  runtime.start();
  socket.emit('connect');
  assert.deepEqual(socket.writes, []);
  socket.emit('data', encodePhase5FaultControlAdmission({
    schemaVersion: 1,
    kind: 'phase5-fault-control-admission',
    role: 'runtime',
    challenge: value.source.challenge,
    socketInode: 91,
  }));
  assert.equal(socket.writes.length, 1);
  const admission = JSON.parse(socket.writes[0]);
  assert.equal(admission.kind, 'phase5-fault-control-admission-response');
  assert.equal(admission.clientCapabilities.length, 4);
  assert.deepEqual(admission.descriptor, {
    binding: {
      runId: value.source.runId,
      challenge: value.source.challenge,
      release: value.source.release,
      geometry: value.source.geometry,
      profile: value.source.profile,
    },
    window: value.source.window,
  });
  assert.equal(admission.admission.signerSpkiSha256,
    value.authority.getAdmission().signerSpkiSha256);

  socket.emit('data', encodePhase5FaultControlRequest({
    schemaVersion: 1,
    kind: 'phase5-fault-control-advance',
    sequence: 1,
  }));
  assert.equal(socket.writes.length, 2);
  const response = JSON.parse(socket.writes[1]);
  assert.equal(response.kind, 'phase5-fault-control-advance-response');
  assert.equal(response.sequence, 1);
});

test('runtime consumes pipelined bytes while an async predicate is pending', () => {
  const value = fixture({ asyncPayload: true });
  const socket = new FakeSocket();
  const runtime = _createPhase5FaultControlRuntime({
    authority: value.authority,
    clientRegistry: value.clientRegistry,
    bridge: value.bridge,
    instructionChannel: value.instructionChannel,
    onActivated() {},
    connect: () => socket,
    lstat: () => ({ ino: 91, mode: 0o140600, uid: 1000 }),
    monotonicNow: () => value.source.window.startedAtMonotonicMs,
    unixNow: () => value.source.window.startedAtUnixMs,
    pid: 4242,
    uid: 1000,
  });
  runtime.start();
  socket.emit('connect');
  socket.emit('data', encodePhase5FaultControlAdmission({
    schemaVersion: 1,
    kind: 'phase5-fault-control-admission',
    role: 'runtime',
    challenge: value.source.challenge,
    socketInode: 91,
  }));
  const first = encodePhase5FaultControlRequest({
    schemaVersion: 1,
    kind: 'phase5-fault-control-advance',
    sequence: 1,
  });
  const second = encodePhase5FaultControlRequest({
    schemaVersion: 1,
    kind: 'phase5-fault-control-advance',
    sequence: 2,
  });
  socket.emit('data', Buffer.concat([first, second]));
  assert.equal(socket.destroyed, true);
  assert.equal(socket.writes.length, 1);
});

test('runtime consumes the channel on inode or challenge mismatch', () => {
  for (const mismatch of ['inode', 'challenge']) {
    const value = fixture();
    const socket = new FakeSocket();
    let statCalls = 0;
    const runtime = _createPhase5FaultControlRuntime({
      authority: value.authority,
      clientRegistry: value.clientRegistry,
      bridge: value.bridge,
      instructionChannel: value.instructionChannel,
      onActivated() {},
      connect: () => socket,
      lstat: () => ({
        ino: mismatch === 'inode' && statCalls++ > 0 ? 92 : 91,
        mode: 0o140600,
        uid: 1000,
      }),
      monotonicNow: () => value.source.window.startedAtMonotonicMs,
      unixNow: () => value.source.window.startedAtUnixMs,
      pid: 4242,
      uid: 1000,
    });
    runtime.start();
    socket.emit('connect');
    if (mismatch === 'challenge') {
      socket.emit('data', encodePhase5FaultControlAdmission({
        schemaVersion: 1,
        kind: 'phase5-fault-control-admission',
        role: 'runtime',
        challenge: 'f'.repeat(64),
        socketInode: 91,
      }));
    }
    assert.equal(socket.destroyed, true, mismatch);
    assert.deepEqual(socket.writes, [], mismatch);
  }
});

test('runtime holds an action response until the bound completion returns', async () => {
  const source = signedFixture().evidence;
  let cursor = 0;
  let committed = null;
  const channel = createPhase5FaultInstructionChannel({
    clientActuator: {
      disconnectRuntime() {}, saturateEgress() {},
      waitRuntimeReconnectGrant: async () => ({ capability: 'a'.repeat(43) }),
      recordAudioCompletion() {},
    },
  });
  const bridge = Object.freeze({
    flushTransportObservations() { return []; },
    payloadFor(plan) {
      const event = source.scenarioEvents[cursor++];
      assert.equal(plan.scenario, event.scenario);
      assert.equal(plan.phase, event.phase);
      return { atMonotonicMs: event.atMonotonicMs,
        atUnixMs: event.atUnixMs, payload: structuredClone(event.payload) };
    },
    commitSignedAction(bytes) { committed = Buffer.from(bytes); },
    dispatchFixedInstruction(sequence) {
      return channel.instructionSink.dispatch(Object.freeze({
        schemaVersion: 1, kind: 'phase5-fixed-instruction', sequence,
        plannedAudioEpoch: null,
      }), committed);
    },
  });
  const authority = createPhase5FaultSessionAuthority({
    identity: { runId: source.runId, challenge: source.challenge,
      release: structuredClone(source.release),
      geometry: structuredClone(source.geometry),
      profile: structuredClone(source.profile) },
    captureNonceBytes: Buffer.alloc(32, 8),
  });
  let randomCounter = 0;
  const registry = _createPhase5ClientRegistry({
    runId: source.runId,
    randomBytes: (size) => Buffer.alloc(size, ++randomCounter),
  });
  const socket = new FakeSocket();
  const runtime = _createPhase5FaultControlRuntime({
    authority, clientRegistry: registry, bridge,
    instructionChannel: channel,
    connect: () => socket,
    lstat: () => ({ ino: 91, mode: 0o140600, uid: 1000 }),
    monotonicNow: () => source.window.startedAtMonotonicMs,
    unixNow: () => source.window.startedAtUnixMs,
    pid: 4242, uid: 1000, onActivated() {},
  });
  runtime.start();
  socket.emit('connect');
  socket.emit('data', encodePhase5FaultControlAdmission({
    schemaVersion: 1, kind: 'phase5-fault-control-admission',
    role: 'runtime', challenge: source.challenge, socketInode: 91,
  }));
  for (const sequence of [1, 2]) {
    socket.emit('data', encodePhase5FaultControlRequest({
      schemaVersion: 1, kind: 'phase5-fault-control-advance', sequence,
    }));
  }
  assert.equal(socket.writes.length, 3);
  const instruction = decodePhase5FaultControlInstruction(socket.writes[2]);
  const actionBytes = Buffer.from(instruction.actionEventBase64, 'base64');
  socket.emit('data', encodePhase5FaultControlCompletion({
    schemaVersion: 1,
    kind: 'phase5-fixed-instruction-complete',
    sequence: 1,
    actionEventSha256: createHash('sha256').update(actionBytes).digest('hex'),
    accepted: true,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.writes.length, 4);
  assert.equal(JSON.parse(socket.writes[3]).kind,
    'phase5-fault-control-advance-response');
});
