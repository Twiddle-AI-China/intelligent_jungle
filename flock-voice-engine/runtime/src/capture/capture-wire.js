import {
  createHash,
  createPublicKey,
} from 'node:crypto';
import {
  TextDecoder,
  types,
} from 'node:util';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ED25519_SPKI_DER_BASE64_LENGTH = 60;
const ADMISSION_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'runId',
  'challenge',
  'captureNonce',
  'signerSpkiSha256',
  'trustedSignerSpkiDerBase64',
]);
const ADMISSION_BINDING_FIELDS = Object.freeze([
  'runId',
  'challenge',
  'captureNonce',
]);
const TYPED_ARRAY_PROTOTYPE =
  Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER_GETTER =
  Object.getOwnPropertyDescriptor(
    TYPED_ARRAY_PROTOTYPE,
    'buffer',
  ).get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER =
  Object.getOwnPropertyDescriptor(
    TYPED_ARRAY_PROTOTYPE,
    'byteOffset',
  ).get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  Object.getOwnPropertyDescriptor(
    TYPED_ARRAY_PROTOTYPE,
    'byteLength',
  ).get;

function fail(code) {
  throw new Phase5CaptureWireError(code);
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

function validUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalJsonInternal(value, ancestors) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (!validUnicodeScalarString(value)) {
      fail('PHASE5_CAPTURE_WIRE_CANONICAL_JSON_INVALID');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('PHASE5_CAPTURE_WIRE_CANONICAL_JSON_INVALID');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object'
      || types.isProxy(value)
      || ancestors.has(value)) {
    fail('PHASE5_CAPTURE_WIRE_CANONICAL_JSON_INVALID');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (!ordinaryDenseArray(value)) {
        fail('PHASE5_CAPTURE_WIRE_CANONICAL_JSON_INVALID');
      }
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        items.push(canonicalJsonInternal(descriptor.value, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    if (!exactPlainDataObject(value, Reflect.ownKeys(value))) {
      fail('PHASE5_CAPTURE_WIRE_CANONICAL_JSON_INVALID');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => (
      typeof key !== 'string'
        || !validUnicodeScalarString(key)
        || !enumerableDataProperty(value, key)
    ))) {
      fail('PHASE5_CAPTURE_WIRE_CANONICAL_JSON_INVALID');
    }
    return `{${keys.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return `${JSON.stringify(key)}:${canonicalJsonInternal(
        descriptor.value,
        ancestors,
      )}`;
    }).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function ownedCanonicalValue(value, code) {
  try {
    return JSON.parse(canonicalPhase5CaptureJson(value));
  } catch {
    fail(code);
  }
}

function parseEd25519SpkiBase64(value, code) {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  const spki = Buffer.from(value, 'base64');
  if (spki.toString('base64') !== value) fail(code);
  try {
    const publicKey = createPublicKey({
      key: spki,
      format: 'der',
      type: 'spki',
    });
    if (publicKey.asymmetricKeyType !== 'ed25519') fail(code);
    const canonicalSpki = publicKey.export({
      type: 'spki',
      format: 'der',
    });
    if (!Buffer.from(canonicalSpki).equals(spki)) fail(code);
    return { publicKey, spki };
  } catch (error) {
    if (error instanceof Phase5CaptureWireError
        && error.code === code) {
      throw error;
    }
    fail(code);
  }
}

export class Phase5CaptureWireError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5CaptureWireError';
    this.code = code;
  }
}

export function canonicalPhase5CaptureJson(value) {
  if (arguments.length !== 1) {
    fail('PHASE5_CAPTURE_WIRE_CANONICAL_JSON_INVALID');
  }
  return canonicalJsonInternal(value, new Set());
}

export function copyPhase5CaptureBytes(value, maximumBytes) {
  if (arguments.length !== 2
      || !Number.isSafeInteger(maximumBytes)
      || maximumBytes < 0
      || value === null
      || typeof value !== 'object'
      || types.isProxy(value)) {
    fail('PHASE5_CAPTURE_WIRE_BYTES_INVALID');
  }
  const prototype = Object.getPrototypeOf(value);
  if (![Buffer.prototype, Uint8Array.prototype].includes(prototype)) {
    fail('PHASE5_CAPTURE_WIRE_BYTES_INVALID');
  }
  let buffer;
  let byteOffset;
  let byteLength;
  try {
    buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
    byteOffset = Reflect.apply(
      TYPED_ARRAY_BYTE_OFFSET_GETTER,
      value,
      [],
    );
    byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    );
  } catch {
    fail('PHASE5_CAPTURE_WIRE_BYTES_INVALID');
  }
  if (!(buffer instanceof ArrayBuffer)
      || !Number.isSafeInteger(byteOffset)
      || !Number.isSafeInteger(byteLength)
      || byteLength > maximumBytes) {
    fail('PHASE5_CAPTURE_WIRE_BYTES_INVALID');
  }
  return Buffer.from(Buffer.from(buffer, byteOffset, byteLength));
}

export function encodePhase5CaptureCanonicalLine(value, maximumBytes) {
  if (arguments.length !== 2
      || !Number.isSafeInteger(maximumBytes)
      || maximumBytes < 0) {
    fail('PHASE5_CAPTURE_WIRE_CANONICAL_LINE_INVALID');
  }
  let bytes;
  try {
    bytes = Buffer.from(
      `${canonicalPhase5CaptureJson(value)}\n`,
      'utf8',
    );
  } catch {
    fail('PHASE5_CAPTURE_WIRE_CANONICAL_LINE_INVALID');
  }
  if (bytes.byteLength > maximumBytes) {
    fail('PHASE5_CAPTURE_WIRE_CANONICAL_LINE_INVALID');
  }
  return bytes;
}

export function decodePhase5CaptureCanonicalLine(bytes, maximumBytes) {
  if (arguments.length !== 2) {
    fail('PHASE5_CAPTURE_WIRE_CANONICAL_LINE_INVALID');
  }
  let owned;
  let text;
  let value;
  try {
    owned = copyPhase5CaptureBytes(bytes, maximumBytes);
    text = new TextDecoder(
      'utf-8',
      { fatal: true, ignoreBOM: true },
    ).decode(owned);
    value = JSON.parse(text);
    if (text !== `${canonicalPhase5CaptureJson(value)}\n`) {
      throw new Error('NONCANONICAL');
    }
  } catch {
    fail('PHASE5_CAPTURE_WIRE_CANONICAL_LINE_INVALID');
  }
  return value;
}

export function createPhase5CaptureSignerDescriptor(publicKeyInput) {
  if (arguments.length !== 1) {
    fail('PHASE5_CAPTURE_SIGNER_KEY_INVALID');
  }
  try {
    const publicKey = (
      publicKeyInput?.type === 'public'
        ? publicKeyInput
        : createPublicKey(publicKeyInput)
    );
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('KEY_INVALID');
    }
    const spki = publicKey.export({
      type: 'spki',
      format: 'der',
    });
    return {
      algorithm: 'Ed25519',
      publicKeySpkiDerBase64: spki.toString('base64'),
      publicKeySpkiSha256: sha256(spki),
    };
  } catch {
    fail('PHASE5_CAPTURE_SIGNER_KEY_INVALID');
  }
}

export function parsePhase5CaptureEd25519Spki(value) {
  if (arguments.length !== 1) {
    fail('PHASE5_CAPTURE_SPKI_INVALID');
  }
  return parseEd25519SpkiBase64(
    value,
    'PHASE5_CAPTURE_SPKI_INVALID',
  );
}

export function validatePhase5CaptureAdmission(value) {
  if (arguments.length !== 1) {
    fail('PHASE5_CAPTURE_ADMISSION_INVALID');
  }
  const owned = ownedCanonicalValue(
    value,
    'PHASE5_CAPTURE_ADMISSION_INVALID',
  );
  if (!exactPlainDataObject(owned, ADMISSION_FIELDS)
      || owned.schemaVersion !== 1
      || owned.kind !== 'phase5-candidate-capture-admission'
      || typeof owned.runId !== 'string'
      || !UUID_V4.test(owned.runId)
      || typeof owned.challenge !== 'string'
      || !HEX64.test(owned.challenge)
      || typeof owned.captureNonce !== 'string'
      || !HEX64.test(owned.captureNonce)
      || typeof owned.signerSpkiSha256 !== 'string'
      || !HEX64.test(owned.signerSpkiSha256)
      || typeof owned.trustedSignerSpkiDerBase64 !== 'string'
      || owned.trustedSignerSpkiDerBase64.length
         !== ED25519_SPKI_DER_BASE64_LENGTH) {
    fail('PHASE5_CAPTURE_ADMISSION_INVALID');
  }
  const { spki } = parseEd25519SpkiBase64(
    owned.trustedSignerSpkiDerBase64,
    'PHASE5_CAPTURE_ADMISSION_INVALID',
  );
  if (sha256(spki) !== owned.signerSpkiSha256) {
    fail('PHASE5_CAPTURE_ADMISSION_INVALID');
  }
  return deepFreeze(owned);
}

export function assertPhase5CaptureAdmissionBinding(
  admission,
  expectedBinding,
) {
  if (arguments.length !== 2) {
    fail('PHASE5_CAPTURE_ADMISSION_BINDING_MISMATCH');
  }
  const trustedAdmission = validatePhase5CaptureAdmission(admission);
  const expected = ownedCanonicalValue(
    expectedBinding,
    'PHASE5_CAPTURE_ADMISSION_BINDING_MISMATCH',
  );
  if (!exactPlainDataObject(expected, ADMISSION_BINDING_FIELDS)
      || typeof expected.runId !== 'string'
      || !UUID_V4.test(expected.runId)
      || typeof expected.challenge !== 'string'
      || !HEX64.test(expected.challenge)
      || typeof expected.captureNonce !== 'string'
      || !HEX64.test(expected.captureNonce)
      || trustedAdmission.runId !== expected.runId
      || trustedAdmission.challenge !== expected.challenge
      || trustedAdmission.captureNonce !== expected.captureNonce) {
    fail('PHASE5_CAPTURE_ADMISSION_BINDING_MISMATCH');
  }
  return Object.isFrozen(admission)
    ? admission
    : trustedAdmission;
}
