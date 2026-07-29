import {
  TextDecoder,
  types,
} from 'node:util';

import {
  canonicalPhase5CaptureJson,
  copyPhase5CaptureBytes,
  decodePhase5CaptureCanonicalLine,
  encodePhase5CaptureCanonicalLine,
  validatePhase5CaptureAdmission,
} from './capture-wire.js';
import {
  validatePhase5CaptureProof,
} from './phase5-capture-proof.js';

export const MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES = 4096;

const MAX_PHASE5_CAPTURE_SESSION_BYTES = 1024 * 1024;
const MAX_PHASE5_CAPTURE_ADMISSION_BYTES = 4096;
const MAX_PHASE5_CAPTURE_RESPONSE_BYTES = 2 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const OPTIONS_FIELDS = Object.freeze(['finalizer']);
const FINALIZER_FIELDS = Object.freeze([
  'getAdmission',
  'finalize',
]);
const REQUEST_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'runId',
  'challenge',
  'captureNonce',
  'rawManifestSha256',
]);
const FINALIZER_RESULT_FIELDS = Object.freeze([
  'sessionBytes',
  'runBinding',
  'captureValidation',
]);

function fail(code) {
  throw new Phase5CaptureChannelProtocolError(code);
}

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

function validateRequest(request, admission) {
  if (!exactPlainDataObject(request, REQUEST_FIELDS)
      || request.schemaVersion !== 1
      || request.kind
         !== 'phase5-candidate-capture-finalize-request'
      || request.runId !== admission.runId
      || request.challenge !== admission.challenge
      || request.captureNonce !== admission.captureNonce
      || typeof request.rawManifestSha256 !== 'string'
      || !HEX64.test(request.rawManifestSha256)) {
    throw new Error('REQUEST_INVALID');
  }
}

function bindingFromValidation(validation) {
  return {
    runId: validation.runId,
    challenge: validation.challenge,
    release: validation.release,
    geometry: validation.geometry,
    profile: validation.profile,
    signerSpkiSha256: validation.signerSpkiSha256,
    faultSessionEvidenceSha256:
      validation.faultSessionEvidenceSha256,
    captureNonce: validation.captureNonce,
    rawManifestSha256: validation.rawManifestSha256,
  };
}

export class Phase5CaptureChannelProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5CaptureChannelProtocolError';
    this.code = code;
  }
}

export function createPhase5CaptureChannelProtocol(options = {}) {
  let finalizer;
  let getAdmission;
  let finalize;
  let admission;
  try {
    if (!exactPlainDataObject(options, OPTIONS_FIELDS)) {
      throw new Error('OPTIONS_INVALID');
    }
    finalizer = dataPropertyValue(options, 'finalizer');
    if (!exactPlainDataObject(finalizer, FINALIZER_FIELDS)
        || typeof dataPropertyValue(finalizer, 'getAdmission')
           !== 'function'
        || typeof dataPropertyValue(finalizer, 'finalize')
           !== 'function') {
      throw new Error('FINALIZER_INVALID');
    }
    getAdmission = dataPropertyValue(finalizer, 'getAdmission');
    finalize = dataPropertyValue(finalizer, 'finalize');
    admission = validatePhase5CaptureAdmission(
      Reflect.apply(getAdmission, finalizer, []),
    );
  } catch {
    fail('PHASE5_CAPTURE_CHANNEL_INPUT_INVALID');
  }

  const admissionBytes = encodePhase5CaptureCanonicalLine(
    admission,
    MAX_PHASE5_CAPTURE_ADMISSION_BYTES,
  );
  let used = false;

  function getAdmissionBytes(...args) {
    if (args.length !== 0) {
      fail('PHASE5_CAPTURE_CHANNEL_INPUT_INVALID');
    }
    return Buffer.from(admissionBytes);
  }

  function handleFinalizeRequestBytes(...args) {
    if (used) fail('PHASE5_CAPTURE_CHANNEL_ALREADY_USED');
    used = true;
    let request;
    try {
      if (args.length !== 1) throw new Error('ARGUMENT_INVALID');
      request = decodePhase5CaptureCanonicalLine(
        args[0],
        MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES,
      );
      validateRequest(request, admission);
    } catch {
      try {
        Reflect.apply(finalize, finalizer, ['']);
      } catch {
        // The genuine finalizer seals itself before rejecting the digest.
      }
      fail('PHASE5_CAPTURE_CHANNEL_REQUEST_INVALID');
    }

    try {
      const finalized = Reflect.apply(
        finalize,
        finalizer,
        [request.rawManifestSha256],
      );
      if (!exactPlainDataObject(
        finalized,
        FINALIZER_RESULT_FIELDS,
      )) {
        throw new Error('FINALIZER_RESULT_INVALID');
      }
      const sessionBytes = copyPhase5CaptureBytes(
        dataPropertyValue(finalized, 'sessionBytes'),
        MAX_PHASE5_CAPTURE_SESSION_BYTES,
      );
      const sessionText = new TextDecoder(
        'utf-8',
        { fatal: true, ignoreBOM: true },
      ).decode(sessionBytes);
      const session = JSON.parse(sessionText);
      if (sessionText !== canonicalPhase5CaptureJson(session)) {
        throw new Error('SESSION_NONCANONICAL');
      }
      const validation = validatePhase5CaptureProof(
        session,
        dataPropertyValue(finalized, 'runBinding'),
        admission.trustedSignerSpkiDerBase64,
      );
      if (validation.runId !== admission.runId
          || validation.challenge !== admission.challenge
          || validation.captureNonce !== admission.captureNonce
          || validation.signerSpkiSha256
             !== admission.signerSpkiSha256
          || validation.rawManifestSha256
             !== request.rawManifestSha256) {
        throw new Error('FINALIZER_BINDING_MISMATCH');
      }
      const response = {
        schemaVersion: 1,
        kind: 'phase5-candidate-capture-finalize-response',
        session,
        runBinding: bindingFromValidation(validation),
        captureValidation: validation,
      };
      return encodePhase5CaptureCanonicalLine(
        response,
        MAX_PHASE5_CAPTURE_RESPONSE_BYTES,
      );
    } catch {
      fail('PHASE5_CAPTURE_CHANNEL_FINALIZE_FAILED');
    }
  }

  return Object.freeze({
    getAdmissionBytes,
    handleFinalizeRequestBytes,
  });
}
