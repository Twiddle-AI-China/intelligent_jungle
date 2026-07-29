import { createHash } from 'node:crypto';
import { types } from 'node:util';

import {
  assertPhase5CaptureAdmissionBinding,
  copyPhase5CaptureBytes,
  decodePhase5CaptureCanonicalLine,
  encodePhase5CaptureCanonicalLine,
  validatePhase5CaptureAdmission,
} from './capture-wire.js';

export const MAX_PHASE5_CAPTURE_BOOTSTRAP_REQUEST_BYTES = 4096;
export const MAX_PHASE5_CAPTURE_BOOTSTRAP_ADMISSION_BYTES = 4096;
export const MAX_PHASE5_CAPTURE_BOOTSTRAP_ACK_BYTES = 256;
export const MAX_PHASE5_CAPTURE_BOOTSTRAP_RECEIPT_BYTES = 256;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OPTIONS_FIELDS = Object.freeze([
  'trustedRelease',
  'trustedGeometry',
]);
const REQUEST_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'identity',
  'captureNonce',
]);
const IDENTITY_FIELDS = Object.freeze([
  'runId',
  'challenge',
  'release',
  'geometry',
  'profile',
]);
const RELEASE_FIELDS = Object.freeze([
  'releaseManifestSha256',
  'releaseRevision',
  'sourceManifestSha256',
  'audioArtifactSha256',
]);
const GEOMETRY_FIELDS = Object.freeze([
  'sampleRate',
  'blockFrames',
  'poolSize',
  'rowVoices',
]);
const PROFILE_FIELDS = Object.freeze([
  'clients',
  'slowClient',
  'durationMinutes',
  'speciesEndpoint',
  'speciesModel',
]);
const ACK_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'admissionSha256',
  'receiptChallenge',
]);
const ROW_VOICES = Object.freeze([
  'bass',
  'pad',
  'lead',
  'pluck',
  'pad',
]);
const FIXED_PROFILE = Object.freeze({
  clients: 4,
  slowClient: 4,
  durationMinutes: 30,
  speciesEndpoint: 'http://127.0.0.1:8081/v1',
  speciesModel: 'bird_agent',
});

function fail() {
  throw new Phase5CaptureBootstrapProtocolError();
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

function ordinaryDenseArray(value, expectedLength) {
  if (!Array.isArray(value)
      || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || value.length !== expectedLength) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedLength + 1
      || !keys.includes('length')) {
    return false;
  }
  for (let index = 0; index < expectedLength; index += 1) {
    if (!enumerableDataProperty(value, String(index))) return false;
  }
  return keys.every((key) => (
    key === 'length'
      || (
        typeof key === 'string'
        && /^(?:0|[1-9][0-9]*)$/.test(key)
        && Number(key) < expectedLength
      )
  ));
}

function dataPropertyValue(value, key) {
  return Object.getOwnPropertyDescriptor(value, key).value;
}

function validRelease(value) {
  return exactPlainDataObject(value, RELEASE_FIELDS)
    && typeof dataPropertyValue(
      value,
      'releaseManifestSha256',
    ) === 'string'
    && HEX64.test(dataPropertyValue(
      value,
      'releaseManifestSha256',
    ))
    && typeof dataPropertyValue(
      value,
      'releaseRevision',
    ) === 'string'
    && HEX40.test(dataPropertyValue(value, 'releaseRevision'))
    && typeof dataPropertyValue(
      value,
      'sourceManifestSha256',
    ) === 'string'
    && HEX64.test(dataPropertyValue(
      value,
      'sourceManifestSha256',
    ))
    && typeof dataPropertyValue(
      value,
      'audioArtifactSha256',
    ) === 'string'
    && HEX64.test(dataPropertyValue(
      value,
      'audioArtifactSha256',
    ));
}

function validGeometry(value) {
  if (!exactPlainDataObject(value, GEOMETRY_FIELDS)
      || dataPropertyValue(value, 'sampleRate') !== 44_100
      || dataPropertyValue(value, 'blockFrames') !== 4_096
      || dataPropertyValue(value, 'poolSize') !== 5) {
    return false;
  }
  const voices = dataPropertyValue(value, 'rowVoices');
  return ordinaryDenseArray(voices, ROW_VOICES.length)
    && ROW_VOICES.every((voice, index) => (
      dataPropertyValue(voices, String(index)) === voice
    ));
}

