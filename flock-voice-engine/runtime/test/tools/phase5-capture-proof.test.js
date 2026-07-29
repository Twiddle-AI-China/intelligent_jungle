import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import test from 'node:test';

import {
  canonicalJson,
  createEd25519SignerDescriptor,
} from '../../tools/lib/phase5-fault-evidence.mjs';
import {
  captureProofSigningBytes,
  validatePhase5CaptureProof,
} from '../../tools/lib/phase5-capture-proof.mjs';

const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const CHALLENGE = '1'.repeat(64);
const CAPTURE_NONCE = '2'.repeat(64);
const RAW_MANIFEST_SHA256 = '3'.repeat(64);
const RELEASE = Object.freeze({
  releaseManifestSha256: 'a'.repeat(64),
  releaseRevision: 'b'.repeat(40),
  sourceManifestSha256: 'c'.repeat(64),
  audioArtifactSha256: 'd'.repeat(64),
});
const GEOMETRY = Object.freeze({
  sampleRate: 44_100,
  blockFrames: 4_096,
  poolSize: 5,
  rowVoices: ['bass', 'pad', 'lead', 'pluck', 'pad'],
});
const PROFILE = Object.freeze({
  clients: 4,
  slowClient: 4,
  durationMinutes: 30,
  speciesEndpoint: 'http://127.0.0.1:8081/v1',
  speciesModel: 'bird_agent',
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function signingBody(session) {
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

function fixture(keyPair = generateKeyPairSync('ed25519')) {
  const session = {
    schemaVersion: 2,
    kind: 'phase5-fault-session-attestation',
    runId: RUN_ID,
    challenge: CHALLENGE,
    release: structuredClone(RELEASE),
    geometry: structuredClone(GEOMETRY),
    profile: structuredClone(PROFILE),
    signer: createEd25519SignerDescriptor(keyPair.publicKey),
    captureProof: {
      captureNonce: CAPTURE_NONCE,
      rawManifestSha256: RAW_MANIFEST_SHA256,
      signature: '',
    },
  };
  session.captureProof.signature = sign(
    null,
    captureProofSigningBytes(signingBody(session)),
    keyPair.privateKey,
  ).toString('base64');
  const runBinding = {
    runId: session.runId,
    challenge: session.challenge,
    release: structuredClone(session.release),
    geometry: structuredClone(session.geometry),
    profile: structuredClone(session.profile),
    signerSpkiSha256: session.signer.publicKeySpkiSha256,
    faultSessionEvidenceSha256: sha256(
      Buffer.from(canonicalJson(session), 'utf8'),
    ),
    captureNonce: session.captureProof.captureNonce,
    rawManifestSha256: session.captureProof.rawManifestSha256,
  };
  return {
    session,
    runBinding,
    trustedSignerSpkiDerBase64: session.signer.publicKeySpkiDerBase64,
    keyPair,
  };
}

function verify(value = fixture()) {
  return validatePhase5CaptureProof(
    value.session,
    value.runBinding,
    value.trustedSignerSpkiDerBase64,
  );
}

function resign(value) {
  value.session.captureProof.signature = sign(
    null,
    captureProofSigningBytes(signingBody(value.session)),
    value.keyPair.privateKey,
  ).toString('base64');
  value.runBinding.faultSessionEvidenceSha256 = sha256(
    Buffer.from(canonicalJson(value.session), 'utf8'),
  );
}

test('capture proof signing bytes have the fixed domain and exact canonical body', () => {
  const value = fixture();
  const body = signingBody(value.session);
  assert.deepEqual(
    captureProofSigningBytes(body),
    Buffer.concat([
      Buffer.from('flock-phase5-capture-proof-v1\0', 'utf8'),
      Buffer.from(canonicalJson(body), 'utf8'),
    ]),
  );
});

test('valid proof verifies into an owned deeply frozen projection', () => {
  const value = fixture();
  const result = verify(value);
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: 'phase5-capture-proof-validation-result',
    passed: true,
    runId: RUN_ID,
    challenge: CHALLENGE,
    release: RELEASE,
    geometry: GEOMETRY,
    profile: PROFILE,
    signerSpkiSha256: value.session.signer.publicKeySpkiSha256,
    faultSessionEvidenceSha256: value.runBinding.faultSessionEvidenceSha256,
    captureNonce: CAPTURE_NONCE,
    rawManifestSha256: RAW_MANIFEST_SHA256,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.release), true);
  assert.equal(Object.isFrozen(result.geometry.rowVoices), true);

  value.session.release.releaseManifestSha256 = 'e'.repeat(64);
  value.runBinding.profile.clients = 3;
  assert.equal(result.release.releaseManifestSha256, 'a'.repeat(64));
  assert.equal(result.profile.clients, 4);
});

test('embedded signer is never accepted as its own trust root', () => {
  const value = fixture();
  for (const externalTrust of [
    undefined,
    null,
    '',
    value.session.signer,
    value.session.signer.publicKeySpkiSha256,
  ]) {
    assert.throws(
      () => validatePhase5CaptureProof(
        value.session,
        value.runBinding,
        externalTrust,
      ),
      /PHASE5_CAPTURE_PROOF_TRUST_(?:REQUIRED|INVALID)/,
    );
  }
});

test('wrong external Ed25519 SPKI cannot validate an internally consistent proof', () => {
  const value = fixture();
  const wrong = createEd25519SignerDescriptor(
    generateKeyPairSync('ed25519').publicKey,
  );
  assert.throws(
    () => validatePhase5CaptureProof(
      value.session,
      value.runBinding,
      wrong.publicKeySpkiDerBase64,
    ),
    /PHASE5_CAPTURE_PROOF_SIGNER_BINDING_INVALID/,
  );
});

test('attacker-selected embedded signer remains rejected after complete re-signing', () => {
  const trusted = fixture();
  const attacker = fixture(generateKeyPairSync('ed25519'));
  assert.throws(
    () => validatePhase5CaptureProof(
      attacker.session,
      attacker.runBinding,
      trusted.trustedSignerSpkiDerBase64,
    ),
    /PHASE5_CAPTURE_PROOF_SIGNER_BINDING_INVALID/,
  );
});

test('session, captureProof and signer have exact data-only shapes', () => {
  const attacks = [
    ['session extra', (value) => { value.session.extra = true; }],
    ['session missing', (value) => { delete value.session.kind; }],
    ['proof extra', (value) => { value.session.captureProof.extra = true; }],
    ['proof missing', (value) => { delete value.session.captureProof.captureNonce; }],
    ['signer extra', (value) => { value.session.signer.extra = true; }],
    ['signer missing', (value) => {
      delete value.session.signer.publicKeySpkiSha256;
    }],
  ];
  for (const [name, mutate] of attacks) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => verify(value),
      /PHASE5_CAPTURE_PROOF_(?:SESSION|SIGNER|CANONICAL_JSON)_INVALID/,
      name,
    );
  }
});

