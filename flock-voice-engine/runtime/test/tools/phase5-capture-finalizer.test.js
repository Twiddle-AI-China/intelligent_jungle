import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canonicalJson } from '../../tools/lib/phase5-fault-evidence.mjs';
import {
  validatePhase5CaptureProof,
} from '../../tools/lib/phase5-capture-proof.mjs';
import {
  Phase5CaptureFinalizerError,
  createPhase5CandidateCaptureFinalizer,
} from '../../tools/lib/phase5-capture-finalizer.mjs';
import {
  _createPhase5FaultSessionAuthority,
  createPhase5FaultSessionAuthority,
  Phase5FaultSessionAuthorityError,
} from '../../src/acceptance/phase5-fault-session-authority.js';
import {
  signedFixture,
} from './phase5-fault-validation-fixture.js';

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
const RAW_MANIFEST_SHA256 = '9'.repeat(64);
const finalizerSource = await readFile(
  new URL('../../src/capture/phase5-capture-finalizer.js', import.meta.url),
  'utf8',
);

function fixture(overrides = {}) {
  const prepared = preparedAuthority(overrides);
  prepared.complete();
  return {
    finalizer: createPhase5CandidateCaptureFinalizer({
      faultSessionAuthority: prepared.authority,
    }),
    ...prepared,
  };
}

function preparedAuthority(overrides = {}) {
  const source = signedFixture().evidence;
  let scenarioCursor = 0;
  let transportCursor = 0;
  const bridge = Object.freeze({
    flushTransportObservations() {
      return [];
    },
    payloadFor(plan) {
      const event = source.scenarioEvents[scenarioCursor];
      assert.equal(plan.scenario, event.scenario);
      assert.equal(plan.phase, event.phase);
      scenarioCursor += 1;
      return {
        atMonotonicMs: event.atMonotonicMs,
        atUnixMs: event.atUnixMs,
        payload: structuredClone(event.payload),
      };
    },
    commitSignedAction() {},
    dispatchFixedInstruction() {},
  });
  const identity = overrides.identity ?? structuredClone(IDENTITY);
  const captureNonceBytes = overrides.captureNonceBytes
    ?? Buffer.from(CAPTURE_NONCE_BYTES);
  const authority = _createPhase5FaultSessionAuthority({
    identity,
    captureNonceBytes,
    window: structuredClone(source.window),
    bridge,
  });
  return {
    authority,
    source,
    complete() {
      for (const scenario of source.scenarioEvents) {
        while (transportCursor < scenario.transportPrefixCount) {
          const event = source.transportEvents[transportCursor];
          authority.appendTransportObservation({
            atMonotonicMs: event.atMonotonicMs,
            atUnixMs: event.atUnixMs,
            client: event.client,
            type: event.type,
            payload: structuredClone(event.payload),
          });
          transportCursor += 1;
        }
        authority.advance();
      }
      while (transportCursor < source.transportEvents.length) {
        const event = source.transportEvents[transportCursor];
        authority.appendTransportObservation({
          atMonotonicMs: event.atMonotonicMs,
          atUnixMs: event.atUnixMs,
          client: event.client,
          type: event.type,
          payload: structuredClone(event.payload),
        });
        transportCursor += 1;
      }
      authority.closeFaultWindow();
    },
  };
}

function errorCode(code) {
  return (error) => (
    error instanceof Phase5CaptureFinalizerError
    && error.code === code
  );
}

function authorityErrorCode(code) {
  return (error) => (
    error instanceof Phase5FaultSessionAuthorityError
    && error.code === code
  );
}

