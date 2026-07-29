import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';

const KIND = 'isolated-equivalent-spark-fault-events';
const SIGNING_DOMAIN = Buffer.from('flock-phase5-fault-event-v1\0', 'utf8');
const CLOSURE_SIGNING_DOMAIN =
  Buffer.from('flock-phase5-run-closure-v1\0', 'utf8');
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
const MINIMUM_WINDOW_MS = 30 * 60 * 1_000;
const FINAL_STABILITY_WINDOW_MS = 30_000;
const MAX_TRANSPORT_END_LAG_MS = 250;
const MAX_CLOCK_OFFSET_DRIFT_MS = 1;
const FIXED_ROW_VOICES = Object.freeze(['bass', 'pad', 'lead', 'pluck', 'pad']);

const TOP_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'runId',
  'challenge',
  'release',
  'geometry',
  'profile',
  'window',
  'signer',
  'scenarioEvents',
  'transportEvents',
  'eventChainSha256',
  'transportChainSha256',
  'closure',
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
const WINDOW_FIELDS = Object.freeze([
  'startedAtMonotonicMs',
  'endedAtMonotonicMs',
  'startedAtUnixMs',
  'endedAtUnixMs',
]);
const SIGNER_FIELDS = Object.freeze([
  'algorithm',
  'publicKeySpkiDerBase64',
  'publicKeySpkiSha256',
]);
const EVENT_WITHOUT_SIGNATURE_FIELDS = Object.freeze([
  'sequence',
  'runId',
  'scenario',
  'phase',
  'atMonotonicMs',
  'atUnixMs',
  'previousEventSha256',
  'transportPrefixCount',
  'transportPrefixSha256',
  'payload',
]);
const EVENT_FIELDS = Object.freeze([
  ...EVENT_WITHOUT_SIGNATURE_FIELDS,
  'signature',
]);
const EVENT_DRAFT_FIELDS = Object.freeze([
  'scenario',
  'phase',
  'atMonotonicMs',
  'atUnixMs',
  'transportPrefixCount',
  'payload',
]);
const TRANSPORT_EVENT_FIELDS = Object.freeze([
  'sequence',
  'runId',
  'atMonotonicMs',
  'atUnixMs',
  'client',
  'type',
  'previousTransportSha256',
  'payload',
]);
const TRANSPORT_DRAFT_FIELDS = Object.freeze([
  'atMonotonicMs',
  'atUnixMs',
  'client',
  'type',
  'payload',
]);
const CLOSURE_FIELDS = Object.freeze([
  'scenarioEventCount',
  'transportEventCount',
  'signature',
]);
const BUILD_INPUT_FIELDS = Object.freeze([
  'runId',
  'challenge',
  'release',
  'geometry',
  'profile',
  'window',
  'scenarioEvents',
  'transportEvents',
]);

export const ZERO_EVENT_SHA256 = '0'.repeat(64);
export const FAULT_TRANSPORT_EVENT_TYPES = Object.freeze([
  'runtime.open',
  'runtime.ready',
  'runtime.snapshot',
  'runtime.close',
  'runtime.egress',
  'audio.open',
  'audio.ready',
  'audio.pcm',
  'audio.discontinuity',
  'audio.pause',
  'audio.resume',
  'audio.close',
  'worker.sample',
  'agent.start',
  'agent.settle',
  'observer.failure',
]);
const CLIENT_TRANSPORT_TYPES = new Set(
  FAULT_TRANSPORT_EVENT_TYPES.filter(
    (type) => type.startsWith('runtime.') || type.startsWith('audio.'),
  ),
);
const GLOBAL_TRANSPORT_TYPES = new Set(
  FAULT_TRANSPORT_EVENT_TYPES.filter((type) => !CLIENT_TRANSPORT_TYPES.has(type)),
);
export const FAULT_EVENT_PHASES = Object.freeze([
  'before',
  'fault-action',
  'fault-observed',
  'recovery-action',
  'recovery-observed',
]);
export const REAL_FAULT_SCENARIOS = Object.freeze([
  Object.freeze({ scenario: 'worker-crash-restart', recoverySloMs: 15_000 }),
  Object.freeze({ scenario: 'runtime-reconnect', recoverySloMs: 5_000 }),
  Object.freeze({ scenario: 'slow-client', recoverySloMs: 7_000 }),
  Object.freeze({ scenario: 'queue-pressure', recoverySloMs: 5_000 }),
  Object.freeze({ scenario: 'agent-timeout', recoverySloMs: 15_000 }),
  Object.freeze({ scenario: 'agent-malformed-response', recoverySloMs: 15_000 }),
  Object.freeze({ scenario: 'audio-epoch-discontinuity', recoverySloMs: 10_000 }),
]);