test('run binding has the exact v2 capture fields and no hidden authority', () => {
  const attacks = [
    ['extra', (value) => { value.runBinding.extra = true; }],
    ['missing nonce', (value) => { delete value.runBinding.captureNonce; }],
    ['missing manifest', (value) => {
      delete value.runBinding.rawManifestSha256;
    }],
    ['missing session digest', (value) => {
      delete value.runBinding.faultSessionEvidenceSha256;
    }],
  ];
  for (const [name, mutate] of attacks) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => verify(value),
      /PHASE5_CAPTURE_PROOF_RUN_BINDING_INVALID/,
      name,
    );
  }
});

test('run, challenge, release, geometry, profile and signer are cross-bound', () => {
  const attacks = [
    ['run', (binding) => {
      binding.runId = '123e4567-e89b-42d3-a456-426614174001';
    }],
    ['challenge', (binding) => { binding.challenge = 'e'.repeat(64); }],
    ['release', (binding) => {
      binding.release.releaseManifestSha256 = 'e'.repeat(64);
    }],
    ['geometry', (binding) => { binding.geometry.poolSize = 4; }],
    ['profile', (binding) => { binding.profile.clients = 3; }],
    ['signer', (binding) => { binding.signerSpkiSha256 = 'e'.repeat(64); }],
  ];
  for (const [name, mutate] of attacks) {
    const value = fixture();
    mutate(value.runBinding);
    assert.throws(
      () => verify(value),
      /PHASE5_CAPTURE_PROOF_(?:RUN_BINDING_INVALID|RUN_BINDING_MISMATCH)/,
      name,
    );
  }
});

