import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { types } from 'node:util';

import {
  canonicalPhase5CaptureJson,
  copyPhase5CaptureBytes,
  createPhase5CaptureSignerDescriptor,
} from '../capture/capture-wire.js';
import {
  captureProofSigningBytes,
  validatePhase5CaptureProof,
} from '../capture/phase5-capture-proof.js';

const IDENTITY_FIELDS = Object.freeze([
  'runId',
  'challenge',
  'release',
  'geometry',
  'profile',
]);
const OPTION_FIELDS = Object.freeze([
  'identity',
  'captureNonceBytes',
]);
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE_BYTES = 32;
const ZERO_SHA256 = '0'.repeat(64);
const FAULT_EVENT_DOMAIN = Buffer.from(
  'flock-phase5-fault-event-v1\0',
  'utf8',
);
const FAULT_CLOSURE_DOMAIN = Buffer.from(
  'flock-phase5-run-closure-v1\0',
  'utf8',
);
const TRANSPORT_TYPES = new Set([
  'runtime.open', 'runtime.ready', 'runtime.snapshot', 'runtime.close',
  'runtime.egress', 'audio.open', 'audio.ready', 'audio.pcm',
  'audio.discontinuity', 'audio.pause', 'audio.resume', 'audio.close',
  'worker.sample', 'agent.start', 'agent.settle', 'observer.failure',
]);
const TRANSPORT_DRAFT_FIELDS = Object.freeze([
  'atMonotonicMs', 'atUnixMs', 'client', 'type', 'payload',
]);
const WINDOW_FIELDS = Object.freeze([
  'startedAtMonotonicMs', 'endedAtMonotonicMs',
  'startedAtUnixMs', 'endedAtUnixMs',
]);
const BRIDGE_FIELDS = Object.freeze([
  'flushTransportObservations',
  'payloadFor',
  'commitSignedAction',
  'dispatchFixedInstruction',
]);
const PHASE_DRAFT_FIELDS = Object.freeze([
  'atMonotonicMs', 'atUnixMs', 'payload',
]);
const PHASES = Object.freeze([
  'before',
  'fault-action',
  'fault-observed',
  'recovery-action',
  'recovery-observed',
]);
const SCENARIOS = Object.freeze([
  'worker-crash-restart',
  'runtime-reconnect',
  'slow-client',
  'queue-pressure',
  'agent-timeout',
  'agent-malformed-response',
  'audio-epoch-discontinuity',
]);
const ACTION_CONTRACTS = Object.freeze([
  Object.freeze(['signal-worker', 'candidate-audio-worker']),
  Object.freeze(['await-supervisor-ready', 'candidate-audio-supervisor']),
  Object.freeze(['disconnect-runtime', 'runtime-client-4']),
  Object.freeze(['reconnect-runtime', 'runtime-client-4']),
  Object.freeze(['pause-audio', 'audio-client-4']),
  Object.freeze(['resume-audio', 'audio-client-4']),
  Object.freeze(['saturate-egress', 'egress-client-4']),
  Object.freeze(['reconnect-egress', 'egress-client-4']),
  Object.freeze(['inject-provider-timeout', 'bird_agent']),
  Object.freeze(['clear-provider-timeout', 'bird_agent']),
  Object.freeze(['inject-provider-malformed-response', 'bird_agent']),
  Object.freeze(['clear-provider-malformed-response', 'bird_agent']),
  Object.freeze(['rotate-audio-epoch', 'candidate-audio-worker']),
  Object.freeze(['settle-audio-epoch', 'all-audio-clients']),
]);

let actionSequence = 0;
export const PHASE5_FAULT_SESSION_PLAN = Object.freeze(
  SCENARIOS.flatMap((scenario) => PHASES.map((phase) => {
    const isAction = phase === 'fault-action' || phase === 'recovery-action';
    const sequence = isAction ? (actionSequence += 1) : null;
    const contract = sequence === null ? null : ACTION_CONTRACTS[sequence - 1];
    return Object.freeze({
      scenario,
      phase,
      actionSequence: sequence,
      operation: contract?.[0] ?? null,
      target: contract?.[1] ?? null,
    });
  })),
);