function fail(code) {
  throw new Error(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function enumerableDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
}

function ordinaryDenseArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) return false;
  const ownKeySet = new Set(ownKeys);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined
      || !Object.hasOwn(lengthDescriptor, 'value')
      || lengthDescriptor.value !== value.length) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (!ownKeySet.has(key) || !enumerableDataProperty(value, key)) return false;
  }
  return ownKeys.every((key) => (
    key === 'length'
      || (typeof key === 'string'
        && /^(?:0|[1-9][0-9]*)$/.test(key)
        && Number(key) < value.length)
  ));
}

function exactObjectKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string')
    && expected.every((key) => (
      keys.includes(key) && enumerableDataProperty(value, key)
    ));
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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
      fail('PHASE5_FAULT_CANONICAL_JSON_INVALID');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PHASE5_FAULT_CANONICAL_JSON_INVALID');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') fail('PHASE5_FAULT_CANONICAL_JSON_INVALID');
  if (ancestors.has(value)) fail('PHASE5_FAULT_CANONICAL_JSON_INVALID');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (!ordinaryDenseArray(value)) fail('PHASE5_FAULT_CANONICAL_JSON_INVALID');
      return `[${value.map((item) => canonicalJsonInternal(item, ancestors)).join(',')}]`;
    }
    if (!isPlainObject(value)) {
      fail('PHASE5_FAULT_CANONICAL_JSON_INVALID');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => (
      typeof key !== 'string' || !validUnicodeScalarString(key)
        || !enumerableDataProperty(value, key)
    ))) {
      fail('PHASE5_FAULT_CANONICAL_JSON_INVALID');
    }
    return `{${keys.sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJsonInternal(value[key], ancestors)}`
    )).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  return canonicalJsonInternal(value, new Set());
}

function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

function validateRunIdentity(runId, challenge) {
  if (typeof runId !== 'string' || !UUID_V4.test(runId)) {
    fail('PHASE5_FAULT_RUN_ID_INVALID');
  }
  if (typeof challenge !== 'string' || !HEX64.test(challenge)) {
    fail('PHASE5_FAULT_CHALLENGE_INVALID');
  }
}

function validateRelease(release) {
  if (!exactObjectKeys(release, RELEASE_FIELDS)
      || !HEX64.test(release.releaseManifestSha256)
      || !HEX40.test(release.releaseRevision)
      || !HEX64.test(release.sourceManifestSha256)
      || !HEX64.test(release.audioArtifactSha256)) {
    fail('PHASE5_FAULT_RELEASE_INVALID');
  }
}

function validateGeometry(geometry) {
  if (!exactObjectKeys(geometry, GEOMETRY_FIELDS)
      || geometry.sampleRate !== 44_100
      || geometry.blockFrames !== 4_096
      || geometry.poolSize !== 5
      || !ordinaryDenseArray(geometry.rowVoices)
      || geometry.rowVoices.length !== FIXED_ROW_VOICES.length
      || geometry.rowVoices.some((voice, index) => (
        voice !== FIXED_ROW_VOICES[index]
      ))) {
    fail('PHASE5_FAULT_GEOMETRY_INVALID');
  }
}

function validateProfile(profile) {
  if (!exactObjectKeys(profile, PROFILE_FIELDS)
      || profile.clients !== 4
      || profile.slowClient !== 4
      || profile.durationMinutes !== 30
      || profile.speciesEndpoint !== 'http://127.0.0.1:8081/v1'
      || profile.speciesModel !== 'bird_agent') {
    fail('PHASE5_FAULT_PROFILE_INVALID');
  }
}

