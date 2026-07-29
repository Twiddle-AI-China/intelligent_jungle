import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  canonicalJson,
  createEd25519SignerDescriptor,
} from '../../tools/lib/phase5-fault-evidence.mjs';
import {
  captureProofSigningBytes,
} from '../../tools/lib/phase5-capture-proof.mjs';
import {
  MAX_PHASE5_CAPTURE_PROOF_ENVELOPE_BYTES,
  main,
  readBoundedStdinBytes,
  verifyPhase5CaptureProofEnvelopeBytes,
} from '../../tools/verify-phase5-capture-proof.mjs';

const CLI_PATH = fileURLToPath(
  new URL('../../tools/verify-phase5-capture-proof.mjs', import.meta.url),
);
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
    envelope: {
      session,
      runBinding,
      trustedSignerSpkiDerBase64: session.signer.publicKeySpkiDerBase64,
    },
    keyPair,
  };
}

function envelopeBytes(envelope) {
  return Buffer.from(`${canonicalJson(envelope)}\n`, 'utf8');
}

function virtualReadSync(source) {
  let cursor = 0;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    readSync(fd, target, offset, length, position) {
      calls += 1;
      assert.equal(fd, 0);
      assert.equal(position, null);
      const count = Math.min(length, source.length - cursor);
      if (count === 0) return 0;
      source.copy(target, offset, cursor, cursor + count);
      cursor += count;
      return count;
    },
  };
}

test('freezes the capture proof envelope limit at 1 MiB', () => {
  assert.equal(
    MAX_PHASE5_CAPTURE_PROOF_ENVELOPE_BYTES,
    1024 * 1024,
  );
});

test('bounded stdin reader probes EOF at the exact limit', () => {
  const virtual = virtualReadSync(Buffer.from('abcde', 'utf8'));

  const output = readBoundedStdinBytes({
    readSyncImpl: virtual.readSync,
    maxBytes: 5,
    chunkBytes: 2,
  });

  assert.equal(output.toString('utf8'), 'abcde');
  assert.equal(virtual.calls, 4);
});

test('bounded stdin reader stops at limit plus one byte', () => {
  const virtual = virtualReadSync(Buffer.from('abcdefg', 'utf8'));

  assert.throws(
    () => readBoundedStdinBytes({
      readSyncImpl: virtual.readSync,
      maxBytes: 5,
      chunkBytes: 2,
    }),
    /PHASE5_CAPTURE_PROOF_VERIFIER_INPUT_TOO_LARGE/,
  );
  assert.equal(virtual.calls, 3);
});

test('pure bytes verifier returns one canonical validation result plus LF', () => {
  const { envelope } = fixture();
  const output = verifyPhase5CaptureProofEnvelopeBytes(
    envelopeBytes(envelope),
  );
  const result = JSON.parse(output.toString('utf8'));

  assert.equal(result.passed, true);
  assert.equal(
    result.kind,
    'phase5-capture-proof-validation-result',
  );
  assert.equal(result.captureNonce, CAPTURE_NONCE);
  assert.equal(result.rawManifestSha256, RAW_MANIFEST_SHA256);
  assert.equal(
    output.equals(Buffer.from(`${canonicalJson(result)}\n`, 'utf8')),
    true,
  );
});

test('pure bytes verifier output is deterministic', () => {
  const { envelope } = fixture();
  const input = envelopeBytes(envelope);
  const first = verifyPhase5CaptureProofEnvelopeBytes(input);
  const second = verifyPhase5CaptureProofEnvelopeBytes(input);

  assert.equal(first.equals(second), true);
});

test('exact envelope requires explicit external trust without fallback', () => {
  const { envelope } = fixture();
  delete envelope.trustedSignerSpkiDerBase64;

  assert.throws(
    () => verifyPhase5CaptureProofEnvelopeBytes(envelopeBytes(envelope)),
    /PHASE5_CAPTURE_PROOF_VERIFIER_ENVELOPE_INVALID/,
  );
});