test('finalizes one manifest into a canonical v2 session and full binding', () => {
  const { finalizer } = fixture();
  const admission = finalizer.getAdmission();

  assert.deepEqual(admission, {
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-admission',
    runId: IDENTITY.runId,
    challenge: IDENTITY.challenge,
    captureNonce: CAPTURE_NONCE,
    signerSpkiSha256: admission.signerSpkiSha256,
    trustedSignerSpkiDerBase64:
      admission.trustedSignerSpkiDerBase64,
  });

  const result = finalizer.finalize(RAW_MANIFEST_SHA256);
  const session = JSON.parse(result.sessionBytes.toString('utf8'));
  assert.equal(
    result.sessionBytes.toString('utf8'),
    canonicalJson(session),
  );
  assert.deepEqual(session, {
    schemaVersion: 2,
    kind: 'phase5-fault-session-attestation',
    ...IDENTITY,
    signer: {
      algorithm: 'Ed25519',
      publicKeySpkiDerBase64:
        admission.trustedSignerSpkiDerBase64,
      publicKeySpkiSha256: admission.signerSpkiSha256,
    },
    captureProof: {
      captureNonce: CAPTURE_NONCE,
      rawManifestSha256: RAW_MANIFEST_SHA256,
      signature: session.captureProof.signature,
    },
  });
  assert.deepEqual(
    validatePhase5CaptureProof(
      session,
      result.runBinding,
      admission.trustedSignerSpkiDerBase64,
    ),
    result.captureValidation,
  );
  assert.equal(
    result.runBinding.faultSessionEvidenceSha256,
    result.captureValidation.faultSessionEvidenceSha256,
  );
  assert.equal(result.runBinding.captureNonce, CAPTURE_NONCE);
  assert.equal(
    result.runBinding.rawManifestSha256,
    RAW_MANIFEST_SHA256,
  );
  assert.equal(
    Object.hasOwn(result, 'privateKey'),
    false,
  );
});

test('owns identity and nonce before callers can mutate', () => {
  const identity = structuredClone(IDENTITY);
  const nonce = Buffer.from(CAPTURE_NONCE_BYTES);
  const prepared = preparedAuthority({
    identity,
    captureNonceBytes: nonce,
  });
  const finalizer = createPhase5CandidateCaptureFinalizer({
    faultSessionAuthority: prepared.authority,
  });
  const admission = finalizer.getAdmission();

  identity.runId = 'ffffffff-ffff-4fff-afff-ffffffffffff';
  identity.release.releaseRevision = 'f'.repeat(40);
  identity.geometry.rowVoices[0] = 'attacker';
  identity.profile.speciesModel = 'attacker';
  nonce.fill(0);

  prepared.complete();
  const result = finalizer.finalize(RAW_MANIFEST_SHA256);
  const session = JSON.parse(result.sessionBytes.toString('utf8'));
  assert.equal(session.runId, IDENTITY.runId);
  assert.deepEqual(session.release, IDENTITY.release);
  assert.deepEqual(session.geometry, IDENTITY.geometry);
  assert.deepEqual(session.profile, IDENTITY.profile);
  validatePhase5CaptureProof(
    session,
    result.runBinding,
    admission.trustedSignerSpkiDerBase64,
  );
});

test('nonce and admission are caller-independent owned snapshots', () => {
  const nonce = Buffer.from(CAPTURE_NONCE_BYTES);
  const { finalizer } = fixture({
    captureNonceBytes: nonce,
  });
  nonce.fill(0);

  const first = finalizer.getAdmission();
  first.runId = 'ffffffff-ffff-4fff-afff-ffffffffffff';
  first.captureNonce = '0'.repeat(64);
  const second = finalizer.getAdmission();

  assert.equal(second.runId, IDENTITY.runId);
  assert.equal(second.captureNonce, CAPTURE_NONCE);
  assert.notEqual(first, second);
});

test('successful finalize is one-shot and cannot be replayed', () => {
  const { finalizer } = fixture();

  finalizer.finalize(RAW_MANIFEST_SHA256);

  assert.throws(
    () => finalizer.finalize(RAW_MANIFEST_SHA256),
    errorCode('PHASE5_CAPTURE_FINALIZER_ALREADY_USED'),
  );
  assert.throws(
    () => finalizer.finalize('a'.repeat(64)),
    errorCode('PHASE5_CAPTURE_FINALIZER_ALREADY_USED'),
  );
});