function validateWindow(window) {
  if (!exactObjectKeys(window, WINDOW_FIELDS)
      || !nonNegativeSafeInteger(window.startedAtMonotonicMs)
      || !nonNegativeSafeInteger(window.endedAtMonotonicMs)
      || !positiveSafeInteger(window.startedAtUnixMs)
      || !positiveSafeInteger(window.endedAtUnixMs)
      || window.endedAtMonotonicMs < window.startedAtMonotonicMs
      || window.endedAtUnixMs < window.startedAtUnixMs
      || window.endedAtMonotonicMs - window.startedAtMonotonicMs
        !== MINIMUM_WINDOW_MS
      || window.endedAtUnixMs - window.startedAtUnixMs !== MINIMUM_WINDOW_MS) {
    fail('PHASE5_FAULT_WINDOW_INVALID');
  }
}

function eventWithoutSignature(event) {
  const expected = Object.hasOwn(event ?? {}, 'signature')
    ? EVENT_FIELDS
    : EVENT_WITHOUT_SIGNATURE_FIELDS;
  if (!exactObjectKeys(event, expected)) {
    fail('PHASE5_FAULT_EVENT_SHAPE_INVALID');
  }
  return Object.fromEntries(
    EVENT_WITHOUT_SIGNATURE_FIELDS.map((field) => [field, event[field]]),
  );
}

export function faultEventSigningBytes({ challenge, release, event } = {}) {
  if (typeof challenge !== 'string' || !HEX64.test(challenge)) {
    fail('PHASE5_FAULT_CHALLENGE_INVALID');
  }
  validateRelease(release);
  const unsignedEvent = eventWithoutSignature(event);
  if (!isPlainObject(unsignedEvent.payload)) {
    fail('PHASE5_FAULT_EVENT_PAYLOAD_INVALID');
  }
  const body = canonicalJson({
    challenge,
    release,
    event: unsignedEvent,
  });
  return Buffer.concat([SIGNING_DOMAIN, Buffer.from(body, 'utf8')]);
}

export function faultRunClosureSigningBytes(evidence) {
  if (!exactObjectKeys(evidence, TOP_FIELDS)
      || !exactObjectKeys(evidence.closure, CLOSURE_FIELDS)
      || !positiveSafeInteger(evidence.closure.scenarioEventCount)
      || !positiveSafeInteger(evidence.closure.transportEventCount)
      || typeof evidence.eventChainSha256 !== 'string'
      || !HEX64.test(evidence.eventChainSha256)
      || typeof evidence.transportChainSha256 !== 'string'
      || !HEX64.test(evidence.transportChainSha256)) {
    fail('PHASE5_FAULT_CLOSURE_INVALID');
  }
  validateRunIdentity(evidence.runId, evidence.challenge);
  validateRelease(evidence.release);
  validateGeometry(evidence.geometry);
  validateProfile(evidence.profile);
  validateWindow(evidence.window);
  const body = canonicalJson({
    runId: evidence.runId,
    challenge: evidence.challenge,
    release: evidence.release,
    geometry: evidence.geometry,
    profile: evidence.profile,
    window: evidence.window,
    eventChainSha256: evidence.eventChainSha256,
    transportChainSha256: evidence.transportChainSha256,
    scenarioEventCount: evidence.closure.scenarioEventCount,
    transportEventCount: evidence.closure.transportEventCount,
  });
  return Buffer.concat([
    CLOSURE_SIGNING_DOMAIN,
    Buffer.from(body, 'utf8'),
  ]);
}

function canonicalBase64(value, code) {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) fail(code);
  return decoded;
}

function normalizedPublicKey(value) {
  try {
    const key = value?.type === 'public' ? value : createPublicKey(value);
    if (key.asymmetricKeyType !== 'ed25519') {
      fail('PHASE5_FAULT_SIGNER_KEY_INVALID');
    }
    return key;
  } catch (error) {
    if (error?.message === 'PHASE5_FAULT_SIGNER_KEY_INVALID') throw error;
    fail('PHASE5_FAULT_SIGNER_KEY_INVALID');
  }
}

