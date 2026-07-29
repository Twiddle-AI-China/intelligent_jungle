import { canonicalJson } from './phase5-fault-evidence.mjs';

export const MAX_PHASE5_SPECIES_RESPONSE_BYTES = 1024 * 1024;
export const MAX_PHASE5_SPECIES_SAMPLES_BYTES = 64 * 1024 * 1024;

const KIND = 'isolated-equivalent-spark-phase5-species-load-samples';
const TIMEOUT_MS = 10_000;
const WINDOW_DURATION_MS = 30 * 60 * 1_000;
const RETAINED_DOCUMENT_OVERHEAD_BYTES = 64 * 1024;
const RETAINED_SAMPLE_OVERHEAD_BYTES = 1024;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BINDING_FIELDS = Object.freeze([
  'runId',
  'challenge',
  'release',
  'geometry',
  'profile',
]);
const WINDOW_FIELDS = Object.freeze([
  'startedAtMonotonicMs',
  'endedAtMonotonicMs',
  'startedAtUnixMs',
  'endedAtUnixMs',
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
const ROW_VOICES = Object.freeze(['bass', 'pad', 'lead', 'pluck', 'pad']);
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const ARRAY_BUFFER_PROTOTYPE = ArrayBuffer.prototype;
const UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const BUFFER_PROTOTYPE = Buffer.prototype;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(
  UINT8_ARRAY_PROTOTYPE,
);
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
).get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
).get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteOffset',
).get;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ARRAY_BUFFER_PROTOTYPE,
  'byteLength',
).get;
const TYPED_ARRAY_SET = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'set',
).value;
const OWNED_UINT8_ARRAY = Uint8Array;
const OWNED_BUFFER_FROM = Buffer.from.bind(Buffer);
const OWNED_BUFFER_ALLOC_UNSAFE = Buffer.allocUnsafe.bind(Buffer);

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validOwnedBinding(value) {
  if (!hasExactKeys(value, BINDING_FIELDS)
      || typeof value.runId !== 'string'
      || !UUID_V4.test(value.runId)
      || typeof value.challenge !== 'string'
      || !HEX64.test(value.challenge)
      || !hasExactKeys(value.release, RELEASE_FIELDS)
      || typeof value.release.releaseManifestSha256 !== 'string'
      || !HEX64.test(value.release.releaseManifestSha256)
      || typeof value.release.releaseRevision !== 'string'
      || !HEX40.test(value.release.releaseRevision)
      || typeof value.release.sourceManifestSha256 !== 'string'
      || !HEX64.test(value.release.sourceManifestSha256)
      || typeof value.release.audioArtifactSha256 !== 'string'
      || !HEX64.test(value.release.audioArtifactSha256)
      || !hasExactKeys(value.geometry, GEOMETRY_FIELDS)
      || value.geometry.sampleRate !== 44_100
      || value.geometry.blockFrames !== 4_096
      || value.geometry.poolSize !== 5
      || !Array.isArray(value.geometry.rowVoices)
      || value.geometry.rowVoices.length !== ROW_VOICES.length
      || value.geometry.rowVoices.some((
        voice,
        index,
      ) => voice !== ROW_VOICES[index])
      || !hasExactKeys(value.profile, PROFILE_FIELDS)
      || value.profile.clients !== 4
      || value.profile.slowClient !== 4
      || value.profile.durationMinutes !== 30
      || value.profile.speciesEndpoint !== 'http://127.0.0.1:8081/v1'
      || value.profile.speciesModel !== 'bird_agent') {
    return false;
  }
  return true;
}

function validOwnedWindow(value) {
  return hasExactKeys(value, WINDOW_FIELDS)
    && WINDOW_FIELDS.every((field) => nonNegativeSafeInteger(value[field]))
    && value.endedAtMonotonicMs - value.startedAtMonotonicMs
      === WINDOW_DURATION_MS
    && value.endedAtUnixMs - value.startedAtUnixMs
      === WINDOW_DURATION_MS;
}