function fail(code) {
  throw new Phase5FaultSessionAuthorityError(code);
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

function dataPropertyValue(value, key) {
  return Object.getOwnPropertyDescriptor(value, key).value;
}

function ownedJson(value) {
  return JSON.parse(canonicalPhase5CaptureJson(value));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function ordinaryDenseArray(value) {
  if (!Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    return false;
  }
  return value.every((_, index) => enumerableDataProperty(value, String(index)))
    && keys.every((key) => key === 'length'
      || (typeof key === 'string'
        && /^(?:0|[1-9][0-9]*)$/u.test(key)
        && Number(key) < value.length));
}

function finiteNonNegative(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0;
}

function exactFrozenBridge(value) {
  return exactPlainDataObject(value, BRIDGE_FIELDS)
    && Object.isFrozen(value)
    && BRIDGE_FIELDS.every((field) => (
      typeof dataPropertyValue(value, field) === 'function'
      && !types.isProxy(dataPropertyValue(value, field))
    ));
}

function validatedWindow(value) {
  if (!exactPlainDataObject(value, WINDOW_FIELDS)) {
    fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
  }
  const window = ownedJson(value);
  if (!finiteNonNegative(window.startedAtMonotonicMs)
      || !finiteNonNegative(window.endedAtMonotonicMs)
      || !finiteNonNegative(window.startedAtUnixMs)
      || !finiteNonNegative(window.endedAtUnixMs)
      || window.endedAtMonotonicMs - window.startedAtMonotonicMs
        !== 1_800_000
      || window.endedAtUnixMs - window.startedAtUnixMs !== 1_800_000) {
    fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
  }
  return window;
}

function signingBytes(domain, value) {
  return Buffer.concat([
    domain,
    Buffer.from(canonicalPhase5CaptureJson(value), 'utf8'),
  ]);
}

function eventSha256(value) {
  return sha256(Buffer.from(canonicalPhase5CaptureJson(value), 'utf8'));
}

function createKeyContext(identityInput, captureNonceBytes) {
  const generated = generateKeyPairSync('ed25519');
  const privateKey = generated.privateKey;
  if (privateKey.asymmetricKeyType !== 'ed25519'
      || generated.publicKey.asymmetricKeyType !== 'ed25519'
      || !createPublicKey(privateKey).equals(generated.publicKey)) {
    fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
  }
  const signer = createPhase5CaptureSignerDescriptor(generated.publicKey);
  const nonce = copyPhase5CaptureBytes(captureNonceBytes, NONCE_BYTES);
  if (nonce.byteLength !== NONCE_BYTES) {
    fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
  }
  const captureNonce = nonce.toString('hex');
  const identity = ownedIdentity(identityInput, signer, captureNonce);
  return { privateKey, signer, captureNonce, identity };
}

function ownedIdentity(identity, signer, captureNonce) {
  if (!exactPlainDataObject(identity, IDENTITY_FIELDS)) {
    fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
  }
  try {
    const provisional = {
      runId: dataPropertyValue(identity, 'runId'),
      challenge: dataPropertyValue(identity, 'challenge'),
      release: dataPropertyValue(identity, 'release'),
      geometry: dataPropertyValue(identity, 'geometry'),
      profile: dataPropertyValue(identity, 'profile'),
      signer,
      captureNonce,
      rawManifestSha256: '0'.repeat(64),
    };
    const signingBytes = captureProofSigningBytes(provisional);
    const parsed = JSON.parse(
      Buffer.from(signingBytes.subarray(
        Buffer.byteLength('flock-phase5-capture-proof-v1\0'),
      )).toString('utf8'),
    );
    return {
      runId: parsed.runId,
      challenge: parsed.challenge,
      release: parsed.release,
      geometry: parsed.geometry,
      profile: parsed.profile,
    };
  } catch {
    fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
  }
}

export class Phase5FaultSessionAuthorityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5FaultSessionAuthorityError';
    this.code = code;
  }
}