test('proof cannot replay onto a different run even with a rebound session digest', () => {
  const value = fixture();
  value.session.runId = '123e4567-e89b-42d3-a456-426614174001';
  value.runBinding.runId = value.session.runId;
  value.runBinding.faultSessionEvidenceSha256 = sha256(
    Buffer.from(canonicalJson(value.session), 'utf8'),
  );
  assert.throws(
    () => verify(value),
    /PHASE5_CAPTURE_PROOF_SIGNATURE_INVALID/,
  );
});

test('proof cannot replay onto a different manifest or capture nonce', () => {
  for (const field of ['rawManifestSha256', 'captureNonce']) {
    const value = fixture();
    value.session.captureProof[field] = 'e'.repeat(64);
    value.runBinding[field] = value.session.captureProof[field];
    value.runBinding.faultSessionEvidenceSha256 = sha256(
      Buffer.from(canonicalJson(value.session), 'utf8'),
    );
    assert.throws(
      () => verify(value),
      /PHASE5_CAPTURE_PROOF_SIGNATURE_INVALID/,
      field,
    );
  }
});

test('session digest in the binding must match the canonical owned session', () => {
  const value = fixture();
  value.runBinding.faultSessionEvidenceSha256 = 'e'.repeat(64);
  assert.throws(
    () => verify(value),
    /PHASE5_CAPTURE_PROOF_SESSION_DIGEST_MISMATCH/,
  );
});

test('signature must be canonical 64-byte Ed25519 base64 and cryptographically valid', () => {
  const invalid = [
    Buffer.alloc(63).toString('base64'),
    Buffer.alloc(65).toString('base64'),
    'A'.repeat(86) + '=A',
    Buffer.alloc(64, 1).toString('base64'),
    true,
  ];
  for (const signature of invalid) {
    const value = fixture();
    value.session.captureProof.signature = signature;
    value.runBinding.faultSessionEvidenceSha256 = sha256(
      Buffer.from(canonicalJson(value.session), 'utf8'),
    );
    assert.throws(
      () => verify(value),
      /PHASE5_CAPTURE_PROOF_SIGNATURE_INVALID/,
    );
  }
});

test('signer descriptor requires canonical Ed25519 SPKI bytes and matching digest', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const attacks = [
    ['algorithm', (signer) => { signer.algorithm = 'ed25519'; }],
    ['digest', (signer) => { signer.publicKeySpkiSha256 = 'e'.repeat(64); }],
    ['noncanonical base64', (signer) => {
      signer.publicKeySpkiDerBase64 = `${signer.publicKeySpkiDerBase64}\n`;
    }],
    ['rsa key', (signer) => {
      const bytes = rsa.publicKey.export({ type: 'spki', format: 'der' });
      signer.publicKeySpkiDerBase64 = bytes.toString('base64');
      signer.publicKeySpkiSha256 = sha256(bytes);
    }],
  ];
  for (const [name, mutate] of attacks) {
    const value = fixture();
    mutate(value.session.signer);
    assert.throws(
      () => verify(value),
      /PHASE5_CAPTURE_PROOF_SIGNER_INVALID/,
      name,
    );
  }
});

test('external trust input must itself be canonical Ed25519 SPKI base64', () => {
  const value = fixture();
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaSpki = rsa.publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  for (const trust of [
    `${value.trustedSignerSpkiDerBase64}\n`,
    rsaSpki,
    'not-base64',
  ]) {
    assert.throws(
      () => validatePhase5CaptureProof(value.session, value.runBinding, trust),
      /PHASE5_CAPTURE_PROOF_TRUST_INVALID/,
    );
  }
});

