import { lstatSync as fsLstatSync } from 'node:fs';
import { createConnection as netCreateConnection } from 'node:net';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';

import {
  canonicalPhase5CaptureJson,
} from '../capture/capture-wire.js';
import {
  activatePhase5FaultSessionAuthority,
} from './phase5-fault-session-authority.js';
import {
  decodePhase5FaultControlAdmission,
  MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES,
} from './phase5-fault-control-protocol.js';
import {
  createPhase5FaultControlServer,
  PHASE5_FAULT_CONTROL_SOCKET_PATHS,
} from './phase5-fault-control-server.js';

const PRIVATE_FIELDS = Object.freeze([
  'authority', 'clientRegistry', 'bridge', 'connect', 'lstat',
  'monotonicNow', 'unixNow', 'pid', 'uid', 'instructionChannel',
  'onActivated',
]);
const AUTHORITY_FIELDS = Object.freeze([
  'getAdmission', 'appendTransportObservation', 'advance',
  'closeFaultWindow', 'finalizeCapture',
]);
const REGISTRY_FIELDS = Object.freeze([
  'getInitialCapabilities', 'claim', 'close', 'terminate',
]);
const BRIDGE_FIELDS = Object.freeze([
  'flushTransportObservations', 'payloadFor',
  'commitSignedAction', 'dispatchFixedInstruction',
]);
const INSTRUCTION_CHANNEL_FIELDS = Object.freeze([
  'instructionSink', 'bindTransport', 'acceptCompletion', 'close',
]);

function exactInstructionChannel(value) {
  return exactObject(value, INSTRUCTION_CHANNEL_FIELDS)
    && Object.isFrozen(value)
    && exactFrozenMethods(value.instructionSink, ['dispatch'])
    && ['bindTransport', 'acceptCompletion', 'close'].every(
      (name) => typeof value[name] === 'function');
}
const TYPE_MASK = 0o170000;
const SOCKET_TYPE = 0o140000;

function fail(code) {
  throw new Phase5FaultControlRuntimeError(code);
}

function dataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
}

function exactObject(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length
    && fields.every((field) => keys.includes(field) && dataProperty(value, field));
}

function exactFrozenMethods(value, fields) {
  return exactObject(value, fields)
    && Object.isFrozen(value)
    && fields.every((field) => typeof value[field] === 'function');
}

function socketSnapshot(lstat, path, uid) {
  let value;
  try {
    value = Reflect.apply(lstat, undefined, [path]);
  } catch {
    fail('PHASE5_FAULT_CONTROL_SOCKET_INVALID');
  }
  if (value === null || typeof value !== 'object'
      || !Number.isSafeInteger(value.ino) || value.ino <= 0
      || !Number.isSafeInteger(value.mode)
      || (value.mode & TYPE_MASK) !== SOCKET_TYPE
      || (value.mode & 0o777) !== 0o600
      || !Number.isSafeInteger(value.uid) || value.uid !== uid) {
    fail('PHASE5_FAULT_CONTROL_SOCKET_INVALID');
  }
  return Object.freeze({ inode: value.ino });
}

function canonicalLine(value) {
  return Buffer.from(`${canonicalPhase5CaptureJson(value)}\n`, 'utf8');
}

export class Phase5FaultControlRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5FaultControlRuntimeError';
    this.code = code;
  }
}

