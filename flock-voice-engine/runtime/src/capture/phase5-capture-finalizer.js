import { types } from 'node:util';

import {
  Phase5FaultSessionAuthorityError,
} from '../acceptance/phase5-fault-session-authority.js';

const AUTHORITY_FIELDS = Object.freeze([
  'getAdmission',
  'appendTransportObservation',
  'advance',
  'closeFaultWindow',
  'finalizeCapture',
]);

function enumerableDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
}

function exactPlainDataObject(value, expected) {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string')
    && expected.every((key) => (
      keys.includes(key) && enumerableDataProperty(value, key)
    ));
}

function dataPropertyValue(value, key) {
  return Object.getOwnPropertyDescriptor(value, key).value;
}

function exactAuthority(value) {
  return value !== null
    && typeof value === 'object'
    && !types.isProxy(value)
    && Object.isFrozen(value)
    && Reflect.ownKeys(value).length === AUTHORITY_FIELDS.length
    && AUTHORITY_FIELDS.every((field) => (
      enumerableDataProperty(value, field)
      && typeof dataPropertyValue(value, field) === 'function'
    ));
}

function mapError(error) {
  if (!(error instanceof Phase5FaultSessionAuthorityError)) {
    return new Phase5CaptureFinalizerError(
      'PHASE5_CAPTURE_FINALIZER_FAILED',
    );
  }
  const mappings = {
    PHASE5_FAULT_SESSION_INPUT_INVALID:
      'PHASE5_CAPTURE_FINALIZER_INPUT_INVALID',
    PHASE5_FAULT_SESSION_MANIFEST_INVALID:
      'PHASE5_CAPTURE_FINALIZER_MANIFEST_INVALID',
    PHASE5_FAULT_SESSION_ALREADY_USED:
      'PHASE5_CAPTURE_FINALIZER_ALREADY_USED',
    PHASE5_FAULT_SESSION_ALREADY_TERMINAL:
      'PHASE5_CAPTURE_FINALIZER_ALREADY_USED',
    PHASE5_FAULT_SESSION_CAPTURE_BEFORE_CLOSURE:
      'PHASE5_CAPTURE_FINALIZER_FAULT_WINDOW_INCOMPLETE',
  };
  return new Phase5CaptureFinalizerError(
    mappings[error.code] ?? 'PHASE5_CAPTURE_FINALIZER_FAILED',
  );
}

export class Phase5CaptureFinalizerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5CaptureFinalizerError';
    this.code = code;
  }
}

export function createPhase5CandidateCaptureFinalizer(options = {}) {
  let faultSessionAuthority;
  try {
    if (arguments.length !== 1 || !exactPlainDataObject(options, [
      'faultSessionAuthority',
    ])) {
      throw new Phase5CaptureFinalizerError(
        'PHASE5_CAPTURE_FINALIZER_INPUT_INVALID',
      );
    }
    faultSessionAuthority = dataPropertyValue(
      options,
      'faultSessionAuthority',
    );
    if (!exactAuthority(faultSessionAuthority)) {
      throw new Phase5CaptureFinalizerError(
        'PHASE5_CAPTURE_FINALIZER_INPUT_INVALID',
      );
    }
  } catch (error) {
    if (error instanceof Phase5CaptureFinalizerError) throw error;
    throw mapError(error);
  }

  function getAdmission(...args) {
    try {
      return Reflect.apply(
        faultSessionAuthority.getAdmission,
        faultSessionAuthority,
        args,
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  function finalize(...args) {
    try {
      const result = Reflect.apply(
        faultSessionAuthority.finalizeCapture,
        faultSessionAuthority,
        args,
      );
      return Object.freeze({
        sessionBytes: Buffer.from(result.sessionBytes),
        runBinding: result.runBinding,
        captureValidation: result.captureValidation,
      });
    } catch (error) {
      throw mapError(error);
    }
  }

  return Object.freeze({
    getAdmission,
    finalize,
  });
}
