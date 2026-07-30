import { types } from 'node:util';

import {
  decodePhase5FaultControlResponse,
  encodePhase5FaultControlRequest,
} from '../../src/acceptance/phase5-fault-control-protocol.js';

function fail(code) {
  throw new Phase5FaultControlClientError(code);
}

function enumerableDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
}

function exactOptions(value) {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === 1
    && keys[0] === 'sendRequestBytes'
    && enumerableDataProperty(value, 'sendRequestBytes')
    && typeof Object.getOwnPropertyDescriptor(
      value,
      'sendRequestBytes',
    ).value === 'function';
}

export class Phase5FaultControlClientError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5FaultControlClientError';
    this.code = code;
  }
}

export function createPhase5FaultControlClient(options = {}) {
  if (arguments.length !== 1 || !exactOptions(options)) {
    fail('PHASE5_FAULT_CONTROL_CLIENT_INPUT_INVALID');
  }
  const sendRequestBytes = Object.getOwnPropertyDescriptor(
    options,
    'sendRequestBytes',
  ).value;
  if (types.isProxy(sendRequestBytes)) {
    fail('PHASE5_FAULT_CONTROL_CLIENT_INPUT_INVALID');
  }
  let sequence = 0;
  let terminal = false;
  let busy = false;

  async function request(kind, expectedKind) {
    if (terminal) fail('PHASE5_FAULT_CONTROL_CLIENT_TERMINAL');
    if (busy) {
      terminal = true;
      fail('PHASE5_FAULT_CONTROL_CLIENT_CONCURRENT');
    }
    busy = true;
    sequence += 1;
    try {
      const responseBytes = await Reflect.apply(
        sendRequestBytes,
        undefined,
        [encodePhase5FaultControlRequest({
          schemaVersion: 1,
          kind,
          sequence,
        })],
      );
      const response = decodePhase5FaultControlResponse(responseBytes);
      if (terminal
          || response.sequence !== sequence
          || response.kind !== expectedKind) {
        fail('PHASE5_FAULT_CONTROL_CLIENT_RESPONSE_INVALID');
      }
      return response.result;
    } catch (error) {
      terminal = true;
      if (error instanceof Phase5FaultControlClientError) throw error;
      fail('PHASE5_FAULT_CONTROL_CLIENT_REQUEST_FAILED');
    } finally {
      busy = false;
    }
  }

  function advance(...args) {
    if (args.length !== 0) {
      terminal = true;
      fail('PHASE5_FAULT_CONTROL_CLIENT_INPUT_INVALID');
    }
    return request(
      'phase5-fault-control-advance',
      'phase5-fault-control-advance-response',
    );
  }

  async function closeWindow(...args) {
    if (args.length !== 0) {
      terminal = true;
      fail('PHASE5_FAULT_CONTROL_CLIENT_INPUT_INVALID');
    }
    const result = await request(
      'phase5-fault-control-close-window',
      'phase5-fault-control-close-window-response',
    );
    terminal = true;
    return result;
  }

  return Object.freeze({
    advance,
    closeWindow,
  });
}
