import { types } from 'node:util';

import {
  decodePhase5FaultControlRequest,
  encodePhase5FaultControlRequest,
  encodePhase5FaultControlResponse,
} from './phase5-fault-control-protocol.js';
import {
  canonicalPhase5CaptureJson,
} from '../capture/capture-wire.js';

export { encodePhase5FaultControlRequest };

export const PHASE5_FAULT_CONTROL_SOCKET_PATHS = Object.freeze({
  runtime: '/run/flock-phase5-fault-control/runtime-control.sock',
  audio: '/run/flock-phase5-fault-control/audio-control.sock',
});

const AUTHORITY_FIELDS = Object.freeze([
  'getAdmission',
  'appendTransportObservation',
  'advance',
  'closeFaultWindow',
  'finalizeCapture',
]);
const CLIENT_REGISTRY_FIELDS = Object.freeze([
  'getInitialCapabilities', 'claim', 'close', 'terminate',
]);
const PEER_FIELDS = Object.freeze([
  'pid', 'uid', 'socketInode', 'admissionChallenge',
]);

function fail(code) {
  throw new Phase5FaultControlServerError(code);
}

function enumerableDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
}

function exactPlainDataObject(value, fields) {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length
    && keys.every((key) => typeof key === 'string')
    && fields.every((key) => (
      keys.includes(key) && enumerableDataProperty(value, key)
    ));
}

function exactAuthority(value) {
  return exactPlainDataObject(value, AUTHORITY_FIELDS)
    && Object.isFrozen(value)
    && AUTHORITY_FIELDS.every((field) => (
      typeof Object.getOwnPropertyDescriptor(value, field).value
        === 'function'
    ));
}

function exactClientRegistry(value) {
  return exactPlainDataObject(value, CLIENT_REGISTRY_FIELDS)
    && Object.isFrozen(value)
    && CLIENT_REGISTRY_FIELDS.every((field) => (
      typeof Object.getOwnPropertyDescriptor(value, field).value
        === 'function'
    ));
}

function validPeer(value) {
  return exactPlainDataObject(value, PEER_FIELDS)
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && Number.isSafeInteger(value.uid)
    && value.uid >= 0
    && Number.isSafeInteger(value.socketInode)
    && value.socketInode > 0
    && typeof value.admissionChallenge === 'string'
    && /^[0-9a-f]{64}$/u.test(value.admissionChallenge);
}

function samePeer(left, right) {
  return PEER_FIELDS.every((field) => left[field] === right[field]);
}

export class Phase5FaultControlServerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5FaultControlServerError';
    this.code = code;
  }
}

export function createPhase5FaultControlServer(options = {}) {
  if (arguments.length !== 1
      || !exactPlainDataObject(
        options,
        ['authority', 'clientRegistry', 'expectedPeer'],
      )) {
    fail('PHASE5_FAULT_CONTROL_SERVER_INPUT_INVALID');
  }
  const authority = options.authority;
  const clientRegistry = options.clientRegistry;
  const expectedPeer = options.expectedPeer;
  if (!exactAuthority(authority)
      || !exactClientRegistry(clientRegistry)
      || !validPeer(expectedPeer)) {
    fail('PHASE5_FAULT_CONTROL_SERVER_INPUT_INVALID');
  }
  const ownedExpectedPeer = Object.freeze({ ...expectedPeer });
  let state = 'listening';
  let requestSequence = 0;
  let busy = false;

  function acceptPeer(peer) {
    if (state !== 'listening') {
      fail('PHASE5_FAULT_CONTROL_SECOND_CONNECTION');
    }
    state = 'consumed';
    if (!validPeer(peer) || !samePeer(peer, ownedExpectedPeer)) {
      state = 'terminal';
      clientRegistry.terminate();
      fail('PHASE5_FAULT_CONTROL_PEER_INVALID');
    }
    state = 'active';
    return Object.freeze({
      admission: authority.getAdmission(),
      clientCapabilities: clientRegistry.getInitialCapabilities(),
    });
  }

  function handleRequestBytes(bytes) {
    if (state !== 'active') {
      fail('PHASE5_FAULT_CONTROL_WINDOW_INACTIVE');
    }
    if (busy) {
      state = 'terminal';
      fail('PHASE5_FAULT_CONTROL_CONCURRENT_REQUEST');
    }
    busy = true;
    function failRequest(error) {
      state = 'terminal';
      busy = false;
      if (error instanceof Phase5FaultControlServerError) throw error;
      fail('PHASE5_FAULT_CONTROL_REQUEST_FAILED');
    }
    try {
      const request = decodePhase5FaultControlRequest(bytes);
      if (request.sequence !== requestSequence + 1) {
        state = 'terminal';
        fail('PHASE5_FAULT_CONTROL_SEQUENCE_INVALID');
      }
      requestSequence = request.sequence;
      if (request.kind === 'phase5-fault-control-advance') {
        const encodeEvent = (event) => encodePhase5FaultControlResponse({
            schemaVersion: 1,
            kind: 'phase5-fault-control-advance-response',
            sequence: request.sequence,
            result: {
              eventBase64: Buffer.from(
                canonicalPhase5CaptureJson(event),
                'utf8',
              ).toString('base64'),
            },
          });
        const event = authority.advance();
        if (event && typeof event.then === 'function') {
          return Promise.resolve(event).then((value) => {
            if (state !== 'active') {
              fail('PHASE5_FAULT_CONTROL_WINDOW_INACTIVE');
            }
            const response = encodeEvent(value);
            busy = false;
            return response;
          }, failRequest);
        }
        const response = encodeEvent(event);
        busy = false;
        return response;
      }
      const faultEventsBytes = authority.closeFaultWindow();
      state = 'closed';
      const response = encodePhase5FaultControlResponse({
        schemaVersion: 1,
        kind: 'phase5-fault-control-close-window-response',
        sequence: request.sequence,
        result: {
          faultEventsBase64: Buffer.from(faultEventsBytes).toString('base64'),
        },
      });
      busy = false;
      return response;
    } catch (error) {
      return failRequest(error);
    }
  }

  function close(...args) {
    if (args.length !== 0) {
      state = 'terminal';
      fail('PHASE5_FAULT_CONTROL_SERVER_INPUT_INVALID');
    }
    state = 'terminal';
    clientRegistry.terminate();
  }

  return Object.freeze({
    acceptPeer,
    handleRequestBytes,
    close,
  });
}