export function createPhase5FaultSessionAuthority(options = {}) {
  let privateKey = null;
  let signer;
  let captureNonce;
  let identity;
  try {
    if (arguments.length !== 1
        || !exactPlainDataObject(options, OPTION_FIELDS)) {
      fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
    }
    const generated = generateKeyPairSync('ed25519');
    privateKey = generated.privateKey;
    if (privateKey.asymmetricKeyType !== 'ed25519'
        || generated.publicKey.asymmetricKeyType !== 'ed25519'
        || !createPublicKey(privateKey).equals(generated.publicKey)) {
      fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
    }
    signer = createPhase5CaptureSignerDescriptor(generated.publicKey);
    const nonce = copyPhase5CaptureBytes(
      dataPropertyValue(options, 'captureNonceBytes'),
      NONCE_BYTES,
    );
    if (nonce.byteLength !== NONCE_BYTES) {
      fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
    }
    captureNonce = nonce.toString('hex');
    identity = ownedIdentity(
      dataPropertyValue(options, 'identity'),
      signer,
      captureNonce,
    );
  } catch (error) {
    privateKey = null;
    if (error instanceof Phase5FaultSessionAuthorityError) throw error;
    fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
  }

  const admission = Object.freeze({
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-admission',
    runId: identity.runId,
    challenge: identity.challenge,
    captureNonce,
    signerSpkiSha256: signer.publicKeySpkiSha256,
    trustedSignerSpkiDerBase64: signer.publicKeySpkiDerBase64,
  });
  let state = 'open';

  function getAdmission(...args) {
    if (args.length !== 0) {
      fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
    }
    return ownedJson(admission);
  }

  function appendTransportObservation(...args) {
    if (state !== 'open') {
      fail('PHASE5_FAULT_SESSION_ALREADY_TERMINAL');
    }
    if (args.length !== 1) {
      state = 'terminal';
      privateKey = null;
      fail('PHASE5_FAULT_SESSION_OBSERVATION_INVALID');
    }
    fail('PHASE5_FAULT_SESSION_OBSERVATION_NOT_WIRED');
  }

  function advance(...args) {
    if (state !== 'open') {
      fail('PHASE5_FAULT_SESSION_ALREADY_TERMINAL');
    }
    if (args.length !== 0) {
      state = 'terminal';
      privateKey = null;
      fail('PHASE5_FAULT_SESSION_ADVANCE_INVALID');
    }
    fail('PHASE5_FAULT_SESSION_ADVANCE_NOT_WIRED');
  }

  function closeFaultWindow(...args) {
    if (args.length !== 0 || state !== 'open') {
      fail('PHASE5_FAULT_SESSION_CLOSE_INVALID');
    }
    fail('PHASE5_FAULT_SESSION_CLOSE_NOT_WIRED');
  }

  function finalizeCapture(...args) {
    if (state !== 'open') fail('PHASE5_FAULT_SESSION_ALREADY_USED');
    state = 'terminal';
    privateKey = null;
    if (args.length !== 1
        || typeof args[0] !== 'string'
        || !HEX64.test(args[0])) {
      fail('PHASE5_FAULT_SESSION_MANIFEST_INVALID');
    }
    fail('PHASE5_FAULT_SESSION_CAPTURE_BEFORE_CLOSURE');
  }

  return Object.freeze({
    getAdmission,
    appendTransportObservation,
    advance,
    closeFaultWindow,
    finalizeCapture,
  });
}