function normalizedPrivateKey(value) {
  try {
    const key = value?.type === 'private' ? value : createPrivateKey(value);
    if (key.asymmetricKeyType !== 'ed25519') {
      fail('PHASE5_FAULT_SIGNER_KEY_INVALID');
    }
    return key;
  } catch (error) {
    if (error?.message === 'PHASE5_FAULT_SIGNER_KEY_INVALID') throw error;
    fail('PHASE5_FAULT_SIGNER_KEY_INVALID');
  }
}

export function createEd25519SignerDescriptor(publicKeyInput) {
  const publicKey = normalizedPublicKey(publicKeyInput);
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return {
    algorithm: 'Ed25519',
    publicKeySpkiDerBase64: spki.toString('base64'),
    publicKeySpkiSha256: sha256(spki),
  };
}

function parseSigner(signer, options) {
  if (!exactObjectKeys(signer, SIGNER_FIELDS)
      || signer.algorithm !== 'Ed25519'
      || !HEX64.test(signer.publicKeySpkiSha256)) {
    fail('PHASE5_FAULT_SIGNER_INVALID');
  }
  const spki = canonicalBase64(
    signer.publicKeySpkiDerBase64,
    'PHASE5_FAULT_SIGNER_INVALID',
  );
  if (sha256(spki) !== signer.publicKeySpkiSha256) {
    fail('PHASE5_FAULT_SIGNER_INVALID');
  }

  let embeddedPublicKey;
  try {
    embeddedPublicKey = normalizedPublicKey({
      key: spki,
      format: 'der',
      type: 'spki',
    });
  } catch {
    fail('PHASE5_FAULT_SIGNER_INVALID');
  }
  const canonicalDescriptor = createEd25519SignerDescriptor(embeddedPublicKey);
  if (canonicalDescriptor.publicKeySpkiDerBase64 !== signer.publicKeySpkiDerBase64
      || canonicalDescriptor.publicKeySpkiSha256 !== signer.publicKeySpkiSha256) {
    fail('PHASE5_FAULT_SIGNER_INVALID');
  }

  const expectedPublicKey = options?.expectedPublicKey;
  const expectedDigest = options?.expectedSignerSpkiSha256;
  if (expectedPublicKey === undefined && expectedDigest === undefined) {
    fail('PHASE5_FAULT_SIGNER_BINDING_REQUIRED');
  }
  if (expectedPublicKey !== undefined) {
    const expectedDescriptor = createEd25519SignerDescriptor(expectedPublicKey);
    if (expectedDescriptor.publicKeySpkiDerBase64 !== signer.publicKeySpkiDerBase64
        || expectedDescriptor.publicKeySpkiSha256 !== signer.publicKeySpkiSha256) {
      fail('PHASE5_FAULT_SIGNER_BINDING_INVALID');
    }
  }
  if (expectedDigest !== undefined
      && (typeof expectedDigest !== 'string'
        || !HEX64.test(expectedDigest)
        || expectedDigest !== signer.publicKeySpkiSha256)) {
    fail('PHASE5_FAULT_SIGNER_BINDING_INVALID');
  }
  return embeddedPublicKey;
}

export function transportEventSha256(event) {
  if (!exactObjectKeys(event, TRANSPORT_EVENT_FIELDS)) {
    fail('PHASE5_FAULT_TRANSPORT_SHAPE_INVALID');
  }
  return sha256(Buffer.from(canonicalJson(event), 'utf8'));
}