test('exact envelope rejects extra caller-owned authority', () => {
  const { envelope } = fixture();
  envelope.result = { passed: true };

  assert.throws(
    () => verifyPhase5CaptureProofEnvelopeBytes(envelopeBytes(envelope)),
    /PHASE5_CAPTURE_PROOF_VERIFIER_ENVELOPE_INVALID/,
  );
});

test('attacker key replacement and complete re-signing fails external trust', () => {
  const trusted = fixture();
  const attacker = fixture(generateKeyPairSync('ed25519'));
  attacker.envelope.trustedSignerSpkiDerBase64 =
    trusted.envelope.trustedSignerSpkiDerBase64;

  assert.throws(
    () => verifyPhase5CaptureProofEnvelopeBytes(
      envelopeBytes(attacker.envelope),
    ),
    /PHASE5_CAPTURE_PROOF_SIGNER_BINDING_INVALID/,
  );
});

test('rejects non-canonical whitespace before validation', () => {
  let calls = 0;
  const input = Buffer.from(
    '{ "runBinding":{},"session":{},'
      + '"trustedSignerSpkiDerBase64":"x"}\n',
    'utf8',
  );

  assert.throws(
    () => verifyPhase5CaptureProofEnvelopeBytes(input, {
      validateImpl() {
        calls += 1;
      },
    }),
    /PHASE5_CAPTURE_PROOF_VERIFIER_INPUT_NOT_CANONICAL/,
  );
  assert.equal(calls, 0);
});

test('rejects duplicate JSON keys before validation', () => {
  let calls = 0;
  const input = Buffer.from(
    '{"runBinding":{},"session":{},"session":{},'
      + '"trustedSignerSpkiDerBase64":"x"}\n',
    'utf8',
  );

  assert.throws(
    () => verifyPhase5CaptureProofEnvelopeBytes(input, {
      validateImpl() {
        calls += 1;
      },
    }),
    /PHASE5_CAPTURE_PROOF_VERIFIER_INPUT_NOT_CANONICAL/,
  );
  assert.equal(calls, 0);
});

test('requires exactly one trailing LF', () => {
  const canonical =
    '{"runBinding":{},"session":{},'
    + '"trustedSignerSpkiDerBase64":"x"}';
  for (const suffix of ['', '\r\n', '\n\n']) {
    assert.throws(
      () => verifyPhase5CaptureProofEnvelopeBytes(
        Buffer.from(`${canonical}${suffix}`, 'utf8'),
        { validateImpl: () => ({ passed: true }) },
      ),
      /PHASE5_CAPTURE_PROOF_VERIFIER_INPUT_NOT_CANONICAL/,
    );
  }
  assert.throws(
    () => verifyPhase5CaptureProofEnvelopeBytes(
      Buffer.from(`${canonical}\nignored`, 'utf8'),
      { validateImpl: () => ({ passed: true }) },
    ),
    /PHASE5_CAPTURE_PROOF_VERIFIER_INPUT_JSON_INVALID/,
  );
});

test('rejects invalid UTF-8 before validation', () => {
  let calls = 0;
  const input = Buffer.from([
    ...Buffer.from(
      '{"runBinding":{},"session":{},'
        + '"trustedSignerSpkiDerBase64":"',
      'utf8',
    ),
    0xc3,
    0x28,
    ...Buffer.from('"}\n', 'utf8'),
  ]);

  assert.throws(
    () => verifyPhase5CaptureProofEnvelopeBytes(input, {
      validateImpl() {
        calls += 1;
      },
    }),
    /PHASE5_CAPTURE_PROOF_VERIFIER_INPUT_UTF8_INVALID/,
  );
  assert.equal(calls, 0);
});