function clockValue(value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Phase5SpeciesRawRecorderError(
      'PHASE5_SPECIES_RAW_RECORDER_CLOCK_INVALID',
    );
  }
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded)) {
    throw new Phase5SpeciesRawRecorderError(
      'PHASE5_SPECIES_RAW_RECORDER_CLOCK_INVALID',
    );
  }
  return rounded;
}

function requestBody(model) {
  return JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 16,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'flock_health_token',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { const: true } },
        },
      },
    },
    messages: [{
      role: 'user',
      content: 'Return one compact JSON health token.',
    }],
  });
}

function responseBodyError(code) {
  const error = new Error(code);
  error.phase5SpeciesFailureCode = code;
  throw error;
}

function awaitWithAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    let completed = false;
    const finish = (callback, value) => {
      if (completed) return;
      completed = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      const error = new Error('PHASE5_SPECIES_REQUEST_TIMEOUT');
      error.phase5SpeciesFailureCode = 'PHASE5_SPECIES_REQUEST_TIMEOUT';
      finish(reject, error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) onAbort();
  });
}

function contentLength(response) {
  if (response.headers === undefined || response.headers === null) return null;
  if (typeof response.headers !== 'object'
      || typeof response.headers.get !== 'function') {
    responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
  }
  const raw = response.headers.get('content-length');
  if (raw === null) return null;
  if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
  }
  return value;
}

function exactTypedArraySnapshot(value) {
  try {
    const prototype = OBJECT_GET_PROTOTYPE_OF(value);
    if (prototype !== UINT8_ARRAY_PROTOTYPE
        && prototype !== BUFFER_PROTOTYPE) {
      return null;
    }
    const buffer = TYPED_ARRAY_BUFFER_GETTER.call(value);
    if (OBJECT_GET_PROTOTYPE_OF(buffer) !== ARRAY_BUFFER_PROTOTYPE) {
      return null;
    }
    return {
      buffer,
      byteLength: TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value),
      byteOffset: TYPED_ARRAY_BYTE_OFFSET_GETTER.call(value),
    };
  } catch {
    return null;
  }
}

function exactArrayBufferByteLength(value) {
  try {
    if (OBJECT_GET_PROTOTYPE_OF(value) !== ARRAY_BUFFER_PROTOTYPE) {
      return null;
    }
    return ARRAY_BUFFER_BYTE_LENGTH_GETTER.call(value);
  } catch {
    return null;
  }
}

function ownedBufferFromSnapshot({
  buffer,
  byteLength,
  byteOffset = 0,
}) {
  try {
    return OWNED_BUFFER_FROM(
      new OWNED_UINT8_ARRAY(buffer, byteOffset, byteLength),
    );
  } catch {
    responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
  }
}

function copySnapshotIntoOwned(snapshot, owned, offset) {
  try {
    const source = new OWNED_UINT8_ARRAY(
      snapshot.buffer,
      snapshot.byteOffset,
      snapshot.byteLength,
    );
    TYPED_ARRAY_SET.call(owned, source, offset);
  } catch {
    responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
  }
}

function cancelReader(reader) {
  try {
    Promise.resolve(reader.cancel()).catch(() => {});
  } catch {
    // The read failure is authoritative even if cancellation fails.
  }
}

