import { types } from 'node:util';

import {
  decodePhase5CaptureCanonicalLine,
  encodePhase5CaptureCanonicalLine,
} from '../capture/capture-wire.js';

export const MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES = 4096;
export const MAX_PHASE5_FAULT_CONTROL_RESPONSE_BYTES = 128 * 1024 * 1024;

const REQUEST_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'sequence',
]);
const RESPONSE_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'sequence',
  'result',
]);
const REQUEST_KINDS = new Set([
  'phase5-fault-control-advance',
  'phase5-fault-control-close-window',
]);
const RESPONSE_KINDS = new Set([
  'phase5-fault-control-advance-response',
  'phase5-fault-control-close-window-response',
]);
const ADMISSION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'role', 'challenge', 'socketInode',
]);
const INSTRUCTION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'sequence', 'actionEventBase64',
  'runtimeCapability',
]);
const COMPLETION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'sequence', 'actionEventSha256', 'accepted',
]);
const HEX64 = /^[0-9a-f]{64}$/u;
const RELAY_SEQUENCES = new Set([1, 4, 5, 6, 8, 13]);

function fail(code) {
  throw new Phase5FaultControlProtocolError(code);
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

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateRequest(value) {
  if (!exactPlainDataObject(value, REQUEST_FIELDS)
      || value.schemaVersion !== 1
      || !REQUEST_KINDS.has(value.kind)
      || !positiveSafeInteger(value.sequence)) {
    fail('PHASE5_FAULT_CONTROL_REQUEST_INVALID');
  }
  return value;
}

function validateResult(kind, result) {
  if (kind === 'phase5-fault-control-advance-response') {
    return exactPlainDataObject(result, ['eventBase64'])
      && typeof result.eventBase64 === 'string'
      && Buffer.from(result.eventBase64, 'base64').toString('base64')
        === result.eventBase64;
  }
  return exactPlainDataObject(result, ['faultEventsBase64'])
    && typeof result.faultEventsBase64 === 'string'
    && Buffer.from(result.faultEventsBase64, 'base64').toString('base64')
      === result.faultEventsBase64;
}

function validateResponse(value) {
  if (!exactPlainDataObject(value, RESPONSE_FIELDS)
      || value.schemaVersion !== 1
      || !RESPONSE_KINDS.has(value.kind)
      || !positiveSafeInteger(value.sequence)
      || !validateResult(value.kind, value.result)) {
    fail('PHASE5_FAULT_CONTROL_RESPONSE_INVALID');
  }
  return value;
}

function validateAdmission(value) {
  if (!exactPlainDataObject(value, ADMISSION_FIELDS)
      || value.schemaVersion !== 1
      || value.kind !== 'phase5-fault-control-admission'
      || !new Set(['runtime', 'audio']).has(value.role)
      || typeof value.challenge !== 'string'
      || !HEX64.test(value.challenge)
      || !positiveSafeInteger(value.socketInode)) {
    fail('PHASE5_FAULT_CONTROL_ADMISSION_INVALID');
  }
  return value;
}

function validateInstruction(value) {
  const requiresCapability = value?.sequence === 4 || value?.sequence === 8;
  if (!exactPlainDataObject(value, INSTRUCTION_FIELDS)
      || value.schemaVersion !== 1
      || value.kind !== 'phase5-fixed-instruction'
      || !RELAY_SEQUENCES.has(value.sequence)
      || typeof value.actionEventBase64 !== 'string'
      || Buffer.from(value.actionEventBase64, 'base64').toString('base64')
        !== value.actionEventBase64
      || (requiresCapability
        ? (typeof value.runtimeCapability !== 'string'
          || !/^[A-Za-z0-9_-]{43}$/u.test(value.runtimeCapability))
        : value.runtimeCapability !== null)) {
    fail('PHASE5_FAULT_CONTROL_INSTRUCTION_INVALID');
  }
  return value;
}

function validateCompletion(value) {
  if (!exactPlainDataObject(value, COMPLETION_FIELDS)
      || value.schemaVersion !== 1
      || value.kind !== 'phase5-fixed-instruction-complete'
      || !RELAY_SEQUENCES.has(value.sequence)
      || typeof value.actionEventSha256 !== 'string'
      || !HEX64.test(value.actionEventSha256)
      || value.accepted !== true) {
    fail('PHASE5_FAULT_CONTROL_COMPLETION_INVALID');
  }
  return value;
}

export class Phase5FaultControlProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5FaultControlProtocolError';
    this.code = code;
  }
}