test('an invalid first finalize attempt consumes and seals the finalizer', () => {
  const { finalizer } = fixture();

  assert.throws(
    () => finalizer.finalize('not-a-digest'),
    errorCode('PHASE5_CAPTURE_FINALIZER_MANIFEST_INVALID'),
  );
  assert.throws(
    () => finalizer.finalize(RAW_MANIFEST_SHA256),
    errorCode('PHASE5_CAPTURE_FINALIZER_ALREADY_USED'),
  );
});

test('capture proof is unavailable until the same authority closes the fault window', () => {
  const authority = createPhase5FaultSessionAuthority({
    identity: structuredClone(IDENTITY),
    captureNonceBytes: Buffer.from(CAPTURE_NONCE_BYTES),
  });
  const finalizer = createPhase5CandidateCaptureFinalizer({
    faultSessionAuthority: authority,
  });

  assert.throws(
    () => finalizer.finalize(RAW_MANIFEST_SHA256),
    errorCode('PHASE5_CAPTURE_FINALIZER_FAULT_WINDOW_INCOMPLETE'),
  );
  assert.throws(
    () => finalizer.finalize(RAW_MANIFEST_SHA256),
    errorCode('PHASE5_CAPTURE_FINALIZER_ALREADY_USED'),
  );
});

test('identity must be an exact proxy-free capture contract', () => {
  const attacks = [
    (identity) => { identity.hidden = true; return identity; },
    (identity) => { delete identity.challenge; return identity; },
    (identity) => {
      identity.release.hidden = true;
      return identity;
    },
    (identity) => {
      identity.geometry.poolSize = 4;
      return identity;
    },
    (identity) => {
      identity.profile.speciesModel = 'attacker';
      return identity;
    },
    (identity) => new Proxy(identity, {}),
  ];

  for (const attack of attacks) {
    assert.throws(
      () => createPhase5FaultSessionAuthority({
        identity: attack(structuredClone(IDENTITY)),
        captureNonceBytes: Buffer.from(CAPTURE_NONCE_BYTES),
      }),
      authorityErrorCode('PHASE5_FAULT_SESSION_INPUT_INVALID'),
    );
  }
});

test('caller cannot inject or retain capture private key material', () => {
  let getterCalls = 0;
  const options = {
    identity: structuredClone(IDENTITY),
    captureNonceBytes: Buffer.from(CAPTURE_NONCE_BYTES),
  };
  Object.defineProperty(options, 'privateKeyPkcs8Der', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return Buffer.alloc(48);
    },
  });

  assert.throws(
    () => createPhase5FaultSessionAuthority(options),
    authorityErrorCode('PHASE5_FAULT_SESSION_INPUT_INVALID'),
  );
  assert.equal(getterCalls, 0);
});

test('caller nonce must be exactly 32 ordinary owned bytes', () => {
  class Uint8ArraySubclass extends Uint8Array {}
  const attacks = [
    Buffer.alloc(31),
    Buffer.alloc(33),
    '8'.repeat(64),
    Promise.resolve(Buffer.from(CAPTURE_NONCE_BYTES)),
    new Proxy(Buffer.from(CAPTURE_NONCE_BYTES), {}),
    new Uint8ArraySubclass(CAPTURE_NONCE_BYTES),
  ];

  for (const captureNonceBytes of attacks) {
    assert.throws(
      () => createPhase5FaultSessionAuthority({
        identity: structuredClone(IDENTITY),
        captureNonceBytes,
      }),
      authorityErrorCode('PHASE5_FAULT_SESSION_INPUT_INVALID'),
    );
  }
});

test('capture finalizer consumes a restricted authority capability and owns no key', () => {
  assert.doesNotMatch(finalizerSource, /generateKeyPairSync/u);
  assert.doesNotMatch(finalizerSource, /\bsign\s*\(/u);
  assert.doesNotMatch(finalizerSource, /\bprivateKey\b/u);
  assert.match(finalizerSource, /faultSessionAuthority/u);
  assert.match(finalizerSource, /finalizeCapture/u);
});
