import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson } from '../../tools/lib/phase5-fault-evidence.mjs';
import {
  validatePhase5CaptureProof,
} from '../../tools/lib/phase5-capture-proof.mjs';
import {
  createPhase5CandidateCaptureFinalizer,
} from '../../tools/lib/phase5-capture-finalizer.mjs';
import {
  MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES,
  Phase5CaptureChannelProtocolError,
  createPhase5CaptureChannelProtocol,
} from '../../tools/lib/phase5-capture-channel-protocol.mjs';

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
const RAW_MANIFEST_SHA256 = '9'.repeat(64);

function fixture() {
  const finalizer = createPhase5CandidateCaptureFinalizer({
    identity: structuredClone(IDENTITY),
    captureNonceBytes: Buffer.from(CAPTURE_NONCE_BYTES),
  });
  const protocol = createPhase5CaptureChannelProtocol({ finalizer });
  const admission = JSON.parse(
    protocol.getAdmissionBytes().subarray(0, -1).toString('utf8'),
  );
  const request = {
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-finalize-request',
    runId: admission.runId,
    challenge: admission.challenge,
    captureNonce: admission.captureNonce,
    rawManifestSha256: RAW_MANIFEST_SHA256,
  };
  return { finalizer, protocol, admission, request };
}

function errorCode(code) {
  return (error) => (
    error instanceof Phase5CaptureChannelProtocolError
    && error.code === code
  );
}

function requestBytes(request) {
  return Buffer.from(`${canonicalJson(request)}\n`, 'utf8');
}

test('one canonical request returns one canonical signed response', () => {
  const { protocol, admission, request } = fixture();

  const responseBytes = protocol.handleFinalizeRequestBytes(
    requestBytes(request),
  );
  const response = JSON.parse(
    responseBytes.subarray(0, -1).toString('utf8'),
  );

  assert.equal(
    responseBytes.toString('utf8'),
    `${canonicalJson(response)}\n`,
  );
  assert.deepEqual(
    Object.keys(response).sort(),
    [
      'captureValidation',
      'kind',
      'runBinding',
      'schemaVersion',
      'session',
    ],
  );
  assert.equal(
    response.kind,
    'phase5-candidate-capture-finalize-response',
  );
  assert.deepEqual(
    validatePhase5CaptureProof(
      response.session,
      response.runBinding,
      admission.trustedSignerSpkiDerBase64,
    ),
    response.captureValidation,
  );
  assert.equal(
    response.runBinding.rawManifestSha256,
    RAW_MANIFEST_SHA256,
  );
  assert.equal(
    Object.hasOwn(response, 'pid'),
    false,
  );
  assert.equal(
    Object.hasOwn(response, 'uid'),
    false,
  );
});

test('admission bytes are canonical, idempotent and caller-owned', () => {
  const { protocol } = fixture();

  const first = protocol.getAdmissionBytes();
  const expected = Buffer.from(first);
  first.fill(0);
  const second = protocol.getAdmissionBytes();

  assert.deepEqual(second, expected);
  assert.equal(second.at(-1), 0x0a);
  assert.notEqual(second.at(-2), 0x0a);
  const admission = JSON.parse(second.subarray(0, -1));
  assert.equal(
    second.toString('utf8'),
    `${canonicalJson(admission)}\n`,
  );
});

test('a successful finalize consumes the protocol and rejects replay', () => {
  const { protocol, request } = fixture();
  const raw = requestBytes(request);

  protocol.handleFinalizeRequestBytes(raw);

  assert.throws(
    () => protocol.handleFinalizeRequestBytes(raw),
    errorCode('PHASE5_CAPTURE_CHANNEL_ALREADY_USED'),
  );
});

test('the first malformed attempt permanently consumes the protocol', () => {
  const { finalizer, protocol, request } = fixture();

  assert.throws(
    () => protocol.handleFinalizeRequestBytes(
      Buffer.from('{"not":"the contract"}\n'),
    ),
    errorCode('PHASE5_CAPTURE_CHANNEL_REQUEST_INVALID'),
  );
  assert.throws(
    () => protocol.handleFinalizeRequestBytes(requestBytes(request)),
    errorCode('PHASE5_CAPTURE_CHANNEL_ALREADY_USED'),
  );
  assert.throws(
    () => finalizer.finalize(RAW_MANIFEST_SHA256),
    (error) => error?.code === 'PHASE5_CAPTURE_FINALIZER_ALREADY_USED',
  );
});

