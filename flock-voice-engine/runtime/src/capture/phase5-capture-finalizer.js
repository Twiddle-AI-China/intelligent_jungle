import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { types } from 'node:util';

import {
  canonicalPhase5CaptureJson,
  copyPhase5CaptureBytes,
  createPhase5CaptureSignerDescriptor,
} from './capture-wire.js';
import {
  captureProofSigningBytes,
  validatePhase5CaptureProof,
} from './phase5-capture-proof.js';

const SIGNING_DOMAIN =
  Buffer.from('flock-phase5-capture-proof-v1\0', 'utf8');
const IDENTITY_FIELDS = Object.freeze([
  'runId',
  'challenge',
  'release',
  'geometry',
  'profile',
]);
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE_BYTES = 32;

function fail(code) {
  throw new Phase5CaptureFinalizerError(code);
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

function exactOptions(value) {
  return exactPlainDataObject(
    value,
    ['identity', 'captureNonceBytes'],
  );
}

function dataPropertyValue(value, key) {
  return Object.getOwnPropertyDescriptor(value, key).value;
}

function ownedJson(value) {
  return JSON.parse(canonicalPhase5CaptureJson(value));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validatedOwnedIdentity({
  identity,
  signer,
  captureNonce,
}) {
  if (!exactPlainDataObject(identity, IDENTITY_FIELDS)) {
    throw new Error('IDENTITY_INVALID');
  }
  const provisional = {
    runId: dataPropertyValue(identity, 'runId'),
    challenge: dataPropertyValue(identity, 'challenge'),
    release: dataPropertyValue(identity, 'release'),
    geometry: dataPropertyValue(identity, 'geometry'),
    profile: dataPropertyValue(identity, 'profile'),
    signer,
    captureNonce,
    rawManifestSha256: '0'.repeat(64),
  };
  const signingBytes = captureProofSigningBytes(provisional);
  if (!Buffer.from(
    signingBytes.subarray(0, SIGNING_DOMAIN.length),
  ).equals(SIGNING_DOMAIN)) {
    throw new Error('SIGNING_DOMAIN_INVALID');
  }
  const owned = JSON.parse(
    Buffer.from(signingBytes.subarray(SIGNING_DOMAIN.length))
      .toString('utf8'),
  );
  return {
    runId: owned.runId,
    challenge: owned.challenge,
    release: owned.release,
    geometry: owned.geometry,
    profile: owned.profile,
  };
}

export class Phase5CaptureFinalizerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5CaptureFinalizerError';
    this.code = code;
  }
}

export function createPhase5CandidateCaptureFinalizer(options = {}) {
  let privateKey;
  let signer;
  let captureNonce;
  let ownedIdentity;
  try {
    if (!exactOptions(options)) {
      throw new Error('OPTIONS_INVALID');
    }
    const identity = dataPropertyValue(options, 'identity');
    const captureNonceBytes = dataPropertyValue(
      options,
      'captureNonceBytes',
    );
    const generated = generateKeyPairSync('ed25519');
    privateKey = generated.privateKey;
    if (privateKey.asymmetricKeyType !== 'ed25519'
        || generated.publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('PRIVATE_KEY_INVALID');
    }
    signer = createPhase5CaptureSignerDescriptor(
      generated.publicKey,
    );
    if (!createPublicKey(privateKey).equals(generated.publicKey)) {
      throw new Error('KEY_PAIR_INVALID');
    }

    const nonce = copyPhase5CaptureBytes(
      captureNonceBytes,
      NONCE_BYTES,
    );
    if (nonce.byteLength !== NONCE_BYTES) {
      throw new Error('NONCE_INVALID');
    }
    captureNonce = nonce.toString('hex');
    ownedIdentity = validatedOwnedIdentity({
      identity,
      signer,
      captureNonce,
    });
  } catch {
    privateKey = null;
    fail('PHASE5_CAPTURE_FINALIZER_INPUT_INVALID');
  }

  const admission = {
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-admission',
    runId: ownedIdentity.runId,
    challenge: ownedIdentity.challenge,
    captureNonce,
    signerSpkiSha256: signer.publicKeySpkiSha256,
    trustedSignerSpkiDerBase64: signer.publicKeySpkiDerBase64,
  };
  let state = 'ready';

  function getAdmission(...args) {
    if (args.length !== 0) {
      fail('PHASE5_CAPTURE_FINALIZER_INPUT_INVALID');
    }
    return ownedJson(admission);
  }

  function finalize(...args) {
    if (state !== 'ready') {
      fail('PHASE5_CAPTURE_FINALIZER_ALREADY_USED');
    }
    state = 'used';
    try {
      if (args.length !== 1
          || typeof args[0] !== 'string'
          || !HEX64.test(args[0])) {
        fail('PHASE5_CAPTURE_FINALIZER_MANIFEST_INVALID');
      }
      const rawManifestSha256 = args[0];
      const signingInput = {
        ...ownedIdentity,
        signer,
        captureNonce,
        rawManifestSha256,
      };
      const signature = sign(
        null,
        captureProofSigningBytes(signingInput),
        privateKey,
      ).toString('base64');
      const session = {
        schemaVersion: 2,
        kind: 'phase5-fault-session-attestation',
        ...ownedIdentity,
        signer,
        captureProof: {
          captureNonce,
          rawManifestSha256,
          signature,
        },
      };
      const sessionBytes = Buffer.from(
        canonicalPhase5CaptureJson(session),
        'utf8',
      );
      const runBinding = {
        ...ownedIdentity,
        signerSpkiSha256: signer.publicKeySpkiSha256,
        faultSessionEvidenceSha256: sha256(sessionBytes),
        captureNonce,
        rawManifestSha256,
      };
      const captureValidation = validatePhase5CaptureProof(
        session,
        runBinding,
        admission.trustedSignerSpkiDerBase64,
      );
      return Object.freeze({
        sessionBytes: Buffer.from(sessionBytes),
        runBinding: ownedJson(runBinding),
        captureValidation,
      });
    } catch (error) {
      if (error instanceof Phase5CaptureFinalizerError) throw error;
      fail('PHASE5_CAPTURE_FINALIZER_FAILED');
    } finally {
      privateKey = null;
    }
  }

  return Object.freeze({
    getAdmission,
    finalize,
  });
}