function validateTransportEvents(evidence) {
  const { transportEvents: events, runId, window } = evidence;
  if (events.length === 0) {
    fail('PHASE5_FAULT_TRANSPORT_COUNT_INVALID');
  }

  const digests = [];
  let previousDigest = ZERO_EVENT_SHA256;
  let previousEvent = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!exactObjectKeys(event, TRANSPORT_EVENT_FIELDS)
        || !positiveSafeInteger(event.sequence)
        || event.sequence !== index + 1) {
      fail('PHASE5_FAULT_TRANSPORT_SHAPE_INVALID');
    }
    if (event.runId !== runId) {
      fail('PHASE5_FAULT_TRANSPORT_RUN_BINDING_INVALID');
    }
    if (typeof event.type !== 'string'
        || (!CLIENT_TRANSPORT_TYPES.has(event.type)
          && !GLOBAL_TRANSPORT_TYPES.has(event.type))) {
      fail('PHASE5_FAULT_TRANSPORT_TYPE_INVALID');
    }
    if (!nonNegativeSafeInteger(event.client)
        || (CLIENT_TRANSPORT_TYPES.has(event.type)
          && (event.client < 1 || event.client > 4))
        || (GLOBAL_TRANSPORT_TYPES.has(event.type) && event.client !== 0)) {
      fail('PHASE5_FAULT_TRANSPORT_CLIENT_INVALID');
    }
    if (!nonNegativeSafeInteger(event.atMonotonicMs)
        || !positiveSafeInteger(event.atUnixMs)
        || event.atMonotonicMs < window.startedAtMonotonicMs
        || event.atMonotonicMs > window.endedAtMonotonicMs
        || event.atUnixMs < window.startedAtUnixMs
        || event.atUnixMs > window.endedAtUnixMs
        || Math.abs(
          (event.atMonotonicMs - window.startedAtMonotonicMs)
            - (event.atUnixMs - window.startedAtUnixMs),
        ) > MAX_CLOCK_OFFSET_DRIFT_MS
        || (previousEvent !== null
          && (event.atMonotonicMs < previousEvent.atMonotonicMs
            || event.atUnixMs < previousEvent.atUnixMs))) {
      fail('PHASE5_FAULT_TRANSPORT_TIME_INVALID');
    }
    if (!isPlainObject(event.payload)) {
      fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
    }
    canonicalJson(event.payload);
    if (typeof event.previousTransportSha256 !== 'string'
        || !HEX64.test(event.previousTransportSha256)
        || event.previousTransportSha256 !== previousDigest) {
      fail('PHASE5_FAULT_TRANSPORT_CHAIN_INVALID');
    }
    previousDigest = transportEventSha256(event);
    digests.push(previousDigest);
    previousEvent = event;
  }
  if (evidence.transportChainSha256 !== previousDigest) {
    fail('PHASE5_FAULT_TRANSPORT_CHAIN_INVALID');
  }
  const lastEvent = events.at(-1);
  if (window.endedAtMonotonicMs - lastEvent.atMonotonicMs
        > MAX_TRANSPORT_END_LAG_MS
      || window.endedAtUnixMs - lastEvent.atUnixMs
        > MAX_TRANSPORT_END_LAG_MS) {
    fail('PHASE5_FAULT_TRANSPORT_WINDOW_INCOMPLETE');
  }
  return digests;
}

