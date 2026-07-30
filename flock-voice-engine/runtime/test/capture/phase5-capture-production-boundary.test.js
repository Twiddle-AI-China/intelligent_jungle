import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  assertPhase5CaptureAdmissionBinding,
  canonicalPhase5CaptureJson,
  copyPhase5CaptureBytes,
  createPhase5CaptureSignerDescriptor,
  decodePhase5CaptureCanonicalLine,
  encodePhase5CaptureCanonicalLine,
  parsePhase5CaptureEd25519Spki,
  validatePhase5CaptureAdmission,
} from '../../src/capture/capture-wire.js';
import * as canonicalProof
  from '../../src/capture/phase5-capture-proof.js';
import * as canonicalFinalizer
  from '../../src/capture/phase5-capture-finalizer.js';
import {
  createPhase5FaultSessionAuthority,
} from '../../src/acceptance/phase5-fault-session-authority.js';
import * as canonicalProtocol
  from '../../src/capture/phase5-capture-channel-protocol.js';
import * as canonicalServer
  from '../../src/capture/phase5-capture-channel-server.js';
import * as toolProof
  from '../../tools/lib/phase5-capture-proof.mjs';
import * as toolFinalizer
  from '../../tools/lib/phase5-capture-finalizer.mjs';
import * as toolProtocol
  from '../../tools/lib/phase5-capture-channel-protocol.mjs';
import * as toolServer
  from '../../tools/lib/phase5-capture-channel-server.mjs';

const IDENTITY = Object.freeze({
  runId: '123e4567-e89b-42d3-a456-426614174000',
  challenge: '1'.repeat(64),
  release: Object.freeze({
    releaseManifestSha256: '2'.repeat(64),
    releaseRevision: '3'.repeat(40),
    sourceManifestSha256: '4'.repeat(64),
    audioArtifactSha256: '5'.repeat(64),
  }),
  geometry: Object.freeze({
    sampleRate: 44_100,
    blockFrames: 4_096,
    poolSize: 5,
    rowVoices: Object.freeze([
      'bass', 'pad', 'lead', 'pluck', 'pad',
    ]),
  }),
  profile: Object.freeze({
    clients: 4,
    slowClient: 4,
    durationMinutes: 30,
    speciesEndpoint: 'http://127.0.0.1:8081/v1',
    speciesModel: 'bird_agent',
  }),
});
const CAPTURE_NONCE_BYTES = Buffer.alloc(32, 0x88);
const CAPTURE_NONCE = CAPTURE_NONCE_BYTES.toString('hex');

function finalizerError(code) {
  return (error) => (
    error instanceof canonicalFinalizer.Phase5CaptureFinalizerError
    && error.code === code
  );
}

test('production finalizer accepts only the authority-owned capture capability', () => {
  assert.throws(
    () => canonicalFinalizer.createPhase5CandidateCaptureFinalizer({
      identity: structuredClone(IDENTITY),
    }),
    finalizerError('PHASE5_CAPTURE_FINALIZER_INPUT_INVALID'),
  );
  assert.throws(
    () => canonicalFinalizer.createPhase5CandidateCaptureFinalizer({
      identity: structuredClone(IDENTITY),
      nonceBytesFactory: () => Buffer.from(CAPTURE_NONCE_BYTES),
    }),
    finalizerError('PHASE5_CAPTURE_FINALIZER_INPUT_INVALID'),
  );

  const nonce = Buffer.from(CAPTURE_NONCE_BYTES);
  const authority = createPhase5FaultSessionAuthority({
    identity: structuredClone(IDENTITY),
    captureNonceBytes: nonce,
  });
  const finalizer =
    canonicalFinalizer.createPhase5CandidateCaptureFinalizer({
      faultSessionAuthority: authority,
    });
  nonce.fill(0);

  assert.equal(
    finalizer.getAdmission().captureNonce,
    CAPTURE_NONCE,
  );
});

test('capture wire owns bytes and rejects non-canonical line input', () => {
  const source = Buffer.from('hello');
  const owned = copyPhase5CaptureBytes(source, 5);
  source.fill(0);
  assert.equal(owned.toString('utf8'), 'hello');

  const value = { schemaVersion: 1, kind: 'example' };
  const encoded = encodePhase5CaptureCanonicalLine(value, 128);
  assert.equal(
    encoded.toString('utf8'),
    `${canonicalPhase5CaptureJson(value)}\n`,
  );
  assert.deepEqual(
    decodePhase5CaptureCanonicalLine(encoded, 128),
    value,
  );
  assert.throws(
    () => decodePhase5CaptureCanonicalLine(
      Buffer.from(` ${encoded.toString('utf8')}`),
      128,
    ),
    /PHASE5_CAPTURE_WIRE_CANONICAL_LINE_INVALID/,
  );
});

test('capture admission validation owns and binds nonce identity and SPKI', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const signer = createPhase5CaptureSignerDescriptor(publicKey);
  const parsed = parsePhase5CaptureEd25519Spki(
    signer.publicKeySpkiDerBase64,
  );
  assert.equal(parsed.publicKey.asymmetricKeyType, 'ed25519');
  assert.equal(
    parsed.spki.toString('base64'),
    signer.publicKeySpkiDerBase64,
  );
  const input = {
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-admission',
    runId: IDENTITY.runId,
    challenge: IDENTITY.challenge,
    captureNonce: CAPTURE_NONCE,
    signerSpkiSha256: signer.publicKeySpkiSha256,
    trustedSignerSpkiDerBase64: signer.publicKeySpkiDerBase64,
  };
  const validated = validatePhase5CaptureAdmission(input);
  input.runId = 'ffffffff-ffff-4fff-afff-ffffffffffff';

  assert.equal(validated.runId, IDENTITY.runId);
  assert.ok(Object.isFrozen(validated));
  assert.strictEqual(
    assertPhase5CaptureAdmissionBinding(validated, {
      runId: IDENTITY.runId,
      challenge: IDENTITY.challenge,
      captureNonce: CAPTURE_NONCE,
    }),
    validated,
  );
  assert.throws(
    () => assertPhase5CaptureAdmissionBinding(validated, {
      runId: IDENTITY.runId,
      challenge: IDENTITY.challenge,
      captureNonce: '0'.repeat(64),
    }),
    /PHASE5_CAPTURE_ADMISSION_BINDING_MISMATCH/,
  );
});

test('tool capture modules are compatibility re-exports of canonical src', () => {
  assert.strictEqual(
    toolProof.validatePhase5CaptureProof,
    canonicalProof.validatePhase5CaptureProof,
  );
  assert.strictEqual(
    toolFinalizer.createPhase5CandidateCaptureFinalizer,
    canonicalFinalizer.createPhase5CandidateCaptureFinalizer,
  );
  assert.strictEqual(
    toolProtocol.createPhase5CaptureChannelProtocol,
    canonicalProtocol.createPhase5CaptureChannelProtocol,
  );
  assert.strictEqual(
    toolServer.startPhase5CaptureChannelServer,
    canonicalServer.startPhase5CaptureChannelServer,
  );
});