export function encodePhase5FaultControlRequest(value) {
  try {
    return encodePhase5CaptureCanonicalLine(
      validateRequest(value),
      MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES,
    );
  } catch (error) {
    if (error instanceof Phase5FaultControlProtocolError) throw error;
    fail('PHASE5_FAULT_CONTROL_REQUEST_INVALID');
  }
}

export function decodePhase5FaultControlRequest(bytes) {
  try {
    return validateRequest(decodePhase5CaptureCanonicalLine(
      bytes,
      MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES,
    ));
  } catch (error) {
    if (error instanceof Phase5FaultControlProtocolError) throw error;
    fail('PHASE5_FAULT_CONTROL_REQUEST_INVALID');
  }
}

export function encodePhase5FaultControlResponse(value) {
  try {
    return encodePhase5CaptureCanonicalLine(
      validateResponse(value),
      MAX_PHASE5_FAULT_CONTROL_RESPONSE_BYTES,
    );
  } catch (error) {
    if (error instanceof Phase5FaultControlProtocolError) throw error;
    fail('PHASE5_FAULT_CONTROL_RESPONSE_INVALID');
  }
}

export function decodePhase5FaultControlResponse(bytes) {
  try {
    return validateResponse(decodePhase5CaptureCanonicalLine(
      bytes,
      MAX_PHASE5_FAULT_CONTROL_RESPONSE_BYTES,
    ));
  } catch (error) {
    if (error instanceof Phase5FaultControlProtocolError) throw error;
    fail('PHASE5_FAULT_CONTROL_RESPONSE_INVALID');
  }
}

export function encodePhase5FaultControlAdmission(value) {
  try {
    return encodePhase5CaptureCanonicalLine(
      validateAdmission(value),
      MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES,
    );
  } catch (error) {
    if (error instanceof Phase5FaultControlProtocolError) throw error;
    fail('PHASE5_FAULT_CONTROL_ADMISSION_INVALID');
  }
}

export function decodePhase5FaultControlAdmission(bytes) {
  try {
    return validateAdmission(decodePhase5CaptureCanonicalLine(
      bytes,
      MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES,
    ));
  } catch (error) {
    if (error instanceof Phase5FaultControlProtocolError) throw error;
    fail('PHASE5_FAULT_CONTROL_ADMISSION_INVALID');
  }
}

export function encodePhase5FaultControlInstruction(value) {
  try {
    return encodePhase5CaptureCanonicalLine(
      validateInstruction(value),
      MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES,
    );
  } catch (error) {
    if (error instanceof Phase5FaultControlProtocolError) throw error;
    fail('PHASE5_FAULT_CONTROL_INSTRUCTION_INVALID');
  }
}

export function decodePhase5FaultControlInstruction(bytes) {
  try {
    return validateInstruction(decodePhase5CaptureCanonicalLine(
      bytes,
      MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES,
    ));
  } catch (error) {
    if (error instanceof Phase5FaultControlProtocolError) throw error;
    fail('PHASE5_FAULT_CONTROL_INSTRUCTION_INVALID');
  }
}

export function encodePhase5FaultControlCompletion(value) {
  try {
    return encodePhase5CaptureCanonicalLine(
      validateCompletion(value),
      MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES,
    );
  } catch (error) {
    if (error instanceof Phase5FaultControlProtocolError) throw error;
    fail('PHASE5_FAULT_CONTROL_COMPLETION_INVALID');
  }
}

export function decodePhase5FaultControlCompletion(bytes) {
  try {
    return validateCompletion(decodePhase5CaptureCanonicalLine(
      bytes,
      MAX_PHASE5_FAULT_CONTROL_REQUEST_BYTES,
    ));
  } catch (error) {
    if (error instanceof Phase5FaultControlProtocolError) throw error;
    fail('PHASE5_FAULT_CONTROL_COMPLETION_INVALID');
  }
}