function validateEventShapeAndPlan(evidence, transportDigests) {
  const { scenarioEvents: events, runId, window } = evidence;
  const expectedCount = REAL_FAULT_SCENARIOS.length * FAULT_EVENT_PHASES.length;
  if (events.length !== expectedCount) {
    fail('PHASE5_FAULT_EVENT_COUNT_INVALID');
  }

  let previousEvent = null;
  let previousTransportPrefixCount = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!exactObjectKeys(event, EVENT_FIELDS)
        || !positiveSafeInteger(event.sequence)
        || event.sequence !== index + 1
        || typeof event.previousEventSha256 !== 'string'
        || !HEX64.test(event.previousEventSha256)
        || !nonNegativeSafeInteger(event.transportPrefixCount)
        || typeof event.transportPrefixSha256 !== 'string'
        || !HEX64.test(event.transportPrefixSha256)
        || typeof event.signature !== 'string'
        || !ED25519_SIGNATURE_BASE64.test(event.signature)
        || canonicalBase64(
          event.signature,
          'PHASE5_FAULT_EVENT_SIGNATURE_INVALID',
        ).length !== 64
        || !isPlainObject(event.payload)) {
      fail('PHASE5_FAULT_EVENT_SHAPE_INVALID');
    }
    if (event.runId !== runId) {
      fail('PHASE5_FAULT_EVENT_RUN_BINDING_INVALID');
    }
    const scenarioIndex = Math.floor(index / FAULT_EVENT_PHASES.length);
    const phaseIndex = index % FAULT_EVENT_PHASES.length;
    const expectedScenario = REAL_FAULT_SCENARIOS[scenarioIndex];
    if (event.scenario !== expectedScenario.scenario
        || event.phase !== FAULT_EVENT_PHASES[phaseIndex]) {
      fail('PHASE5_FAULT_EVENT_PLAN_INVALID');
    }
    if (!nonNegativeSafeInteger(event.atMonotonicMs)
        || !positiveSafeInteger(event.atUnixMs)
        || event.atMonotonicMs < window.startedAtMonotonicMs
        || event.atMonotonicMs > window.endedAtMonotonicMs
        || event.atUnixMs < window.startedAtUnixMs
        || event.atUnixMs > window.endedAtUnixMs
        || Math.abs(
          (event.atMonotonicMs - window.startedAtMonotonicMs)
            - (event.atUnixMs - window.startedAtUnixMs),
        ) > MAX_CLOCK_OFFSET_DRIFT_MS) {
      fail('PHASE5_FAULT_EVENT_TIME_INVALID');
    }
    if (previousEvent !== null) {
      if (phaseIndex === 0
          && (event.atMonotonicMs <= previousEvent.atMonotonicMs
            || event.atUnixMs <= previousEvent.atUnixMs)) {
        fail('PHASE5_FAULT_SCENARIO_OVERLAP');
      }
      if (phaseIndex !== 0
          && (event.atMonotonicMs <= previousEvent.atMonotonicMs
            || event.atUnixMs <= previousEvent.atUnixMs)) {
        fail('PHASE5_FAULT_EVENT_TIME_INVALID');
      }
    }
    if (event.transportPrefixCount > evidence.transportEvents.length) {
      fail('PHASE5_FAULT_TRANSPORT_PREFIX_INVALID');
    }
    const expectedTransportPrefixSha256 = event.transportPrefixCount === 0
      ? ZERO_EVENT_SHA256
      : transportDigests[event.transportPrefixCount - 1];
    if (event.transportPrefixCount < previousTransportPrefixCount
        || event.transportPrefixSha256 !== expectedTransportPrefixSha256) {
      fail('PHASE5_FAULT_TRANSPORT_PREFIX_INVALID');
    }
    if (event.transportPrefixCount > 0) {
      const includedTransport =
        evidence.transportEvents[event.transportPrefixCount - 1];
      if (includedTransport.atMonotonicMs > event.atMonotonicMs
          || includedTransport.atUnixMs > event.atUnixMs) {
        fail('PHASE5_FAULT_TRANSPORT_PREFIX_TIME_INVALID');
      }
    }
    if (event.transportPrefixCount < evidence.transportEvents.length) {
      const firstExcludedTransport =
        evidence.transportEvents[event.transportPrefixCount];
      if (firstExcludedTransport.atMonotonicMs <= event.atMonotonicMs
          || firstExcludedTransport.atUnixMs <= event.atUnixMs) {
        fail('PHASE5_FAULT_TRANSPORT_PREFIX_INCOMPLETE');
      }
    }
    if (phaseIndex === FAULT_EVENT_PHASES.length - 1) {
      const faultAction = events[index - 3];
      if (event.atMonotonicMs - faultAction.atMonotonicMs
            > expectedScenario.recoverySloMs
          || event.atUnixMs - faultAction.atUnixMs
            > expectedScenario.recoverySloMs) {
        fail('PHASE5_FAULT_RECOVERY_SLO_EXCEEDED');
      }
    }
    canonicalJson(event.payload);
    previousEvent = event;
    previousTransportPrefixCount = event.transportPrefixCount;
  }

  const finalEvent = events.at(-1);
  if (finalEvent.transportPrefixCount === 0) {
    fail('PHASE5_FAULT_TRANSPORT_PREFIX_INVALID');
  }
  if (window.endedAtMonotonicMs - finalEvent.atMonotonicMs
        < FINAL_STABILITY_WINDOW_MS
      || window.endedAtUnixMs - finalEvent.atUnixMs
        < FINAL_STABILITY_WINDOW_MS) {
    fail('PHASE5_FAULT_FINAL_STABILITY_WINDOW_INVALID');
  }
}

