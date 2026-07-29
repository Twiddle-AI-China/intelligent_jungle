import { readSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from './lib/phase5-fault-evidence.mjs';
import {
  validatePhase5FaultEvidence,
  validatePhase5FaultEvidenceWithClientProjection,
} from './lib/phase5-fault-validation.mjs';

export const MAX_PHASE5_FAULT_ENVELOPE_BYTES = 128 * 1024 * 1024;
const STDIN_READ_CHUNK_BYTES = 64 * 1024;

function fail(code) {
  throw new Error(code);
}

function exactEnvelope(value) {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === 2
    && keys.every((key) => typeof key === 'string')
    && keys.includes('evidence')
    && keys.includes('runBinding');
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('PHASE5_FAULT_VERIFIER_INPUT_UTF8_INVALID');
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    fail('PHASE5_FAULT_VERIFIER_INPUT_JSON_INVALID');
  }
}

function stableErrorMessage(error) {
  if (!(error instanceof Error)
      || typeof error.message !== 'string'
      || error.message.length === 0) {
    return 'PHASE5_FAULT_VERIFIER_FAILED';
  }
  const [firstLine] = error.message.split(/\r?\n/u, 1);
  return firstLine || 'PHASE5_FAULT_VERIFIER_FAILED';
}

export function readBoundedStdinBytes({
  readSyncImpl = readSync,
  fd = 0,
  maxBytes = MAX_PHASE5_FAULT_ENVELOPE_BYTES,
  chunkBytes = STDIN_READ_CHUNK_BYTES,
} = {}) {
  if (typeof readSyncImpl !== 'function'
      || !Number.isSafeInteger(fd)
      || fd < 0
      || !Number.isSafeInteger(maxBytes)
      || maxBytes < 1
      || !Number.isSafeInteger(chunkBytes)
      || chunkBytes < 1) {
    fail('PHASE5_FAULT_VERIFIER_STDIN_READER_INVALID');
  }

  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const remainingThroughLimit = maxBytes + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(
      chunkBytes,
      remainingThroughLimit,
    ));
    const bytesRead = readSyncImpl(
      fd,
      chunk,
      0,
      chunk.length,
      null,
    );
    if (!Number.isSafeInteger(bytesRead)
        || bytesRead < 0
        || bytesRead > chunk.length) {
      fail('PHASE5_FAULT_VERIFIER_STDIN_READ_INVALID');
    }
    if (bytesRead === 0) {
      return Buffer.concat(chunks, totalBytes);
    }
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      fail('PHASE5_FAULT_VERIFIER_INPUT_TOO_LARGE');
    }
    chunks.push(
      bytesRead === chunk.length
        ? chunk
        : chunk.subarray(0, bytesRead),
    );
  }
}

export function verifyPhase5FaultEnvelopeBytes(
  inputBytes,
  {
    validateImpl = validatePhase5FaultEvidence,
  } = {},
) {
  if (!(inputBytes instanceof Uint8Array)) {
    fail('PHASE5_FAULT_VERIFIER_INPUT_BYTES_REQUIRED');
  }
  if (inputBytes.byteLength > MAX_PHASE5_FAULT_ENVELOPE_BYTES) {
    fail('PHASE5_FAULT_VERIFIER_INPUT_TOO_LARGE');
  }
  if (typeof validateImpl !== 'function') {
    fail('PHASE5_FAULT_VERIFIER_VALIDATOR_INVALID');
  }

  const bytes = Buffer.from(inputBytes);
  const text = decodeUtf8(bytes);
  const envelope = parseJson(text);
  if (!exactEnvelope(envelope)) {
    fail('PHASE5_FAULT_VERIFIER_ENVELOPE_INVALID');
  }

  const canonicalInput = Buffer.from(
    `${canonicalJson(envelope)}\n`,
    'utf8',
  );
  if (!bytes.equals(canonicalInput)) {
    fail('PHASE5_FAULT_VERIFIER_INPUT_NOT_CANONICAL');
  }

  const result = validateImpl(envelope.evidence, envelope.runBinding);
  return Buffer.from(`${canonicalJson(result)}\n`, 'utf8');
}

export function verifyPhase5FaultEnvelopeWithClientProjectionBytes(
  inputBytes,
  {
    validateImpl = validatePhase5FaultEvidenceWithClientProjection,
  } = {},
) {
  return verifyPhase5FaultEnvelopeBytes(inputBytes, { validateImpl });
}

export function main({
  argv = process.argv.slice(2),
  readStdinBytes = readBoundedStdinBytes,
  writeStdoutBytes = (bytes) => process.stdout.write(bytes),
  writeStderrText = (text) => process.stderr.write(text),
  setExitCode = (value) => {
    process.exitCode = value;
  },
  validateImpl = validatePhase5FaultEvidence,
} = {}) {
  let output;
  try {
    if (!Array.isArray(argv) || argv.length !== 0) {
      fail('PHASE5_FAULT_VERIFIER_ARGUMENTS_FORBIDDEN');
    }
    output = verifyPhase5FaultEnvelopeBytes(
      readStdinBytes(),
      { validateImpl },
    );
  } catch (error) {
    setExitCode(2);
    writeStderrText(`${stableErrorMessage(error)}\n`);
    return 2;
  }

  try {
    writeStdoutBytes(output);
    setExitCode(0);
    return 0;
  } catch (error) {
    setExitCode(2);
    writeStderrText(`${stableErrorMessage(error)}\n`);
    return 2;
  }
}

if (process.argv[1]
    && resolve(process.argv[1])
      === resolve(fileURLToPath(import.meta.url))) {
  main();
}