export function _createPhase5FaultControlRuntime(options) {
  if (arguments.length !== 1 || !exactObject(options, PRIVATE_FIELDS)
      || !exactFrozenMethods(options.authority, AUTHORITY_FIELDS)
      || !exactFrozenMethods(options.clientRegistry, REGISTRY_FIELDS)
      || !exactFrozenMethods(options.bridge, BRIDGE_FIELDS)
      || !exactInstructionChannel(options.instructionChannel)
      || typeof options.connect !== 'function'
      || typeof options.lstat !== 'function'
      || typeof options.monotonicNow !== 'function'
      || typeof options.unixNow !== 'function'
      || typeof options.onActivated !== 'function'
      || !Number.isSafeInteger(options.pid) || options.pid <= 0
      || !Number.isSafeInteger(options.uid) || options.uid < 0) {
    fail('PHASE5_FAULT_CONTROL_RUNTIME_INPUT_INVALID');
  }
  const {
    authority, clientRegistry, bridge, connect, lstat,
    monotonicNow, unixNow, pid, uid, instructionChannel, onActivated,
  } = options;
  let state = 'idle';
  let socket = null;
  let server = null;
  let buffer = Buffer.alloc(0);
  let pendingWrite = false;
  let pendingRequest = false;
  const writes = [];

  function terminate(code) {
    if (state === 'terminal') return;
    state = 'terminal';
    try { server?.close(); } catch {}
    try { instructionChannel.close(); } catch {}
    try { clientRegistry.terminate(); } catch {}
    try { socket?.destroy(); } catch {}
    buffer = Buffer.alloc(0);
    writes.length = 0;
    if (code) fail(code);
  }

  function drainWrites() {
    if (pendingWrite || writes.length === 0 || state === 'terminal') return;
    pendingWrite = true;
    const bytes = writes.shift();
    try {
      socket.write(bytes, (error) => {
        pendingWrite = false;
        if (error) {
          try { terminate('PHASE5_FAULT_CONTROL_WRITE_FAILED'); } catch {}
          return;
        }
        drainWrites();
      });
    } catch {
      pendingWrite = false;
      terminate('PHASE5_FAULT_CONTROL_WRITE_FAILED');
    }
  }

  function enqueue(bytes) {
    if (!Buffer.isBuffer(bytes) || state === 'terminal') {
      terminate('PHASE5_FAULT_CONTROL_WRITE_FAILED');
    }
    writes.push(Buffer.from(bytes));
    drainWrites();
  }

  function acceptAdmission(line, expectedInode) {
    const admission = decodePhase5FaultControlAdmission(line);
    const ownedAdmission = authority.getAdmission();
    if (admission.role !== 'runtime'
        || admission.challenge !== ownedAdmission.challenge
        || admission.socketInode !== expectedInode) {
      terminate('PHASE5_FAULT_CONTROL_ADMISSION_INVALID');
    }
    const startedAtMonotonicMs = Reflect.apply(monotonicNow, undefined, []);
    const startedAtUnixMs = Reflect.apply(unixNow, undefined, []);
    if (!Number.isFinite(startedAtMonotonicMs)
        || startedAtMonotonicMs < 0
        || !Number.isFinite(startedAtUnixMs)
        || startedAtUnixMs < 0) {
      terminate('PHASE5_FAULT_CONTROL_CLOCK_INVALID');
    }
    const descriptor = activatePhase5FaultSessionAuthority(authority, {
      window: {
        startedAtMonotonicMs,
        endedAtMonotonicMs: startedAtMonotonicMs + 1_800_000,
        startedAtUnixMs,
        endedAtUnixMs: startedAtUnixMs + 1_800_000,
      },
      bridge,
    });
    server = createPhase5FaultControlServer({
      authority,
      clientRegistry,
      expectedPeer: {
        pid,
        uid,
        socketInode: expectedInode,
        admissionChallenge: ownedAdmission.challenge,
      },
    });
    const accepted = server.acceptPeer({
      pid,
      uid,
      socketInode: expectedInode,
      admissionChallenge: ownedAdmission.challenge,
    });
    Reflect.apply(onActivated, undefined, []);
    state = 'active';
    enqueue(canonicalLine({
      schemaVersion: 1,
      kind: 'phase5-fault-control-admission-response',
      admission: accepted.admission,
      descriptor,
      clientCapabilities: accepted.clientCapabilities,
    }));
  }

  function consume() {
    while (state !== 'terminal' && !pendingRequest) {
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        if (buffer.byteLength >= MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES) {
          terminate('PHASE5_FAULT_CONTROL_FRAME_INVALID');
        }
        return;
      }
      const line = buffer.subarray(0, newline + 1);
      buffer = buffer.subarray(newline + 1);
      if (state === 'awaiting-admission') {
        acceptAdmission(line, socket.expectedInode);
      } else if (state === 'active') {
        const response = server.handleRequestBytes(line);
        if (response && typeof response.then === 'function') {
          pendingRequest = true;
          if (buffer.byteLength !== 0) {
            try { terminate('PHASE5_FAULT_CONTROL_CONCURRENT_REQUEST'); } catch {}
            return;
          }
          Promise.resolve(response).then((bytes) => {
            if (state === 'terminal') return;
            pendingRequest = false;
            enqueue(bytes);
            try { consume(); } catch {
              try { terminate(); } catch {}
            }
          }, () => {
            pendingRequest = false;
            try { terminate('PHASE5_FAULT_CONTROL_REQUEST_FAILED'); } catch {}
          });
          return;
        }
        enqueue(response);
      } else {
        terminate('PHASE5_FAULT_CONTROL_FRAME_INVALID');
      }
    }
  }

  function consumeCompletion() {
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) {
      if (buffer.byteLength >= MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES) {
        terminate('PHASE5_FAULT_CONTROL_FRAME_INVALID');
      }
      return;
    }
    if (newline !== buffer.byteLength - 1) {
      terminate('PHASE5_FAULT_CONTROL_CONCURRENT_REQUEST');
    }
    const line = buffer;
    buffer = Buffer.alloc(0);
    try {
      instructionChannel.acceptCompletion(line);
    } catch {
      terminate('PHASE5_FAULT_CONTROL_REQUEST_FAILED');
    }
  }

  function start(...args) {
    if (args.length !== 0 || state !== 'idle') {
      fail('PHASE5_FAULT_CONTROL_RUNTIME_STATE_INVALID');
    }
    const path = PHASE5_FAULT_CONTROL_SOCKET_PATHS.runtime;
    const snapshot = socketSnapshot(lstat, path, uid);
    state = 'connecting';
    try {
      socket = Reflect.apply(connect, undefined, [{ path }]);
    } catch {
      terminate('PHASE5_FAULT_CONTROL_CONNECT_FAILED');
    }
    if (socket === null || typeof socket !== 'object'
        || typeof socket.on !== 'function'
        || typeof socket.write !== 'function'
        || typeof socket.destroy !== 'function') {
      terminate('PHASE5_FAULT_CONTROL_CONNECT_FAILED');
    }
    Object.defineProperty(socket, 'expectedInode', {
      value: snapshot.inode,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    instructionChannel.bindTransport((bytes) => enqueue(bytes));
    socket.on('connect', () => {
      if (state !== 'connecting') return;
      const after = socketSnapshot(lstat, path, uid);
      if (after.inode !== snapshot.inode) {
        try { terminate('PHASE5_FAULT_CONTROL_SOCKET_ABA'); } catch {}
        return;
      }
      state = 'awaiting-admission';
    });
    socket.on('data', (chunk) => {
      if (!Buffer.isBuffer(chunk) || state === 'terminal') return;
      if (chunk.byteLength > MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES
          || buffer.byteLength
            > MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES - chunk.byteLength) {
        try { terminate('PHASE5_FAULT_CONTROL_FRAME_INVALID'); } catch {}
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (pendingRequest) {
        try { consumeCompletion(); } catch { try { terminate(); } catch {} }
        return;
      }
      try { consume(); } catch { try { terminate(); } catch {} }
    });
    socket.on('error', () => { try { terminate(); } catch {} });
    socket.on('close', () => { try { terminate(); } catch {} });
  }

  function close(...args) {
    if (args.length !== 0) fail('PHASE5_FAULT_CONTROL_RUNTIME_INPUT_INVALID');
    terminate();
  }

  return Object.freeze({ start, close });
}

export function createPhase5FaultControlRuntime(options = {}) {
  if (arguments.length !== 1
      || !exactObject(options, [
        'authority', 'clientRegistry', 'bridge', 'instructionChannel',
        'onActivated',
      ])) {
    fail('PHASE5_FAULT_CONTROL_RUNTIME_INPUT_INVALID');
  }
  return _createPhase5FaultControlRuntime({
    authority: options.authority,
    clientRegistry: options.clientRegistry,
    bridge: options.bridge,
    instructionChannel: options.instructionChannel,
    onActivated: options.onActivated,
    connect: netCreateConnection,
    lstat: fsLstatSync,
    monotonicNow: () => performance.now(),
    unixNow: () => Date.now(),
    pid: process.pid,
    uid: process.getuid(),
  });
}