export function faultEventSha256(event) {
  if (!exactObjectKeys(event, EVENT_FIELDS)) {
    fail('PHASE5_FAULT_EVENT_SHAPE_INVALID');
  }
  return sha256(Buffer.from(canonicalJson(event), 'utf8'));
}

function validateChainAndSignatures(evidence, publicKey) {
  let previousDigest = ZERO_EVENT_SHA256;
  for (const event of evidence.scenarioEvents) {
    if (event.previousEventSha256 !== previousDigest) {
      fail('PHASE5_FAULT_EVENT_CHAIN_INVALID');
    }
    const signature = canonicalBase64(
      event.signature,
      'PHASE5_FAULT_EVENT_SIGNATURE_INVALID',
    );
    const signingBytes = faultEventSigningBytes({
      challenge: evidence.challenge,
      release: evidence.release,
      event,
    });
    if (!verify(null, signingBytes, publicKey, signature)) {
      fail('PHASE5_FAULT_EVENT_SIGNATURE_INVALID');
    }
    previousDigest = faultEventSha256(event);
  }
  if (evidence.eventChainSha256 !== previousDigest) {
    fail('PHASE5_FAULT_EVENT_CHAIN_INVALID');
  }
}

function validateClosure(evidence, publicKey) {
  const { closure } = evidence;
  if (!exactObjectKeys(closure, CLOSURE_FIELDS)
      || !positiveSafeInteger(closure.scenarioEventCount)
      || !positiveSafeInteger(closure.transportEventCount)
      || closure.scenarioEventCount !== evidence.scenarioEvents.length
      || closure.transportEventCount !== evidence.transportEvents.length
      || typeof closure.signature !== 'string'
      || !ED25519_SIGNATURE_BASE64.test(closure.signature)) {
    fail('PHASE5_FAULT_CLOSURE_INVALID');
  }
  const signature = canonicalBase64(
    closure.signature,
    'PHASE5_FAULT_CLOSURE_INVALID',
  );
  if (signature.length !== 64
      || !verify(
        null,
        faultRunClosureSigningBytes(evidence),
        publicKey,
        signature,
      )) {
    fail('PHASE5_FAULT_CLOSURE_INVALID');
  }
}

export function validateSignedFaultEventEvidence(evidence, options = {}) {
  if (!exactObjectKeys(evidence, TOP_FIELDS)
      || evidence.schemaVersion !== 2
      || evidence.kind !== KIND
      || !ordinaryDenseArray(evidence.scenarioEvents)
      || !ordinaryDenseArray(evidence.transportEvents)
      || typeof evidence.eventChainSha256 !== 'string'
      || !HEX64.test(evidence.eventChainSha256)
      || typeof evidence.transportChainSha256 !== 'string'
      || !HEX64.test(evidence.transportChainSha256)
      || !isPlainObject(evidence.closure)
      || !isPlainObject(evidence.profile)) {
    fail('PHASE5_FAULT_EVIDENCE_SHAPE_INVALID');
  }
  validateRunIdentity(evidence.runId, evidence.challenge);
  validateRelease(evidence.release);
  validateGeometry(evidence.geometry);
  validateProfile(evidence.profile);
  validateWindow(evidence.window);
  canonicalJson(evidence.profile);
  canonicalJson(evidence.transportEvents);
  const transportDigests = validateTransportEvents(evidence);
  validateEventShapeAndPlan(evidence, transportDigests);
  const publicKey = parseSigner(evidence.signer, options);
  validateChainAndSignatures(evidence, publicKey);
  validateClosure(evidence, publicKey);
  return evidence;
}