async function boundedResponseBody(response, signal) {
  if (signal.aborted) {
    responseBodyError('PHASE5_SPECIES_REQUEST_TIMEOUT');
  }
  const declaredLength = contentLength(response);
  if (declaredLength !== null
      && declaredLength > MAX_PHASE5_SPECIES_RESPONSE_BYTES) {
    responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_TOO_LARGE');
  }

  if (response.body !== undefined
      && response.body !== null
      && typeof response.body === 'object'
      && typeof response.body.getReader === 'function') {
    let reader;
    try {
      reader = response.body.getReader();
    } catch {
      responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
    }
    if (reader === null
        || typeof reader !== 'object'
        || typeof reader.read !== 'function'
        || typeof reader.cancel !== 'function'
        || typeof reader.releaseLock !== 'function') {
      responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
    }
    let owned;
    try {
      owned = OWNED_BUFFER_ALLOC_UNSAFE(
        MAX_PHASE5_SPECIES_RESPONSE_BYTES,
      );
    } catch {
      responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
    }
    let received = 0;
    try {
      while (true) {
        if (signal.aborted) {
          responseBodyError('PHASE5_SPECIES_REQUEST_TIMEOUT');
        }
        const item = await awaitWithAbort(reader.read(), signal);
        if (item === null || typeof item !== 'object') {
          responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
        }
        const done = item.done;
        if (done === true) break;
        const value = item.value;
        if (done !== false) {
          responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
        }
        const snapshot = exactTypedArraySnapshot(value);
        if (snapshot === null) {
          responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
        }
        if (snapshot.byteLength === 0) {
          cancelReader(reader);
          responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
        }
        if (snapshot.byteLength
            > MAX_PHASE5_SPECIES_RESPONSE_BYTES - received) {
          cancelReader(reader);
          responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_TOO_LARGE');
        }
        copySnapshotIntoOwned(snapshot, owned, received);
        received += snapshot.byteLength;
      }
      if (signal.aborted) {
        responseBodyError('PHASE5_SPECIES_REQUEST_TIMEOUT');
      }
      const ownedSnapshot = exactTypedArraySnapshot(owned);
      if (ownedSnapshot === null) {
        responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
      }
      return OWNED_BUFFER_FROM(
        ownedSnapshot.buffer,
        ownedSnapshot.byteOffset,
        received,
      );
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A completed/failed read remains authoritative.
      }
    }
  }

  if (declaredLength === null
      || typeof response.arrayBuffer !== 'function') {
    responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
  }
  const rawBody = await awaitWithAbort(response.arrayBuffer(), signal);
  if (signal.aborted) {
    responseBodyError('PHASE5_SPECIES_REQUEST_TIMEOUT');
  }
  const rawBodyByteLength = exactArrayBufferByteLength(rawBody);
  if (rawBodyByteLength === null) {
    responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
  }
  if (rawBodyByteLength > MAX_PHASE5_SPECIES_RESPONSE_BYTES) {
    responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_TOO_LARGE');
  }
  if (rawBodyByteLength !== declaredLength) {
    responseBodyError('PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED');
  }
  return ownedBufferFromSnapshot({
    buffer: rawBody,
    byteLength: rawBodyByteLength,
  });
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

