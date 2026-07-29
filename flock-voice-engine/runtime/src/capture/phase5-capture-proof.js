import {
  createHash,
  verify,
} from 'node:crypto';
import { types } from 'node:util';

import {
  canonicalPhase5CaptureJson,
  parsePhase5CaptureEd25519Spki,
} from './capture-wire.js';

export {
  Phase5CaptureWireError,
  assertPhase5CaptureAdmissionBinding,
  canonicalPhase5CaptureJson,
  copyPhase5CaptureBytes,
  createPhase5CaptureSignerDescriptor,
  decodePhase5CaptureCanonicalLine,
  encodePhase5CaptureCanonicalLine,
  parsePhase5CaptureEd25519Spki,
  validatePhase5CaptureAdmission,
} from './capture-wire.js';

const SIGNING_DOMAIN =
  Buffer.from('flock-phase5-capture-proof-v1\0', 'utf8');
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

const SESSION_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'runId',
  'challenge',
  'release',
  'geometry',
  'profile',
  'signer',
  'captureProof',
]);
const SIGNING_INPUT_FIELDS = Object.freeze([
  'runId',
  'challenge',
  'release',
  'geometry',
  'profile',
  'signer',
  'captureNonce',
  'rawManifestSha256',
]);
const RUN_BINDING_FIELDS = Object.freeze([
  'runId',
  'challenge',
  'release',
  'geometry',
  'profile',
  'signerSpkiSha256',
  'faultSessionEvidenceSha256',
  'captureNonce',
  'rawManifestSha256',
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
const SIGNER_FIELDS = Object.freeze([
  'algorithm',
  'publicKeySpkiDerBase64',
  'publicKeySpkiSha256',
]);
const CAPTURE_PROOF_FIELDS = Object.freeze([
  'captureNonce',
  'rawManifestSha256',
  'signature',
]);
const FIXED_ROW_VOICES = Object.freeze([
  'bass',
  'pad',
  'lead',
  'pluck',
  'pad',
]);

function fail(code) {
  throw new Error(code);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && !types.isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function enumerableDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
}

function exactObjectKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string')
    && expected.every((key) => (
      keys.includes(key) && enumerableDataProperty(value, key)
    ));
}

function ordinaryDenseArray(value, expectedLength = value?.length) {
  if (!Array.isArray(value)
      || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || value.length !== expectedLength) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedLength + 1 || !keys.includes('length')) {
    return false;
  }
  const keySet = new Set(keys);
  for (let index = 0; index < expectedLength; index += 1) {
    const key = String(index);
    if (!keySet.has(key) || !enumerableDataProperty(value, key)) return false;
  }
  return keys.every((key) => (
    key === 'length'
      || (typeof key === 'string'
        && /^(?:0|[1-9][0-9]*)$/.test(key)
        && Number(key) < expectedLength)
  ));
}