test('fixed session identity rejects malformed and almost-correct values', () => {
  const attacks = [
    ['version bool', (session) => { session.schemaVersion = true; }],
    ['kind', (session) => { session.kind = 'other'; }],
    ['run uuid', (session) => { session.runId = 'not-a-uuid'; }],
    ['challenge uppercase', (session) => { session.challenge = 'A'.repeat(64); }],
    ['revision', (session) => { session.release.releaseRevision = 'b'.repeat(39); }],
    ['sample rate bool', (session) => { session.geometry.sampleRate = true; }],
    ['voices', (session) => { session.geometry.rowVoices[4] = 'lead'; }],
    ['clients', (session) => { session.profile.clients = 3; }],
    ['endpoint', (session) => {
      session.profile.speciesEndpoint = 'http://localhost:8081/v1';
    }],
    ['nonce uppercase', (session) => {
      session.captureProof.captureNonce = 'A'.repeat(64);
    }],
    ['manifest short', (session) => {
      session.captureProof.rawManifestSha256 = '3'.repeat(63);
    }],
  ];
  for (const [name, mutate] of attacks) {
    const value = fixture();
    mutate(value.session);
    assert.throws(
      () => verify(value),
      /PHASE5_CAPTURE_PROOF_SESSION_INVALID/,
      name,
    );
  }
});

test('signing input has exact shape and rejects hidden or malformed values', () => {
  const value = fixture();
  const attacks = [
    ['extra', (body) => { body.extra = true; }],
    ['missing', (body) => { delete body.captureNonce; }],
    ['bad nonce', (body) => { body.captureNonce = 'x'.repeat(64); }],
    ['bad manifest', (body) => { body.rawManifestSha256 = '3'.repeat(63); }],
  ];
  for (const [name, mutate] of attacks) {
    const body = signingBody(value.session);
    mutate(body);
    assert.throws(
      () => captureProofSigningBytes(body),
      /PHASE5_CAPTURE_PROOF_SIGNING_INPUT_INVALID/,
      name,
    );
  }
});

test('accessors, symbols, non-enumerable state, exotic prototypes and proxies fail closed', () => {
  const attacks = [
    ['symbol', (value) => { value.session[Symbol('hidden')] = true; }],
    ['non-enumerable', (value) => {
      Object.defineProperty(value.session, 'hidden', { value: true });
    }],
    ['null prototype', (value) => {
      value.session.release = Object.assign(
        Object.create(null),
        value.session.release,
      );
    }],
    ['custom array prototype', (value) => {
      Object.setPrototypeOf(
        value.session.geometry.rowVoices,
        Object.create(Array.prototype),
      );
    }],
    ['proxy', (value) => {
      value.session.profile = new Proxy(value.session.profile, {});
    }],
  ];
  for (const [name, mutate] of attacks) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => verify(value),
      /PHASE5_CAPTURE_PROOF_(?:CANONICAL_JSON|SESSION)_INVALID/,
      name,
    );
  }

  const value = fixture();
  let reads = 0;
  Object.defineProperty(value.session, 'kind', {
    enumerable: true,
    get() {
      reads += 1;
      return 'phase5-fault-session-attestation';
    },
  });
  assert.throws(
    () => verify(value),
    /PHASE5_CAPTURE_PROOF_CANONICAL_JSON_INVALID/,
  );
  assert.equal(reads, 0);
});

test('signature verification uses one validator-owned snapshot, not mutable aliases', () => {
  const value = fixture();
  const originalSession = structuredClone(value.session);
  const originalBinding = structuredClone(value.runBinding);
  const result = verify(value);

  value.session.captureProof.captureNonce = 'e'.repeat(64);
  value.session.release.audioArtifactSha256 = 'e'.repeat(64);
  value.runBinding.rawManifestSha256 = 'e'.repeat(64);

  assert.equal(result.captureNonce, originalSession.captureProof.captureNonce);
  assert.equal(
    result.rawManifestSha256,
    originalBinding.rawManifestSha256,
  );
  assert.equal(
    result.release.audioArtifactSha256,
    originalSession.release.audioArtifactSha256,
  );
});

test('proof verifier does not claim one-time finalize or socket possession', () => {
  const value = fixture();
  const first = verify(value);
  const repeated = verify(value);
  assert.deepEqual(repeated, first);
  assert.equal(Object.hasOwn(first, 'finalized'), false);
  assert.equal(Object.hasOwn(first, 'socketPossession'), false);
  assert.equal(Object.hasOwn(first, 'onceOnly'), false);
});