export function _createPhase5FaultSessionAuthority(options) {
  let keyContext;
  let window;
  let bridge;
  try {
    if (arguments.length !== 1 || !exactPlainDataObject(options, [
      'identity', 'captureNonceBytes', 'window', 'bridge',
    ])) {
      fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
    }
    keyContext = createKeyContext(
      dataPropertyValue(options, 'identity'),
      dataPropertyValue(options, 'captureNonceBytes'),
    );
    window = validatedWindow(dataPropertyValue(options, 'window'));
    bridge = dataPropertyValue(options, 'bridge');
    if (!exactFrozenBridge(bridge)) {
      fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
    }
  } catch (error) {
    if (keyContext) keyContext.privateKey = null;
    if (error instanceof Phase5FaultSessionAuthorityError) throw error;
    fail('PHASE5_FAULT_SESSION_INPUT_INVALID');
  }

  const { identity, signer, captureNonce } = keyContext;
  const admission = Object.freeze({
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-admission',
    runId: identity.runId,
    challenge: identity.challenge,
    captureNonce,
    signerSpkiSha256: signer.publicKeySpkiSha256,
    trustedSignerSpkiDerBase64: signer.publicKeySpkiDerBase64,
  });
  const scenarioEvents = [];
  const transportEvents = [];
  let previousEventSha256 = ZERO_SHA256;
  let previousTransportSha256 = ZERO_SHA256;
  let phaseCursor = 0;
  let state = 'open';
  let busy = false;
  let evidenceBytes = null;

  function terminate(code) {
    state = 'terminal';
    keyContext.privateKey = null;
    fail(code);
  }

  function getAdmission(...args) {
    if (args.length !== 0) {
      terminate('PHASE5_FAULT_SESSION_INPUT_INVALID');
    }
    return ownedJson(admission);
  }

  function appendTransportObservation(...args) {
    if (state !== 'open') {
      fail('PHASE5_FAULT_SESSION_ALREADY_TERMINAL');
    }
    if (args.length !== 1
        || !exactPlainDataObject(args[0], TRANSPORT_DRAFT_FIELDS)) {
      terminate('PHASE5_FAULT_SESSION_OBSERVATION_INVALID');
    }
    const draft = ownedJson(args[0]);
    const clientType = draft.type.startsWith('runtime.')
      || draft.type.startsWith('audio.');
    if (!finiteNonNegative(draft.atMonotonicMs)
        || !finiteNonNegative(draft.atUnixMs)
        || !nonNegativeSafeInteger(draft.client)
        || !TRANSPORT_TYPES.has(draft.type)
        || !exactPlainDataObject(draft.payload, Reflect.ownKeys(draft.payload))
        || (clientType && (draft.client < 1 || draft.client > 4))
        || (!clientType && draft.client !== 0)
        || draft.atMonotonicMs < window.startedAtMonotonicMs
        || draft.atMonotonicMs > window.endedAtMonotonicMs
        || draft.atUnixMs < window.startedAtUnixMs
        || draft.atUnixMs > window.endedAtUnixMs) {
      terminate('PHASE5_FAULT_SESSION_OBSERVATION_INVALID');
    }
    const previousScenario = scenarioEvents.at(-1);
    if (previousScenario
        && (draft.atMonotonicMs <= previousScenario.atMonotonicMs
          || draft.atUnixMs <= previousScenario.atUnixMs)) {
      terminate('PHASE5_FAULT_SESSION_TRANSPORT_BACKFILL');
    }
    const previousTransport = transportEvents.at(-1);
    if (previousTransport
        && (draft.atMonotonicMs < previousTransport.atMonotonicMs
          || draft.atUnixMs < previousTransport.atUnixMs)) {
      terminate('PHASE5_FAULT_SESSION_OBSERVATION_INVALID');
    }
    const event = {
      sequence: transportEvents.length + 1,
      runId: identity.runId,
      atMonotonicMs: draft.atMonotonicMs,
      atUnixMs: draft.atUnixMs,
      client: draft.client,
      type: draft.type,
      previousTransportSha256,
      payload: draft.payload,
    };
    previousTransportSha256 = eventSha256(event);
    transportEvents.push(event);
    return Object.freeze(ownedJson(event));
  }

  function advance(...args) {
    if (state !== 'open') {
      fail('PHASE5_FAULT_SESSION_ALREADY_TERMINAL');
    }
    if (args.length !== 0) {
      terminate('PHASE5_FAULT_SESSION_ADVANCE_INVALID');
    }
    if (busy) terminate('PHASE5_FAULT_SESSION_ADVANCE_CONCURRENT');
    if (phaseCursor >= PHASE5_FAULT_SESSION_PLAN.length) {
      terminate('PHASE5_FAULT_SESSION_PLAN_COMPLETE');
    }
    busy = true;
    try {
      const plan = PHASE5_FAULT_SESSION_PLAN[phaseCursor];
      const flushed = Reflect.apply(
        bridge.flushTransportObservations,
        bridge,
        [],
      );
      if (!ordinaryDenseArray(flushed)) {
        terminate('PHASE5_FAULT_SESSION_TRANSPORT_FLUSH_INVALID');
      }
      for (const observation of flushed) {
        appendTransportObservation(observation);
      }
      const draftValue = Reflect.apply(bridge.payloadFor, bridge, [
        Object.freeze(ownedJson(plan)),
      ]);
      if (!exactPlainDataObject(draftValue, PHASE_DRAFT_FIELDS)) {
        terminate('PHASE5_FAULT_SESSION_PHASE_INVALID');
      }
      const draft = ownedJson(draftValue);
      if (!finiteNonNegative(draft.atMonotonicMs)
          || !finiteNonNegative(draft.atUnixMs)
          || draft.atMonotonicMs < window.startedAtMonotonicMs
          || draft.atMonotonicMs > window.endedAtMonotonicMs
          || draft.atUnixMs < window.startedAtUnixMs
          || draft.atUnixMs > window.endedAtUnixMs
          || !exactPlainDataObject(draft.payload, Reflect.ownKeys(draft.payload))) {
        terminate('PHASE5_FAULT_SESSION_PHASE_INVALID');
      }
      const previousScenario = scenarioEvents.at(-1);
      if (previousScenario
          && (draft.atMonotonicMs < previousScenario.atMonotonicMs
            || draft.atUnixMs < previousScenario.atUnixMs)) {
        terminate('PHASE5_FAULT_SESSION_PHASE_INVALID');
      }
      const nextTransport = transportEvents.find((event) => (
        event.sequence > transportEvents.length
      ));
      if (nextTransport
          && (nextTransport.atMonotonicMs <= draft.atMonotonicMs
            || nextTransport.atUnixMs <= draft.atUnixMs)) {
        terminate('PHASE5_FAULT_SESSION_TRANSPORT_PREFIX_INVALID');
      }
      if (plan.actionSequence === null) {
        if (!exactPlainDataObject(draft.payload, ['kind', 'state'])
            || draft.payload.kind !== 'state') {
          terminate('PHASE5_FAULT_SESSION_PHASE_INVALID');
        }
      } else if (!exactPlainDataObject(draft.payload, ['kind', 'action'])
          || draft.payload.kind !== 'action'
          || !exactPlainDataObject(
            draft.payload.action,
            ['operation', 'target', 'receipt'],
          )
          || draft.payload.action.operation !== plan.operation
          || draft.payload.action.target !== plan.target
          || !exactPlainDataObject(
            draft.payload.action.receipt,
            Reflect.ownKeys(draft.payload.action.receipt),
          )
          || draft.payload.action.receipt.actuatorSequence
            !== plan.actionSequence) {
        terminate('PHASE5_FAULT_SESSION_PHASE_INVALID');
      }
      const unsigned = {
        sequence: phaseCursor + 1,
        runId: identity.runId,
        scenario: plan.scenario,
        phase: plan.phase,
        atMonotonicMs: draft.atMonotonicMs,
        atUnixMs: draft.atUnixMs,
        previousEventSha256,
        transportPrefixCount: transportEvents.length,
        transportPrefixSha256: previousTransportSha256,
        payload: draft.payload,
      };
      const signature = sign(null, signingBytes(FAULT_EVENT_DOMAIN, {
        challenge: identity.challenge,
        release: identity.release,
        event: unsigned,
      }), keyContext.privateKey).toString('base64');
      const event = { ...unsigned, signature };
      const eventBytes = Buffer.from(
        canonicalPhase5CaptureJson(event),
        'utf8',
      );
      if (plan.actionSequence !== null) {
        Reflect.apply(bridge.commitSignedAction, bridge, [
          Buffer.from(eventBytes),
          plan.actionSequence,
        ]);
        Reflect.apply(bridge.dispatchFixedInstruction, bridge, [
          plan.actionSequence,
        ]);
      }
      previousEventSha256 = sha256(eventBytes);
      scenarioEvents.push(event);
      phaseCursor += 1;
      return Object.freeze(ownedJson(event));
    } catch (error) {
      if (error instanceof Phase5FaultSessionAuthorityError) throw error;
      terminate('PHASE5_FAULT_SESSION_PHASE_FAILED');
    } finally {
      busy = false;
    }
  }

  function closeFaultWindow(...args) {
    if (state !== 'open') {
      fail('PHASE5_FAULT_SESSION_ALREADY_TERMINAL');
    }
    if (args.length !== 0
        || phaseCursor !== PHASE5_FAULT_SESSION_PLAN.length
        || transportEvents.length === 0) {
      terminate('PHASE5_FAULT_SESSION_CLOSE_INVALID');
    }
    const tail = transportEvents.at(-1);
    if (window.endedAtMonotonicMs - tail.atMonotonicMs > 250
        || window.endedAtUnixMs - tail.atUnixMs > 250) {
      terminate('PHASE5_FAULT_SESSION_CLOSE_INVALID');
    }
    const evidence = {
      schemaVersion: 2,
      kind: 'isolated-equivalent-spark-fault-events',
      runId: identity.runId,
      challenge: identity.challenge,
      release: identity.release,
      geometry: identity.geometry,
      profile: identity.profile,
      window,
      signer,
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
    evidence.closure.signature = sign(null, signingBytes(
      FAULT_CLOSURE_DOMAIN,
      {
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
      },
    ), keyContext.privateKey).toString('base64');
    evidenceBytes = Buffer.from(
      canonicalPhase5CaptureJson(evidence),
      'utf8',
    );
    state = 'closed';
    return Buffer.from(evidenceBytes);
  }

  function finalizeCapture(...args) {
    if (state !== 'closed') {
      if (state === 'captured' || state === 'terminal') {
        fail('PHASE5_FAULT_SESSION_ALREADY_USED');
      }
      terminate('PHASE5_FAULT_SESSION_CAPTURE_BEFORE_CLOSURE');
    }
    state = 'captured';
    try {
      if (args.length !== 1
          || typeof args[0] !== 'string'
          || !HEX64.test(args[0])) {
        fail('PHASE5_FAULT_SESSION_MANIFEST_INVALID');
      }
      const rawManifestSha256 = args[0];
      const signingInput = {
        ...identity,
        signer,
        captureNonce,
        rawManifestSha256,
      };
      const signature = sign(
        null,
        captureProofSigningBytes(signingInput),
        keyContext.privateKey,
      ).toString('base64');
      const session = {
        schemaVersion: 2,
        kind: 'phase5-fault-session-attestation',
        ...identity,
        signer,
        captureProof: {
          captureNonce,
          rawManifestSha256,
          signature,
        },
      };
      const sessionBytes = Buffer.from(
        canonicalPhase5CaptureJson(session),
        'utf8',
      );
      const runBinding = {
        ...identity,
        signerSpkiSha256: signer.publicKeySpkiSha256,
        faultSessionEvidenceSha256: sha256(sessionBytes),
        captureNonce,
        rawManifestSha256,
      };
      return Object.freeze({
        faultEventsBytes: Buffer.from(evidenceBytes),
        sessionBytes,
        runBinding: ownedJson(runBinding),
        captureValidation: validatePhase5CaptureProof(
          session,
          runBinding,
          admission.trustedSignerSpkiDerBase64,
        ),
      });
    } finally {
      keyContext.privateKey = null;
    }
  }

  return Object.freeze({
    getAdmission,
    appendTransportObservation,
    advance,
    closeFaultWindow,
    finalizeCapture,
  });
}