test('rejects non-bytes and oversized input before validation', () => {
  let calls = 0;
  const options = {
    validateImpl() {
      calls += 1;
    },
  };
  assert.throws(
    () => verifyPhase5CaptureProofEnvelopeBytes('not bytes', options),
    /PHASE5_CAPTURE_PROOF_VERIFIER_INPUT_BYTES_REQUIRED/,
  );
  assert.throws(
    () => verifyPhase5CaptureProofEnvelopeBytes(
      new Uint8Array(
        MAX_PHASE5_CAPTURE_PROOF_ENVELOPE_BYTES + 1,
      ),
      options,
    ),
    /PHASE5_CAPTURE_PROOF_VERIFIER_INPUT_TOO_LARGE/,
  );
  assert.equal(calls, 0);
});

test('main rejects argv without reading stdin or writing stdout', () => {
  let stdinReads = 0;
  const stdout = [];
  const stderr = [];
  const exitCodes = [];

  const code = main({
    argv: ['--help'],
    readStdinBytes() {
      stdinReads += 1;
      return Buffer.alloc(0);
    },
    writeStdoutBytes: (bytes) => stdout.push(bytes),
    writeStderrText: (text) => stderr.push(text),
    setExitCode: (value) => exitCodes.push(value),
  });

  assert.equal(code, 2);
  assert.equal(stdinReads, 0);
  assert.deepEqual(stdout, []);
  assert.deepEqual(exitCodes, [2]);
  assert.equal(
    stderr.join(''),
    'PHASE5_CAPTURE_PROOF_VERIFIER_ARGUMENTS_FORBIDDEN\n',
  );
});

test('main commits stdout once only after successful validation', () => {
  const { envelope } = fixture();
  let stdinReads = 0;
  const stdout = [];
  const stderr = [];
  const exitCodes = [];

  const code = main({
    argv: [],
    readStdinBytes() {
      stdinReads += 1;
      return envelopeBytes(envelope);
    },
    writeStdoutBytes: (bytes) => stdout.push(Buffer.from(bytes)),
    writeStderrText: (text) => stderr.push(text),
    setExitCode: (value) => exitCodes.push(value),
  });

  assert.equal(code, 0);
  assert.equal(stdinReads, 1);
  assert.equal(stdout.length, 1);
  assert.equal(JSON.parse(stdout[0]).passed, true);
  assert.deepEqual(stderr, []);
  assert.deepEqual(exitCodes, [0]);
});

test('main failure keeps stdout empty and emits stable stderr/code', () => {
  const { envelope } = fixture();
  const stdout = [];
  const stderr = [];
  const exitCodes = [];

  const code = main({
    argv: [],
    readStdinBytes: () => envelopeBytes(envelope),
    writeStdoutBytes: (bytes) => stdout.push(bytes),
    writeStderrText: (text) => stderr.push(text),
    setExitCode: (value) => exitCodes.push(value),
    validateImpl: () => {
      throw new Error('PHASE5_CAPTURE_PROOF_SIGNER_BINDING_INVALID');
    },
  });

  assert.equal(code, 2);
  assert.deepEqual(stdout, []);
  assert.deepEqual(exitCodes, [2]);
  assert.equal(
    stderr.join(''),
    'PHASE5_CAPTURE_PROOF_SIGNER_BINDING_INVALID\n',
  );
});

test('direct CLI succeeds with one canonical line', () => {
  const { envelope } = fixture();
  const child = spawnSync(process.execPath, [CLI_PATH], {
    input: envelopeBytes(envelope),
    encoding: 'utf8',
  });

  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.passed, true);
  assert.equal(
    child.stdout,
    `${canonicalJson(result)}\n`,
  );
});

test('direct CLI failure emits no stdout and stable stderr/code', () => {
  const { envelope } = fixture();
  delete envelope.trustedSignerSpkiDerBase64;
  const child = spawnSync(process.execPath, [CLI_PATH], {
    input: envelopeBytes(envelope),
    encoding: 'utf8',
  });

  assert.equal(child.status, 2);
  assert.equal(child.stdout, '');
  assert.equal(
    child.stderr,
    'PHASE5_CAPTURE_PROOF_VERIFIER_ENVELOPE_INVALID\n',
  );
});