test('request must be one exact canonical line with no duplicate or tail', () => {
  const attacks = [
    ({ request }) => Buffer.from(canonicalJson(request)),
    ({ request }) => Buffer.from(` ${canonicalJson(request)}\n`),
    ({ request }) => Buffer.from(`${canonicalJson(request)}\n\n`),
    ({ request }) => Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      requestBytes(request),
    ]),
    ({ request }) => Buffer.from(
      `{"schemaVersion":1,${canonicalJson(request).slice(1)}\n`,
    ),
    () => Buffer.from([0xff, 0x0a]),
  ];

  for (const attack of attacks) {
    const value = fixture();
    assert.throws(
      () => value.protocol.handleFinalizeRequestBytes(attack(value)),
      errorCode('PHASE5_CAPTURE_CHANNEL_REQUEST_INVALID'),
    );
  }
});

test('session bytes must be exact canonical UTF-8 without a BOM', () => {
  const genuine = createPhase5CandidateCaptureFinalizer({
    identity: structuredClone(IDENTITY),
    captureNonceBytes: Buffer.from(CAPTURE_NONCE_BYTES),
  });
  const admission = genuine.getAdmission();
  const finalizer = {
    getAdmission() {
      return structuredClone(admission);
    },
    finalize(rawManifestSha256) {
      const result = genuine.finalize(rawManifestSha256);
      return {
        sessionBytes: Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          result.sessionBytes,
        ]),
        runBinding: result.runBinding,
        captureValidation: result.captureValidation,
      };
    },
  };
  const protocol = createPhase5CaptureChannelProtocol({ finalizer });
  const request = {
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-finalize-request',
    runId: admission.runId,
    challenge: admission.challenge,
    captureNonce: admission.captureNonce,
    rawManifestSha256: RAW_MANIFEST_SHA256,
  };

  assert.throws(
    () => protocol.handleFinalizeRequestBytes(requestBytes(request)),
    errorCode('PHASE5_CAPTURE_CHANNEL_FINALIZE_FAILED'),
  );
});

test('request exact-binds run, challenge, nonce and manifest digest', () => {
  const attacks = [
    (request) => { request.runId =
      'ffffffff-ffff-4fff-afff-ffffffffffff'; },
    (request) => { request.challenge = 'a'.repeat(64); },
    (request) => { request.captureNonce = 'b'.repeat(64); },
    (request) => { request.rawManifestSha256 = 'g'.repeat(64); },
    (request) => { request.hidden = true; },
  ];

  for (const attack of attacks) {
    const { protocol, request } = fixture();
    attack(request);
    assert.throws(
      () => protocol.handleFinalizeRequestBytes(
        requestBytes(request),
      ),
      errorCode('PHASE5_CAPTURE_CHANNEL_REQUEST_INVALID'),
    );
  }
});

test('request bytes reject Proxy, subclass and oversize before parsing', () => {
  class ByteSubclass extends Uint8Array {}
  const attacks = [
    () => new Proxy(Buffer.from('{}\n'), {}),
    () => new ByteSubclass(Buffer.from('{}\n')),
    () => Buffer.alloc(
      MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES + 1,
      0x20,
    ),
  ];

  for (const attack of attacks) {
    const { protocol } = fixture();
    assert.throws(
      () => protocol.handleFinalizeRequestBytes(attack()),
      errorCode('PHASE5_CAPTURE_CHANNEL_REQUEST_INVALID'),
    );
  }
});

test('protocol requires the exact data-only finalizer surface', () => {
  const { finalizer } = fixture();
  const attacks = [
    { finalizer: { ...finalizer, hidden: true } },
    { finalizer: {
      getAdmission: finalizer.getAdmission,
      finalize: 'not a function',
    } },
    { finalizer: new Proxy(finalizer, {}) },
    { finalizer, hidden: true },
  ];

  for (const options of attacks) {
    assert.throws(
      () => createPhase5CaptureChannelProtocol(options),
      errorCode('PHASE5_CAPTURE_CHANNEL_INPUT_INVALID'),
    );
  }
});

test('admission rejects oversized signer material before decoding it', () => {
  const finalizer = {
    getAdmission() {
      return {
        schemaVersion: 1,
        kind: 'phase5-candidate-capture-admission',
        runId: IDENTITY.runId,
        challenge: IDENTITY.challenge,
        captureNonce: CAPTURE_NONCE_BYTES.toString('hex'),
        signerSpkiSha256: 'a'.repeat(64),
        trustedSignerSpkiDerBase64: 'A'.repeat(1024 * 1024),
      };
    },
    finalize() {
      throw new Error('must not be reached');
    },
  };

  assert.throws(
    () => createPhase5CaptureChannelProtocol({ finalizer }),
    errorCode('PHASE5_CAPTURE_CHANNEL_INPUT_INVALID'),
  );
});
