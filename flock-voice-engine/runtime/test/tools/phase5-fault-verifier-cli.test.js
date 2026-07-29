import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canonicalJson } from '../../tools/lib/phase5-fault-evidence.mjs';
import {
  MAX_PHASE5_FAULT_ENVELOPE_BYTES,
  main,
  readBoundedStdinBytes,
  verifyPhase5FaultEnvelopeWithClientProjectionBytes,
  verifyPhase5FaultEnvelopeBytes,
} from '../../tools/verify-phase5-fault-evidence.mjs';
import {
  signedFixture,
} from './phase5-fault-validation-fixture.js';

const CLI_PATH = fileURLToPath(
  new URL('../../tools/verify-phase5-fault-evidence.mjs', import.meta.url),
);

function envelopeBytes(envelope) {
  return Buffer.from(`${canonicalJson(envelope)}\n`, 'utf8');
}

function fixture() {
  return {
    envelope: {
      evidence: {
        schemaVersion: 2,
        signer: { publicKeySpkiSha256: 'a'.repeat(64) },
      },
      runBinding: {
        signerSpkiSha256: 'a'.repeat(64),
        source: 'trusted-candidate-session',
      },
    },
    result: {
      schemaVersion: 1,
      kind: 'phase5-fault-validation-result',
      passed: true,
      evidence: { transportEventCount: 42 },
    },
  };
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

test('freezes the production envelope limit at 128 MiB', () => {
  assert.equal(
    MAX_PHASE5_FAULT_ENVELOPE_BYTES,
    128 * 1024 * 1024,
  );
});

test('bounded stdin reader assembles partial chunks through one fd', () => {
  const virtual = virtualReadSync(Buffer.from('abcdef', 'utf8'));

  const output = readBoundedStdinBytes({
    readSyncImpl: virtual.readSync,
    maxBytes: 6,
    chunkBytes: 2,
  });

  assert.equal(output.toString('utf8'), 'abcdef');
  assert.equal(virtual.calls, 4);
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

test('bounded stdin reader stops at MAX plus one byte', () => {
  const virtual = virtualReadSync(Buffer.from('abcdefg', 'utf8'));

  assert.throws(
    () => readBoundedStdinBytes({
      readSyncImpl: virtual.readSync,
      maxBytes: 5,
      chunkBytes: 2,
    }),
    /PHASE5_FAULT_VERIFIER_INPUT_TOO_LARGE/,
  );
  assert.equal(virtual.calls, 3);
});

test('pure bytes verifier returns only a canonical validated result plus LF', () => {
  const { envelope, result } = fixture();
  let received;

  const output = verifyPhase5FaultEnvelopeBytes(
    envelopeBytes(envelope),
    {
      validateImpl(evidence, runBinding) {
        received = { evidence, runBinding };
        return result;
      },
    },
  );

  assert.deepEqual(received, envelope);
  assert.equal(
    output.equals(Buffer.from(`${canonicalJson(result)}\n`, 'utf8')),
    true,
  );
});

test('pure bytes verifier output is deterministic', () => {
  const { envelope, result } = fixture();
  const validateImpl = () => structuredClone(result);
  const input = envelopeBytes(envelope);

  const first = verifyPhase5FaultEnvelopeBytes(input, { validateImpl });
  const second = verifyPhase5FaultEnvelopeBytes(input, { validateImpl });

  assert.equal(first.equals(second), true);
});

test('rejects non-canonical whitespace without invoking validation', () => {
  let calls = 0;
  const input = Buffer.from(
    '{ "evidence":{},"runBinding":{}}\n',
    'utf8',
  );

  assert.throws(
    () => verifyPhase5FaultEnvelopeBytes(input, {
      validateImpl() {
        calls += 1;
      },
    }),
    /PHASE5_FAULT_VERIFIER_INPUT_NOT_CANONICAL/,
  );
  assert.equal(calls, 0);
});

test('rejects duplicate JSON keys without invoking validation', () => {
  let calls = 0;
  const input = Buffer.from(
    '{"evidence":{},"evidence":{},"runBinding":{}}\n',
    'utf8',
  );

  assert.throws(
    () => verifyPhase5FaultEnvelopeBytes(input, {
      validateImpl() {
        calls += 1;
      },
    }),
    /PHASE5_FAULT_VERIFIER_INPUT_NOT_CANONICAL/,
  );
  assert.equal(calls, 0);
});

test('rejects extra result and projection envelope fields', () => {
  for (const untrustedKey of ['result', 'projection']) {
    const input = envelopeBytes({
      evidence: {},
      runBinding: {},
      [untrustedKey]: { passed: true },
    });

    assert.throws(
      () => verifyPhase5FaultEnvelopeBytes(input, {
        validateImpl: () => {
          throw new Error('VALIDATOR_MUST_NOT_RUN');
        },
      }),
      /PHASE5_FAULT_VERIFIER_ENVELOPE_INVALID/,
    );
  }
});

test('requires exactly one trailing LF', () => {
  const canonical = '{"evidence":{},"runBinding":{}}';
  for (const suffix of ['', '\r\n', '\n\n']) {
    assert.throws(
      () => verifyPhase5FaultEnvelopeBytes(
        Buffer.from(`${canonical}${suffix}`, 'utf8'),
        { validateImpl: () => ({ passed: true }) },
      ),
      /PHASE5_FAULT_VERIFIER_INPUT_NOT_CANONICAL/,
    );
  }
});

test('rejects invalid UTF-8 before validation', () => {
  const input = Buffer.from([
    ...Buffer.from('{"evidence":{},"runBinding":"', 'utf8'),
    0xc3,
    0x28,
    ...Buffer.from('"}\n', 'utf8'),
  ]);

  assert.throws(
    () => verifyPhase5FaultEnvelopeBytes(input, {
      validateImpl: () => {
        throw new Error('VALIDATOR_MUST_NOT_RUN');
      },
    }),
    /PHASE5_FAULT_VERIFIER_INPUT_UTF8_INVALID/,
  );
});

test('default composite validator rejects a wrong run binding', () => {
  assert.throws(
    () => verifyPhase5FaultEnvelopeBytes(envelopeBytes({
      evidence: {},
      runBinding: {},
    })),
    /PHASE5_FAULT_RUN_BINDING_INVALID/,
  );
});

test('default real composite validates the shared signed fixture', () => {
  const { evidence, runBinding } = signedFixture();
  const output = verifyPhase5FaultEnvelopeBytes(envelopeBytes({
    evidence,
    runBinding,
  }));
  const result = JSON.parse(output.toString('utf8'));

  assert.equal(result.passed, true);
  assert.equal(result.kind, 'phase5-fault-validation-result');
  assert.equal(result.runId, runBinding.runId);
  assert.equal(
    output.equals(Buffer.from(`${canonicalJson(result)}\n`, 'utf8')),
    true,
  );
});

test('explicit client projection bytes entry returns one canonical trusted composite', () => {
  const { evidence, runBinding } = signedFixture();
  const input = envelopeBytes({ evidence, runBinding });
  const output = verifyPhase5FaultEnvelopeWithClientProjectionBytes(input);
  const repeated =
    verifyPhase5FaultEnvelopeWithClientProjectionBytes(input);
  const result = JSON.parse(output.toString('utf8'));

  assert.equal(output.equals(repeated), true);
  assert.equal(
    result.kind,
    'phase5-fault-validation-with-client-projection-result',
  );
  assert.equal(result.faultValidation.passed, true);
  assert.equal(
    result.signedTransportProjection.kind,
    'phase5-client-observations-signed-transport-projection',
  );
  assert.equal(
    output.equals(Buffer.from(`${canonicalJson(result)}\n`, 'utf8')),
    true,
  );
});

test('default real composite rejects a signer mismatch', () => {
  const { evidence, runBinding } = signedFixture();
  const wrongBinding = structuredClone(runBinding);
  wrongBinding.signerSpkiSha256 = 'f'.repeat(64);
  assert.throws(
    () => verifyPhase5FaultEnvelopeBytes(envelopeBytes({
      evidence,
      runBinding: wrongBinding,
    })),
    /PHASE5_FAULT_SIGNER_BINDING_INVALID/,
  );
});

test('rejects an oversized input before validation', () => {
  let calls = 0;
  const input = new Uint8Array(
    MAX_PHASE5_FAULT_ENVELOPE_BYTES + 1,
  );

  assert.throws(
    () => verifyPhase5FaultEnvelopeBytes(input, {
      validateImpl() {
        calls += 1;
      },
    }),
    /PHASE5_FAULT_VERIFIER_INPUT_TOO_LARGE/,
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
  assert.match(stderr.join(''), /PHASE5_FAULT_VERIFIER_ARGUMENTS_FORBIDDEN/);
});

test('main reads stdin once and commits stdout once after validation', () => {
  const { envelope, result } = fixture();
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
    validateImpl: () => result,
  });

  assert.equal(code, 0);
  assert.equal(stdinReads, 1);
  assert.equal(stdout.length, 1);
  assert.equal(
    stdout[0].equals(Buffer.from(`${canonicalJson(result)}\n`, 'utf8')),
    true,
  );
  assert.deepEqual(stderr, []);
  assert.deepEqual(exitCodes, [0]);
});

test('main emits no partial stdout when validation fails', () => {
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
      throw new Error('PHASE5_FAULT_RUN_BINDING_MISMATCH');
    },
  });

  assert.equal(code, 2);
  assert.deepEqual(stdout, []);
  assert.deepEqual(exitCodes, [2]);
  assert.equal(stderr.join(''), 'PHASE5_FAULT_RUN_BINDING_MISMATCH\n');
});

test('direct CLI rejects argv with nonzero status and empty stdout', () => {
  const child = spawnSync(process.execPath, [CLI_PATH, '--help'], {
    encoding: 'utf8',
    input: '',
  });

  assert.equal(child.status, 2);
  assert.equal(child.stdout, '');
  assert.match(
    child.stderr,
    /PHASE5_FAULT_VERIFIER_ARGUMENTS_FORBIDDEN/,
  );
});