function validatorOwnedSnapshot(value, code) {
  try {
    const canonical = canonicalPhase5CaptureJson(value);
    return {
      canonical,
      value: JSON.parse(canonical),
    };
  } catch {
    fail(code);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalBase64(value, code) {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) fail(code);
  return decoded;
}

function parseEd25519SpkiBase64(value, code) {
  try {
    return parsePhase5CaptureEd25519Spki(value);
  } catch {
    fail(code);
  }
}

function parseSigner(signer) {
  if (!exactObjectKeys(signer, SIGNER_FIELDS)
      || signer.algorithm !== 'Ed25519'
      || typeof signer.publicKeySpkiSha256 !== 'string'
      || !HEX64.test(signer.publicKeySpkiSha256)) {
    fail('PHASE5_CAPTURE_PROOF_SIGNER_INVALID');
  }
  const { publicKey, spki } = parseEd25519SpkiBase64(
    signer.publicKeySpkiDerBase64,
    'PHASE5_CAPTURE_PROOF_SIGNER_INVALID',
  );
  if (sha256(spki) !== signer.publicKeySpkiSha256) {
    fail('PHASE5_CAPTURE_PROOF_SIGNER_INVALID');
  }
  return { publicKey, spki };
}

function validateRelease(release, code) {
  if (!exactObjectKeys(release, RELEASE_FIELDS)
      || typeof release.releaseManifestSha256 !== 'string'
      || !HEX64.test(release.releaseManifestSha256)
      || typeof release.releaseRevision !== 'string'
      || !HEX40.test(release.releaseRevision)
      || typeof release.sourceManifestSha256 !== 'string'
      || !HEX64.test(release.sourceManifestSha256)
      || typeof release.audioArtifactSha256 !== 'string'
      || !HEX64.test(release.audioArtifactSha256)) {
    fail(code);
  }
}

function validateGeometry(geometry, code) {
  if (!exactObjectKeys(geometry, GEOMETRY_FIELDS)
      || geometry.sampleRate !== 44_100
      || geometry.blockFrames !== 4_096
      || geometry.poolSize !== 5
      || !ordinaryDenseArray(
        geometry.rowVoices,
        FIXED_ROW_VOICES.length,
      )
      || geometry.rowVoices.some((voice, index) => (
        voice !== FIXED_ROW_VOICES[index]
      ))) {
    fail(code);
  }
}

function validateProfile(profile, code) {
  if (!exactObjectKeys(profile, PROFILE_FIELDS)
      || profile.clients !== 4
      || profile.slowClient !== 4
      || profile.durationMinutes !== 30
      || profile.speciesEndpoint !== 'http://127.0.0.1:8081/v1'
      || profile.speciesModel !== 'bird_agent') {
    fail(code);
  }
}

function validateIdentity(value, code) {
  if (typeof value.runId !== 'string'
      || !UUID_V4.test(value.runId)
      || typeof value.challenge !== 'string'
      || !HEX64.test(value.challenge)) {
    fail(code);
  }
  validateRelease(value.release, code);
  validateGeometry(value.geometry, code);
  validateProfile(value.profile, code);
}

function validateSigningInput(input) {
  if (!exactObjectKeys(input, SIGNING_INPUT_FIELDS)
      || typeof input.captureNonce !== 'string'
      || !HEX64.test(input.captureNonce)
      || typeof input.rawManifestSha256 !== 'string'
      || !HEX64.test(input.rawManifestSha256)) {
    fail('PHASE5_CAPTURE_PROOF_SIGNING_INPUT_INVALID');
  }
  try {
    validateIdentity(input, 'PHASE5_CAPTURE_PROOF_SIGNING_INPUT_INVALID');
    parseSigner(input.signer);
  } catch {
    fail('PHASE5_CAPTURE_PROOF_SIGNING_INPUT_INVALID');
  }
}

function validateSession(session) {
  if (!exactObjectKeys(session, SESSION_FIELDS)
      || session.schemaVersion !== 2
      || session.kind !== 'phase5-fault-session-attestation'
      || !exactObjectKeys(session.captureProof, CAPTURE_PROOF_FIELDS)
      || typeof session.captureProof.captureNonce !== 'string'
      || !HEX64.test(session.captureProof.captureNonce)
      || typeof session.captureProof.rawManifestSha256 !== 'string'
      || !HEX64.test(session.captureProof.rawManifestSha256)) {
    fail('PHASE5_CAPTURE_PROOF_SESSION_INVALID');
  }
  validateIdentity(session, 'PHASE5_CAPTURE_PROOF_SESSION_INVALID');
}

function validateRunBinding(runBinding) {
  if (!exactObjectKeys(runBinding, RUN_BINDING_FIELDS)
      || typeof runBinding.signerSpkiSha256 !== 'string'
      || !HEX64.test(runBinding.signerSpkiSha256)
      || typeof runBinding.faultSessionEvidenceSha256 !== 'string'
      || !HEX64.test(runBinding.faultSessionEvidenceSha256)
      || typeof runBinding.captureNonce !== 'string'
      || !HEX64.test(runBinding.captureNonce)
      || typeof runBinding.rawManifestSha256 !== 'string'
      || !HEX64.test(runBinding.rawManifestSha256)) {
    fail('PHASE5_CAPTURE_PROOF_RUN_BINDING_INVALID');
  }
  validateIdentity(
    runBinding,
    'PHASE5_CAPTURE_PROOF_RUN_BINDING_INVALID',
  );
}

function exactIdentityMatch(session, runBinding) {
  return session.runId === runBinding.runId
    && session.challenge === runBinding.challenge
    && session.signer.publicKeySpkiSha256
      === runBinding.signerSpkiSha256
    && session.captureProof.captureNonce === runBinding.captureNonce
    && session.captureProof.rawManifestSha256
      === runBinding.rawManifestSha256
    && canonicalPhase5CaptureJson(session.release)
      === canonicalPhase5CaptureJson(runBinding.release)
    && canonicalPhase5CaptureJson(session.geometry)
      === canonicalPhase5CaptureJson(runBinding.geometry)
    && canonicalPhase5CaptureJson(session.profile)
      === canonicalPhase5CaptureJson(runBinding.profile);
}

function signingInputFromSession(session) {
  return {
    runId: session.runId,
    challenge: session.challenge,
    release: session.release,
    geometry: session.geometry,
    profile: session.profile,
    signer: session.signer,
    captureNonce: session.captureProof.captureNonce,
    rawManifestSha256: session.captureProof.rawManifestSha256,
  };
}

function cloneRelease(release) {
  return {
    releaseManifestSha256: release.releaseManifestSha256,
    releaseRevision: release.releaseRevision,
    sourceManifestSha256: release.sourceManifestSha256,
    audioArtifactSha256: release.audioArtifactSha256,
  };
}

function cloneGeometry(geometry) {
  return {
    sampleRate: geometry.sampleRate,
    blockFrames: geometry.blockFrames,
    poolSize: geometry.poolSize,
    rowVoices: [...geometry.rowVoices],
  };
}

function cloneProfile(profile) {
  return {
    clients: profile.clients,
    slowClient: profile.slowClient,
    durationMinutes: profile.durationMinutes,
    speciesEndpoint: profile.speciesEndpoint,
    speciesModel: profile.speciesModel,
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function captureProofSigningBytes(input) {
  const snapshot = validatorOwnedSnapshot(
    input,
    'PHASE5_CAPTURE_PROOF_SIGNING_INPUT_INVALID',
  );
  validateSigningInput(snapshot.value);
  return Buffer.concat([
    SIGNING_DOMAIN,
    Buffer.from(snapshot.canonical, 'utf8'),
  ]);
}

export function validatePhase5CaptureProof(
  session,
  runBinding,
  trustedSignerSpkiDerBase64,
) {
  if (trustedSignerSpkiDerBase64 === undefined
      || trustedSignerSpkiDerBase64 === null
      || trustedSignerSpkiDerBase64 === '') {
    fail('PHASE5_CAPTURE_PROOF_TRUST_REQUIRED');
  }
  if (typeof trustedSignerSpkiDerBase64 !== 'string') {
    fail('PHASE5_CAPTURE_PROOF_TRUST_INVALID');
  }
  const trusted = parseEd25519SpkiBase64(
    trustedSignerSpkiDerBase64,
    'PHASE5_CAPTURE_PROOF_TRUST_INVALID',
  );
  const bindingSnapshot = validatorOwnedSnapshot(
    runBinding,
    'PHASE5_CAPTURE_PROOF_RUN_BINDING_INVALID',
  );
  validateRunBinding(bindingSnapshot.value);
  const sessionSnapshot = validatorOwnedSnapshot(
    session,
    'PHASE5_CAPTURE_PROOF_CANONICAL_JSON_INVALID',
  );
  validateSession(sessionSnapshot.value);

  const trustedBinding = bindingSnapshot.value;
  const trustedSession = sessionSnapshot.value;
  const embedded = parseSigner(trustedSession.signer);
  if (!embedded.spki.equals(trusted.spki)) {
    fail('PHASE5_CAPTURE_PROOF_SIGNER_BINDING_INVALID');
  }
  if (!exactIdentityMatch(trustedSession, trustedBinding)) {
    fail('PHASE5_CAPTURE_PROOF_RUN_BINDING_MISMATCH');
  }
  if (sha256(Buffer.from(sessionSnapshot.canonical, 'utf8'))
      !== trustedBinding.faultSessionEvidenceSha256) {
    fail('PHASE5_CAPTURE_PROOF_SESSION_DIGEST_MISMATCH');
  }

  const signature = canonicalBase64(
    trustedSession.captureProof.signature,
    'PHASE5_CAPTURE_PROOF_SIGNATURE_INVALID',
  );
  if (!ED25519_SIGNATURE_BASE64.test(
    trustedSession.captureProof.signature,
  ) || signature.length !== 64) {
    fail('PHASE5_CAPTURE_PROOF_SIGNATURE_INVALID');
  }
  const signingBytes = captureProofSigningBytes(
    signingInputFromSession(trustedSession),
  );
  if (!verify(null, signingBytes, embedded.publicKey, signature)) {
    fail('PHASE5_CAPTURE_PROOF_SIGNATURE_INVALID');
  }

  return deepFreeze({
    schemaVersion: 1,
    kind: 'phase5-capture-proof-validation-result',
    passed: true,
    runId: trustedBinding.runId,
    challenge: trustedBinding.challenge,
    release: cloneRelease(trustedBinding.release),
    geometry: cloneGeometry(trustedBinding.geometry),
    profile: cloneProfile(trustedBinding.profile),
    signerSpkiSha256: trustedBinding.signerSpkiSha256,
    faultSessionEvidenceSha256:
      trustedBinding.faultSessionEvidenceSha256,
    captureNonce: trustedBinding.captureNonce,
    rawManifestSha256: trustedBinding.rawManifestSha256,
  });
}