function validProfile(value) {
  return exactPlainDataObject(value, PROFILE_FIELDS)
    && PROFILE_FIELDS.every((field) => (
      dataPropertyValue(value, field) === FIXED_PROFILE[field]
    ));
}

function ownedRelease(value) {
  return {
    releaseManifestSha256:
      dataPropertyValue(value, 'releaseManifestSha256'),
    releaseRevision: dataPropertyValue(value, 'releaseRevision'),
    sourceManifestSha256:
      dataPropertyValue(value, 'sourceManifestSha256'),
    audioArtifactSha256:
      dataPropertyValue(value, 'audioArtifactSha256'),
  };
}

function ownedGeometry(value) {
  const voices = dataPropertyValue(value, 'rowVoices');
  return {
    sampleRate: dataPropertyValue(value, 'sampleRate'),
    blockFrames: dataPropertyValue(value, 'blockFrames'),
    poolSize: dataPropertyValue(value, 'poolSize'),
    rowVoices: ROW_VOICES.map(
      (_voice, index) => dataPropertyValue(
        voices,
        String(index),
      ),
    ),
  };
}

function ownedProfile(value) {
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [
    field,
    dataPropertyValue(value, field),
  ]));
}

function deepFreeze(value) {
  if (value !== null
      && typeof value === 'object'
      && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactReleaseMatch(left, right) {
  return RELEASE_FIELDS.every((field) => left[field] === right[field]);
}

function exactGeometryMatch(left, right) {
  return left.sampleRate === right.sampleRate
    && left.blockFrames === right.blockFrames
    && left.poolSize === right.poolSize
    && ROW_VOICES.every(
      (_voice, index) => (
        left.rowVoices[index] === right.rowVoices[index]
      ),
    );
}

function validateBootstrapRequest(
  value,
  trustedRelease,
  trustedGeometry,
) {
  if (!exactPlainDataObject(value, REQUEST_FIELDS)
      || dataPropertyValue(value, 'schemaVersion') !== 1
      || dataPropertyValue(value, 'kind')
         !== 'phase5-candidate-capture-bootstrap-request') {
    fail();
  }
  const identity = dataPropertyValue(value, 'identity');
  const captureNonce = dataPropertyValue(value, 'captureNonce');
  if (!exactPlainDataObject(identity, IDENTITY_FIELDS)
      || typeof dataPropertyValue(identity, 'runId') !== 'string'
      || !UUID_V4.test(dataPropertyValue(identity, 'runId'))
      || typeof dataPropertyValue(identity, 'challenge') !== 'string'
      || !HEX64.test(dataPropertyValue(identity, 'challenge'))
      || typeof captureNonce !== 'string'
      || !HEX64.test(captureNonce)) {
    fail();
  }
  const release = dataPropertyValue(identity, 'release');
  const geometry = dataPropertyValue(identity, 'geometry');
  const profile = dataPropertyValue(identity, 'profile');
  if (!validRelease(release)
      || !validGeometry(geometry)
      || !validProfile(profile)) {
    fail();
  }
  const owned = {
    runId: dataPropertyValue(identity, 'runId'),
    challenge: dataPropertyValue(identity, 'challenge'),
    release: ownedRelease(release),
    geometry: ownedGeometry(geometry),
    profile: ownedProfile(profile),
  };
  if (!exactReleaseMatch(owned.release, trustedRelease)
      || !exactGeometryMatch(owned.geometry, trustedGeometry)) {
    fail();
  }
  return deepFreeze({
    identity: owned,
    captureNonce,
  });
}

function validateAck(value, expectedAdmissionSha256) {
  const receiptChallenge = exactPlainDataObject(value, ACK_FIELDS)
    ? dataPropertyValue(value, 'receiptChallenge')
    : null;
  if (!exactPlainDataObject(value, ACK_FIELDS)
      || dataPropertyValue(value, 'schemaVersion') !== 1
      || dataPropertyValue(value, 'kind')
         !== 'phase5-candidate-capture-admission-ack'
      || typeof dataPropertyValue(
        value,
        'admissionSha256',
      ) !== 'string'
      || dataPropertyValue(
        value,
        'admissionSha256',
      ) !== expectedAdmissionSha256
      || typeof receiptChallenge !== 'string'
      || !HEX64.test(receiptChallenge)) {
    fail();
  }
  return receiptChallenge;
}

export class Phase5CaptureBootstrapProtocolError extends Error {
  constructor() {
    super('PHASE5_CAPTURE_BOOTSTRAP_PROTOCOL_REQUIRED');
    this.name = 'Phase5CaptureBootstrapProtocolError';
    this.code = 'PHASE5_CAPTURE_BOOTSTRAP_PROTOCOL_REQUIRED';
  }
}

export function createPhase5CaptureBootstrapProtocol(options) {
  let trustedRelease;
  let trustedGeometry;
  try {
    if (arguments.length !== 1
        || !exactPlainDataObject(options, OPTIONS_FIELDS)) {
      fail();
    }
    const release = dataPropertyValue(options, 'trustedRelease');
    const geometry = dataPropertyValue(options, 'trustedGeometry');
    if (!validRelease(release) || !validGeometry(geometry)) {
      fail();
    }
    trustedRelease = deepFreeze(ownedRelease(release));
    trustedGeometry = deepFreeze(ownedGeometry(geometry));
  } catch {
    fail();
  }

  let state = 'NEW';
  let accepted = null;
  let expectedAdmissionSha256 = null;

  function beginStage(expectedState) {
    if (state !== expectedState) {
      state = 'SEALED';
      fail();
    }
    state = 'SEALED';
  }

  function acceptBootstrapRequestBytes(...args) {
    beginStage('NEW');
    try {
      if (args.length !== 1) fail();
      const value = decodePhase5CaptureCanonicalLine(
        args[0],
        MAX_PHASE5_CAPTURE_BOOTSTRAP_REQUEST_BYTES,
      );
      accepted = validateBootstrapRequest(
        value,
        trustedRelease,
        trustedGeometry,
      );
      state = 'BOOTSTRAP_ACCEPTED';
      return accepted;
    } catch {
      fail();
    }
  }

  function bindAdmissionBytes(...args) {
    beginStage('BOOTSTRAP_ACCEPTED');
    try {
      if (args.length !== 1) fail();
      const admissionBytes = copyPhase5CaptureBytes(
        args[0],
        MAX_PHASE5_CAPTURE_BOOTSTRAP_ADMISSION_BYTES,
      );
      const admissionValue = decodePhase5CaptureCanonicalLine(
        admissionBytes,
        MAX_PHASE5_CAPTURE_BOOTSTRAP_ADMISSION_BYTES,
      );
      const admission = validatePhase5CaptureAdmission(
        admissionValue,
      );
      assertPhase5CaptureAdmissionBinding(admission, {
        runId: accepted.identity.runId,
        challenge: accepted.identity.challenge,
        captureNonce: accepted.captureNonce,
      });
      expectedAdmissionSha256 = createHash('sha256')
        .update(admissionBytes)
        .digest('hex');
      const result = deepFreeze({
        admission,
        admissionSha256: expectedAdmissionSha256,
      });
      state = 'ADMISSION_BOUND';
      return result;
    } catch {
      fail();
    }
  }

  function acceptAdmissionAckBytes(...args) {
    beginStage('ADMISSION_BOUND');
    try {
      if (args.length !== 1) fail();
      const value = decodePhase5CaptureCanonicalLine(
        args[0],
        MAX_PHASE5_CAPTURE_BOOTSTRAP_ACK_BYTES,
      );
      const receiptChallenge = validateAck(
        value,
        expectedAdmissionSha256,
      );
      const receiptBytes = encodePhase5CaptureCanonicalLine({
        schemaVersion: 1,
        kind: 'phase5-candidate-capture-admission-receipt',
        admissionSha256: expectedAdmissionSha256,
        receiptChallenge,
      }, MAX_PHASE5_CAPTURE_BOOTSTRAP_RECEIPT_BYTES);
      state = 'ACKED';
      return receiptBytes;
    } catch {
      fail();
    }
  }

  function abort(...args) {
    state = 'SEALED';
    if (args.length !== 0) fail();
    return true;
  }

  return Object.freeze({
    acceptBootstrapRequestBytes,
    bindAdmissionBytes,
    acceptAdmissionAckBytes,
    abort,
  });
}