function parseStrictJsonText(text) {
  if (typeof text !== 'string') return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  let index = 0;
  const numberToken =
    /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

  function skipWhitespace() {
    while (index < text.length
           && (text[index] === ' '
             || text[index] === '\t'
             || text[index] === '\r'
             || text[index] === '\n')) {
      index += 1;
    }
  }

  function parseStringToken() {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (character === '\\') {
        index += 1;
        if (index >= text.length) throw new Error('INVALID_JSON');
        if (text[index] === 'u') index += 4;
      }
      index += 1;
    }
    throw new Error('INVALID_JSON');
  }

  function parseValue() {
    skipWhitespace();
    const character = text[index];
    if (character === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      while (true) {
        skipWhitespace();
        if (text[index] !== '"') throw new Error('INVALID_JSON');
        const key = parseStringToken();
        if (keys.has(key)) throw new Error('DUPLICATE_JSON_MEMBER');
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') throw new Error('INVALID_JSON');
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index] !== ',') throw new Error('INVALID_JSON');
        index += 1;
      }
    }
    if (character === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      while (true) {
        parseValue();
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index] !== ',') throw new Error('INVALID_JSON');
        index += 1;
      }
    }
    if (character === '"') {
      parseStringToken();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    numberToken.lastIndex = index;
    const number = numberToken.exec(text);
    if (number === null) throw new Error('INVALID_JSON');
    index = numberToken.lastIndex;
  }

  try {
    parseValue();
    skipWhitespace();
    if (index !== text.length) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function parseStrictJsonBytes(bytes) {
  try {
    if (!(bytes instanceof Uint8Array)
        || (bytes.byteLength >= 3
          && bytes[0] === 0xef
          && bytes[1] === 0xbb
          && bytes[2] === 0xbf)) {
      return undefined;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseStrictJsonText(text);
  } catch {
    return undefined;
  }
}

function validResponseToken(bytes) {
  const response = parseStrictJsonBytes(bytes);
  if (!isPlainObject(response)
      || !Array.isArray(response.choices)
      || response.choices.length === 0
      || !isPlainObject(response.choices[0])
      || !isPlainObject(response.choices[0].message)
      || typeof response.choices[0].message.content !== 'string'
      || !validUnicodeScalarString(response.choices[0].message.content)) {
    return false;
  }
  const token = parseStrictJsonText(response.choices[0].message.content);
  return hasExactKeys(token, ['ok']) && token.ok === true;
}

function validDualClockInterval(record, window) {
  const values = [
    record.startedAtMonotonicMs,
    record.startedAtUnixMs,
    record.settledAtMonotonicMs,
    record.settledAtUnixMs,
  ];
  if (!values.every(nonNegativeSafeInteger)
      || record.startedAtMonotonicMs < window.startedAtMonotonicMs
      || record.settledAtMonotonicMs < record.startedAtMonotonicMs
      || record.settledAtMonotonicMs > window.endedAtMonotonicMs
      || record.startedAtUnixMs < window.startedAtUnixMs
      || record.settledAtUnixMs < record.startedAtUnixMs
      || record.settledAtUnixMs > window.endedAtUnixMs) {
    return false;
  }
  const startedOffsetDrift = Math.abs(
    (record.startedAtMonotonicMs - window.startedAtMonotonicMs)
      - (record.startedAtUnixMs - window.startedAtUnixMs),
  );
  const settledOffsetDrift = Math.abs(
    (record.settledAtMonotonicMs - window.startedAtMonotonicMs)
      - (record.settledAtUnixMs - window.startedAtUnixMs),
  );
  const monotonicDuration =
    record.settledAtMonotonicMs - record.startedAtMonotonicMs;
  const unixDuration =
    record.settledAtUnixMs - record.startedAtUnixMs;
  return startedOffsetDrift <= 1
    && settledOffsetDrift <= 1
    && Math.abs(monotonicDuration - unixDuration) <= 1
    && monotonicDuration <= 15_000;
}

function validAcceptedObservations(observations, mode, window) {
  const slotsPerBatch = mode === 'normal' ? 1 : 4;
  const minimumBatches = mode === 'normal'
    ? Math.floor(WINDOW_DURATION_MS / 2_000 * 0.95)
    : Math.floor(WINDOW_DURATION_MS / 10_000 * 0.95);
  const maximumBatches = mode === 'normal'
    ? Math.floor(WINDOW_DURATION_MS / 2_000) + 1
    : Math.floor(WINDOW_DURATION_MS / 10_000) + 1;
  if (observations.length % slotsPerBatch !== 0
      || observations.length / slotsPerBatch < minimumBatches
      || observations.length / slotsPerBatch > maximumBatches) {
    return false;
  }

  for (let index = 0; index < observations.length; index += 1) {
    const record = observations[index];
    if (record.sequence !== index + 1
        || record.batchSequence
          !== Math.floor(index / slotsPerBatch) + 1
        || record.slot !== index % slotsPerBatch + 1
        || record.httpStatus !== 200
        || record.outcome !== 'success'
        || record.failureCode !== null
        || typeof record.responseBodyBase64 !== 'string'
        || !validDualClockInterval(record, window)) {
      return false;
    }
  }

  const batchStarts = observations.filter((
    _record,
    index,
  ) => index % slotsPerBatch === 0);
  for (let index = 1; index < batchStarts.length; index += 1) {
    if (batchStarts[index].startedAtMonotonicMs
          <= batchStarts[index - 1].startedAtMonotonicMs
        || batchStarts[index].startedAtUnixMs
          <= batchStarts[index - 1].startedAtUnixMs) {
      return false;
    }
  }
  const maxSettledMonotonicMs = Math.max(
    ...observations.map((record) => record.settledAtMonotonicMs),
  );
  const maxSettledUnixMs = Math.max(
    ...observations.map((record) => record.settledAtUnixMs),
  );
  const firstStartLimit = mode === 'normal' ? 4_000 : 20_000;
  const finalSettleLimit = mode === 'normal' ? 10_000 : 50_000;
  const batchGapLimit = mode === 'normal' ? 10_000 : 50_000;
  if (batchStarts[0].startedAtMonotonicMs
        - window.startedAtMonotonicMs > firstStartLimit
      || batchStarts[0].startedAtUnixMs
        - window.startedAtUnixMs > firstStartLimit
      || window.endedAtMonotonicMs
        - maxSettledMonotonicMs > finalSettleLimit
      || window.endedAtUnixMs - maxSettledUnixMs > finalSettleLimit) {
    return false;
  }
  for (let index = 1; index < batchStarts.length; index += 1) {
    if (batchStarts[index].startedAtMonotonicMs
          - batchStarts[index - 1].startedAtMonotonicMs > batchGapLimit
        || batchStarts[index].startedAtUnixMs
          - batchStarts[index - 1].startedAtUnixMs > batchGapLimit) {
      return false;
    }
  }
  if (mode === 'burst') {
    for (let offset = 0; offset < observations.length; offset += 4) {
      const batch = observations.slice(offset, offset + 4);
      for (const field of ['startedAtMonotonicMs', 'startedAtUnixMs']) {
        const values = batch.map((record) => record[field]);
        if (Math.max(...values) - Math.min(...values) > 100) return false;
        for (let index = 1; index < values.length; index += 1) {
          if (values[index] < values[index - 1]) return false;
        }
      }
    }
  }
  return true;
}

function cloneObservations(observations) {
  return observations.map((observation) => ({ ...observation }));
}

export class Phase5SpeciesRawRecorderError extends Error {
  constructor(code, observations = []) {
    super(code);
    this.name = 'Phase5SpeciesRawRecorderError';
    this.code = code;
    this.observations = cloneObservations(observations);
  }
}

export function createPhase5SpeciesRawRecorder({
  mode,
  binding,
  window,
  fetchImpl = fetch,
  monotonicNow = () => performance.now(),
  unixNow = () => Date.now(),
  timeoutSignalFactory = (timeoutMs) => AbortSignal.timeout(timeoutMs),
} = {}) {
  if (!['normal', 'burst'].includes(mode)
      || typeof fetchImpl !== 'function'
      || typeof monotonicNow !== 'function'
      || typeof unixNow !== 'function'
      || typeof timeoutSignalFactory !== 'function') {
    throw new Phase5SpeciesRawRecorderError(
      'PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID',
    );
  }

  let ownedBinding;
  let ownedWindow;
  try {
    if (!hasExactKeys(binding, BINDING_FIELDS)
        || !hasExactKeys(window, WINDOW_FIELDS)) {
      throw new Error('INVALID_SHAPE');
    }
    ownedBinding = clone(binding);
    ownedWindow = clone(window);
    if (!validOwnedBinding(ownedBinding)
        || !validOwnedWindow(ownedWindow)) {
      throw new Error('INVALID_PROFILE');
    }
  } catch {
    throw new Phase5SpeciesRawRecorderError(
      'PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID',
    );
  }

  const observations = [];
  let nextSequence = 1;
  let nextBatchSequence = 1;
  let dispatchInProgress = false;
  let retainedEvidenceBudgetBytes = RETAINED_DOCUMENT_OVERHEAD_BYTES;
  let finalizedBytes = null;

  function captureClock() {
    try {
      return {
        monotonicMs: clockValue(monotonicNow()),
        unixMs: clockValue(unixNow()),
      };
    } catch (error) {
      if (error instanceof Phase5SpeciesRawRecorderError) throw error;
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_CLOCK_INVALID',
        observations,
      );
    }
  }

  function createSignals(slots) {
    const signals = [];
    try {
      for (let slot = 0; slot < slots; slot += 1) {
        const signal = timeoutSignalFactory(TIMEOUT_MS);
        if (!(signal instanceof AbortSignal)
            || signal.aborted) {
          throw new Error('INVALID_ABORT_SIGNAL');
        }
        signals.push(signal);
      }
      if (signals.some((signal) => signal.aborted)) {
        throw new Error('ABORT_SIGNAL_CHANGED');
      }
    } catch {
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID',
        observations,
      );
    }
    return signals;
  }

  async function executeRequest({
    record,
    signal,
  }) {
    let failureCode = null;
    try {
      const response = await awaitWithAbort(
        fetchImpl(
          `${
            ownedBinding.profile.speciesEndpoint.replace(/\/+$/, '')
          }/chat/completions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal,
            body: requestBody(ownedBinding.profile.speciesModel),
          },
        ),
        signal,
      );
      if (Number.isSafeInteger(response?.status)) {
        record.httpStatus = response.status;
      }
      if (response === null
          || typeof response !== 'object') {
        failureCode = 'PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED';
      } else {
        let body;
        try {
          body = await boundedResponseBody(response, signal);
        } catch (error) {
          if (typeof error?.phase5SpeciesFailureCode === 'string') {
            failureCode = error.phase5SpeciesFailureCode;
          } else if (signal.aborted
                     || error?.name === 'TimeoutError'
                     || error?.name === 'AbortError') {
            failureCode = 'PHASE5_SPECIES_REQUEST_TIMEOUT';
          } else {
            failureCode = 'PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED';
          }
        }
        if (body !== undefined) {
          const responseBodyBase64 = body.toString('base64');
          const retainedCost = responseBodyBase64.length
            + RETAINED_SAMPLE_OVERHEAD_BYTES;
          if (record.httpStatus !== 200) {
            failureCode = 'PHASE5_SPECIES_HTTP_STATUS_INVALID';
          } else if (!validResponseToken(body)) {
            failureCode = 'PHASE5_SPECIES_RESPONSE_TOKEN_INVALID';
          }
          if (retainedEvidenceBudgetBytes + retainedCost
              > MAX_PHASE5_SPECIES_SAMPLES_BYTES) {
            failureCode = 'PHASE5_SPECIES_RAW_ARTIFACT_TOO_LARGE';
          } else {
            record.responseBodyBase64 = responseBodyBase64;
            retainedEvidenceBudgetBytes += retainedCost;
          }
        }
      }
    } catch (error) {
      failureCode = (
        signal.aborted
        || error?.name === 'TimeoutError'
        || error?.name === 'AbortError'
      )
        ? 'PHASE5_SPECIES_REQUEST_TIMEOUT'
        : 'PHASE5_SPECIES_REQUEST_FAILED';
    } finally {
      try {
        const settled = captureClock();
        record.settledAtMonotonicMs = settled.monotonicMs;
        record.settledAtUnixMs = settled.unixMs;
        record.outcome = failureCode === null ? 'success' : 'failure';
        record.failureCode = failureCode;
      } catch (error) {
        record.outcome = 'failure';
        record.failureCode = 'PHASE5_SPECIES_RAW_RECORDER_CLOCK_INVALID';
        throw error;
      }
    }
  }

  function dispatchBatch(...args) {
    if (finalizedBytes !== null) {
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_FINALIZED',
        observations,
      );
    }
    if (dispatchInProgress) {
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_BUSY',
        observations,
      );
    }
    if (args.length !== 0) {
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID',
        observations,
      );
    }
    const batchSequence = nextBatchSequence;
    const slots = mode === 'normal' ? 1 : 4;
    const maximumBatches = mode === 'normal'
      ? Math.floor(WINDOW_DURATION_MS / 2_000) + 1
      : Math.floor(WINDOW_DURATION_MS / 10_000) + 1;
    if (observations.length + slots > maximumBatches * slots) {
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_SAMPLE_LIMIT',
        observations,
      );
    }
    dispatchInProgress = true;
    try {
      const signals = createSignals(slots);
      const starts = Array.from({ length: slots }, () => captureClock());
      if (signals.some((signal) => signal.aborted)) {
        throw new Phase5SpeciesRawRecorderError(
          'PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID',
          observations,
        );
      }
      const batchRecords = starts.map((started, index) => ({
        sequence: nextSequence + index,
        batchSequence,
        slot: index + 1,
        startedAtMonotonicMs: started.monotonicMs,
        startedAtUnixMs: started.unixMs,
        settledAtMonotonicMs: null,
        settledAtUnixMs: null,
        httpStatus: null,
        responseBodyBase64: null,
        outcome: 'pending',
        failureCode: null,
      }));
      nextSequence += slots;
      nextBatchSequence += 1;
      observations.push(...batchRecords);
      let batchFailed = false;
      let firstBatchError;
      const tasks = batchRecords.map((record, index) => executeRequest({
        record,
        signal: signals[index],
      }).catch((error) => {
        if (!batchFailed) {
          batchFailed = true;
          firstBatchError = error;
        }
        throw error;
      }));
      return Promise.allSettled(tasks)
        .then(() => {
          if (batchFailed) throw firstBatchError;
          return cloneObservations(batchRecords);
        })
        .finally(() => {
          dispatchInProgress = false;
        });
    } catch (error) {
      dispatchInProgress = false;
      throw error;
    }
  }

  function getObservations() {
    return cloneObservations(observations);
  }

  function finalizeAcceptedBytes(...args) {
    if (args.length !== 0) {
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID',
        observations,
      );
    }
    if (dispatchInProgress) {
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_BUSY',
        observations,
      );
    }
    if (finalizedBytes !== null) return Buffer.from(finalizedBytes);
    if (observations.length === 0) {
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_EMPTY',
      );
    }
    if (observations.some(({ outcome }) => outcome === 'pending')) {
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_PENDING',
        observations,
      );
    }
    if (observations.some(({ outcome }) => outcome !== 'success')) {
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_REJECTED',
        observations,
      );
    }
    if (!validAcceptedObservations(observations, mode, ownedWindow)) {
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_REJECTED',
        observations,
      );
    }
    const samples = observations.map((observation) => ({
      sequence: observation.sequence,
      batchSequence: observation.batchSequence,
      slot: observation.slot,
      startedAtMonotonicMs: observation.startedAtMonotonicMs,
      startedAtUnixMs: observation.startedAtUnixMs,
      settledAtMonotonicMs: observation.settledAtMonotonicMs,
      settledAtUnixMs: observation.settledAtUnixMs,
      httpStatus: observation.httpStatus,
      responseBodyBase64: observation.responseBodyBase64,
    }));
    const document = {
      schemaVersion: 2,
      kind: KIND,
      ...ownedBinding,
      window: ownedWindow,
      mode,
      samples,
    };
    finalizedBytes = Buffer.from(canonicalJson(document), 'utf8');
    if (finalizedBytes.byteLength > MAX_PHASE5_SPECIES_SAMPLES_BYTES) {
      finalizedBytes = null;
      throw new Phase5SpeciesRawRecorderError(
        'PHASE5_SPECIES_RAW_RECORDER_REJECTED',
        observations,
      );
    }
    return Buffer.from(finalizedBytes);
  }

  return Object.freeze({
    dispatchBatch,
    getObservations,
    finalizeAcceptedBytes,
  });
}