export function createSignedFaultEventEvidence(input, keyPair) {
  if (!exactObjectKeys(input, BUILD_INPUT_FIELDS)) {
    fail('PHASE5_FAULT_BUILD_INPUT_INVALID');
  }
  validateRunIdentity(input.runId, input.challenge);
  validateRelease(input.release);
  validateGeometry(input.geometry);
  validateProfile(input.profile);
  validateWindow(input.window);
  if (!isPlainObject(input.profile)
      || !ordinaryDenseArray(input.scenarioEvents)
      || !ordinaryDenseArray(input.transportEvents)) {
    fail('PHASE5_FAULT_BUILD_INPUT_INVALID');
  }
  if (input.transportEvents.length === 0) {
    fail('PHASE5_FAULT_TRANSPORT_COUNT_INVALID');
  }

  const privateKey = normalizedPrivateKey(keyPair?.privateKey);
  const publicKey = keyPair?.publicKey === undefined
    ? normalizedPublicKey(createPublicKey(privateKey))
    : normalizedPublicKey(keyPair.publicKey);
  const release = canonicalClone(input.release);

  let previousTransportSha256 = ZERO_EVENT_SHA256;
  const transportEvents = input.transportEvents.map((draft, index) => {
    if (!exactObjectKeys(draft, TRANSPORT_DRAFT_FIELDS)
        || !isPlainObject(draft.payload)) {
      fail('PHASE5_FAULT_TRANSPORT_DRAFT_INVALID');
    }
    const event = {
      sequence: index + 1,
      runId: input.runId,
      atMonotonicMs: draft.atMonotonicMs,
      atUnixMs: draft.atUnixMs,
      client: draft.client,
      type: draft.type,
      previousTransportSha256,
      payload: canonicalClone(draft.payload),
    };
    previousTransportSha256 = transportEventSha256(event);
    return event;
  });

  let previousEventSha256 = ZERO_EVENT_SHA256;
  const scenarioEvents = input.scenarioEvents.map((draft, index) => {
    if (!exactObjectKeys(draft, EVENT_DRAFT_FIELDS) || !isPlainObject(draft.payload)) {
      fail('PHASE5_FAULT_EVENT_DRAFT_INVALID');
    }
    if (!nonNegativeSafeInteger(draft.transportPrefixCount)
        || draft.transportPrefixCount > transportEvents.length) {
      fail('PHASE5_FAULT_TRANSPORT_PREFIX_INVALID');
    }
    const unsignedEvent = {
      sequence: index + 1,
      runId: input.runId,
      scenario: draft.scenario,
      phase: draft.phase,
      atMonotonicMs: draft.atMonotonicMs,
      atUnixMs: draft.atUnixMs,
      previousEventSha256,
      transportPrefixCount: draft.transportPrefixCount,
      transportPrefixSha256: draft.transportPrefixCount === 0
        ? ZERO_EVENT_SHA256
        : transportEventSha256(
          transportEvents[draft.transportPrefixCount - 1],
        ),
      payload: canonicalClone(draft.payload),
    };
    const signature = sign(null, faultEventSigningBytes({
      challenge: input.challenge,
      release,
      event: unsignedEvent,
    }), privateKey).toString('base64');
    const event = { ...unsignedEvent, signature };
    previousEventSha256 = faultEventSha256(event);
    return event;
  });
  const evidence = {
    schemaVersion: 2,
    kind: KIND,
    runId: input.runId,
    challenge: input.challenge,
    release,
    geometry: canonicalClone(input.geometry),
    profile: canonicalClone(input.profile),
    window: canonicalClone(input.window),
    signer: createEd25519SignerDescriptor(publicKey),
    scenarioEvents,
    transportEvents,
    eventChainSha256: previousEventSha256,
    transportChainSha256: previousTransportSha256,
    closure: {
      scenarioEventCount: scenarioEvents.length,
      transportEventCount: transportEvents.length,
      signature: '',
    },
  };
  evidence.closure.signature = sign(
    null,
    faultRunClosureSigningBytes(evidence),
    privateKey,
  ).toString('base64');
  validateSignedFaultEventEvidence(evidence, { expectedPublicKey: publicKey });
  return evidence;
}
