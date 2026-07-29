import { isDeepStrictEqual } from 'node:util';

import {
  transportEventSha256,
} from './phase5-fault-evidence.mjs';
import { validateFaultState } from './phase5-fault-semantics.mjs';

const TRANSPORT_FIELDS = Object.freeze([
  'sequence',
  'runId',
  'atMonotonicMs',
  'atUnixMs',
  'client',
  'type',
  'previousTransportSha256',
  'payload',
]);
const SCENARIO_EVENT_FIELDS = Object.freeze([
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
  'signature',
]);
const WINDOW_FIELDS = Object.freeze([
  'startedAtMonotonicMs',
  'endedAtMonotonicMs',
  'startedAtUnixMs',
  'endedAtUnixMs',
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
const PHASES = Object.freeze([
  'before',
  'fault-action',
  'fault-observed',
  'recovery-action',
  'recovery-observed',
]);
const STATE_PHASES = new Set([
  'before',
  'fault-observed',
  'recovery-observed',
]);
const CLIENT_TYPES = new Set([
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
]);
const GLOBAL_TYPES = new Set([
  'worker.sample',
  'agent.start',
  'agent.settle',
  'observer.failure',
]);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECIMAL_U64 = /^(?:0|[1-9][0-9]*)$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_U32 = 0xffff_ffff;
const SPECIES_ATTEMPT_TIMEOUT_MS = 12_000;
const SPECIES_DEADLINE_MS = 15_000;
const FINAL_STABILITY_WINDOW_MS = 30_000;
const TAIL_MAX_OBSERVATION_GAP_MS = 250;

const PAYLOAD_FIELDS = Object.freeze({
  'runtime.open': Object.freeze([
    'generation',
    'mode',
    'clientIdentitySha256',
  ]),
  'runtime.ready': Object.freeze([
    'generation',
    'worldGeneration',
    'revision',
    'eventSeq',
  ]),
  'runtime.snapshot': Object.freeze([
    'generation',
    'worldGeneration',
    'revision',
    'eventSeq',
    'probeSeq',
  ]),
  'runtime.close': Object.freeze(['generation', 'code', 'reason']),
  'runtime.egress': Object.freeze([
    'generation',
    'capacityEntries',
    'queuedEntries',
    'inFlight',
    'closed',
    'closeCode',
    'closeReason',
  ]),
  'audio.open': Object.freeze(['generation']),
  'audio.ready': Object.freeze([
    'generation',
    'audioEpoch',
    'streamRevision',
    'blockSeq',
    'resumeStartFrame',
  ]),
  'audio.pcm': Object.freeze([
    'generation',
    'audioEpoch',
    'streamRevision',
    'blockSeq',
    'startFrame',
    'frameCount',
  ]),
  'audio.discontinuity': Object.freeze([
    'generation',
    'audioEpoch',
    'streamRevision',
    'blockSeq',
    'resumeStartFrame',
    'scope',
  ]),
  'audio.pause': Object.freeze(['generation']),
  'audio.resume': Object.freeze(['generation']),
  'audio.close': Object.freeze(['generation', 'code', 'reason']),
  'worker.sample': Object.freeze([
    'pid',
    'ready',
    'recovering',
    'restartCount',
    'audioEpoch',
    'supervisorGeneration',
    'lastExitedPid',
    'lastExitSignal',
  ]),
  'agent.start': Object.freeze([
    'requestId',
    'source',
    'model',
    'attempts',
    'startedAtMonotonicMs',
  ]),
  'agent.settle': Object.freeze([
    'requestId',
    'source',
    'model',
    'status',
    'reason',
    'attempts',
    'startedAtMonotonicMs',
    'settledAtMonotonicMs',
    'httpStatus',
  ]),
  'observer.failure': Object.freeze(['component', 'code', 'message']),
});

function fail(code) {
  throw new Error(code);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function enumerableDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
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

function ordinaryDenseArray(value, expectedLength) {
  if (!Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || (expectedLength !== undefined && value.length !== expectedLength)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!enumerableDataProperty(value, String(index))) return false;
  }
  return keys.every((key) => (
    key === 'length'
      || (typeof key === 'string'
        && /^(?:0|[1-9][0-9]*)$/.test(key)
        && Number(key) < value.length)
  ));
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function positiveU32(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_U32;
}

function nonNegativeU32(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_U32;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function sameNullableExit(left, right) {
  return left.lastExitedPid === right.lastExitedPid
    && left.lastExitSignal === right.lastExitSignal;
}

function parseSafeFrame(value) {
  if (typeof value !== 'string' || !DECIMAL_U64.test(value)) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE_BIGINT) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  return parsed;
}

function machineState() {
  return {
    world: null,
    runtime: new Array(4),
    audio: new Array(4),
    worker: null,
    egress: new Array(4),
    provider: { lastResult: null },
    pendingAgent: null,
    seenRequestIds: new Set(),
  };
}

function requirePayload(type, payload) {
  if (!exactObjectKeys(payload, PAYLOAD_FIELDS[type])) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
}

function requireClientGeneration(event, current) {
  if (!positiveSafeInteger(event.payload.generation)
      || current === undefined
      || event.payload.generation !== current.generation) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
}

function updateWorld(machine, payload) {
  if (!nonEmptyString(payload.worldGeneration)
      || !nonNegativeSafeInteger(payload.revision)
      || !nonNegativeSafeInteger(payload.eventSeq)) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  if (machine.world !== null
      && (payload.worldGeneration !== machine.world.worldGeneration
        || payload.revision < machine.world.revision
        || payload.eventSeq < machine.world.eventSeq)) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  machine.world = {
    worldGeneration: payload.worldGeneration,
    revision: payload.revision,
    eventSeq: payload.eventSeq,
  };
}

function applyRuntimeOpen(machine, event) {
  const payload = event.payload;
  if (!positiveSafeInteger(payload.generation)
      || !['bootstrap', 'resume'].includes(payload.mode)
      || typeof payload.clientIdentitySha256 !== 'string'
      || !HEX64.test(payload.clientIdentitySha256)) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  const index = event.client - 1;
  const previous = machine.runtime[index];
  if (previous === undefined) {
    if (payload.generation !== 1 || payload.mode !== 'bootstrap') {
      fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
    }
  } else if (previous.open
      || payload.generation !== previous.generation + 1
      || payload.mode !== 'resume'
      || payload.clientIdentitySha256 !== previous.clientIdentitySha256) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  machine.runtime[index] = {
    generation: payload.generation,
    clientIdentitySha256: payload.clientIdentitySha256,
    open: true,
    ready: false,
    snapshotWorldGeneration: null,
    probeSeq: previous?.probeSeq ?? 0,
  };
}

function applyRuntimeReady(machine, event) {
  const current = machine.runtime[event.client - 1];
  requireClientGeneration(event, current);
  if (!current.open || current.ready) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  updateWorld(machine, event.payload);
  current.ready = true;
}

function applyRuntimeSnapshot(machine, event) {
  const payload = event.payload;
  const current = machine.runtime[event.client - 1];
  requireClientGeneration(event, current);
  if (!current.open
      || !current.ready
      || !positiveSafeInteger(payload.probeSeq)
      || payload.probeSeq !== current.probeSeq + 1) {
    if (!positiveSafeInteger(payload.probeSeq)) {
      fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
    }
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  updateWorld(machine, payload);
  current.snapshotWorldGeneration = payload.worldGeneration;
  current.probeSeq = payload.probeSeq;
}

function validRuntimeClose(code, reason) {
  return (code === 1_000 && reason === 'PHASE5_RUNTIME_RECONNECT')
    || (code === 4_410 && reason === 'EGRESS_OVERFLOW');
}

function applyRuntimeClose(machine, event) {
  const payload = event.payload;
  const current = machine.runtime[event.client - 1];
  if (!positiveSafeInteger(payload.generation)
      || !positiveSafeInteger(payload.code)
      || !nonEmptyString(payload.reason)
      || !validRuntimeClose(payload.code, payload.reason)) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  requireClientGeneration(event, current);
  if (!current.open) fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  current.open = false;
  current.ready = false;
  current.snapshotWorldGeneration = null;
}

function applyRuntimeEgress(machine, event) {
  const payload = event.payload;
  if (!positiveSafeInteger(payload.generation)
      || payload.capacityEntries !== 256
      || !nonNegativeSafeInteger(payload.queuedEntries)
      || !nonNegativeSafeInteger(payload.inFlight)
      || payload.queuedEntries + payload.inFlight > payload.capacityEntries
      || typeof payload.closed !== 'boolean'
      || (payload.closeCode !== null && !positiveSafeInteger(payload.closeCode))
      || (payload.closeReason !== null && !nonEmptyString(payload.closeReason))) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  if (payload.closed) {
    const overflowClose = payload.queuedEntries === 256
      && payload.inFlight === 0
      && payload.closeCode === 4_410
      && payload.closeReason === 'EGRESS_OVERFLOW';
    const requestedReconnectClose = payload.queuedEntries === 0
      && payload.inFlight === 0
      && payload.closeCode === 1_000
      && payload.closeReason === 'PHASE5_RUNTIME_RECONNECT';
    if (!overflowClose && !requestedReconnectClose) {
      fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
    }
  } else if (payload.closeCode !== null || payload.closeReason !== null) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }

  const index = event.client - 1;
  const previous = machine.egress[index];
  if (previous === undefined) {
    if (payload.generation !== 1 || payload.closed) {
      fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
    }
  } else if (payload.generation === previous.generation) {
    if (previous.closed) fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  } else if (payload.generation === previous.generation + 1) {
    if (!previous.closed
        || payload.closed
        || payload.queuedEntries !== 0
        || payload.inFlight !== 0) {
      fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
    }
  } else {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  machine.egress[index] = {
    generation: payload.generation,
    queuedEntries: payload.queuedEntries,
    capacityEntries: payload.capacityEntries,
    inFlight: payload.inFlight,
    closed: payload.closed,
    closeCode: payload.closeCode,
    closeReason: payload.closeReason,
  };
}

function applyAudioOpen(machine, event) {
  const payload = event.payload;
  if (!positiveU32(payload.generation)) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  const index = event.client - 1;
  const previous = machine.audio[index];
  if (previous === undefined) {
    if (payload.generation !== 1) {
      fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
    }
  } else if (previous.open || payload.generation !== previous.generation + 1) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  machine.audio[index] = {
    generation: payload.generation,
    open: true,
    ready: false,
    audioEpoch: previous?.audioEpoch ?? null,
    streamRevision: previous?.streamRevision ?? null,
    expectedBlockSeq: previous?.expectedBlockSeq ?? null,
    cursor: previous?.cursor ?? 0n,
    discontinuityCount: previous?.discontinuityCount ?? 0,
    paused: false,
  };
}

function validateAudioCursorPayload(payload) {
  if (!positiveU32(payload.generation)
      || !nonEmptyString(payload.audioEpoch)
      || !positiveU32(payload.streamRevision)
      || !nonNegativeU32(payload.blockSeq)) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
}

function applyAudioReady(machine, event) {
  const payload = event.payload;
  validateAudioCursorPayload(payload);
  const current = machine.audio[event.client - 1];
  requireClientGeneration(event, current);
  if (!current.open || current.ready) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  const resumeStartFrame = parseSafeFrame(payload.resumeStartFrame);
  if (current.audioEpoch !== null
      && (payload.audioEpoch !== current.audioEpoch
        || payload.streamRevision !== current.streamRevision
        || payload.blockSeq !== current.expectedBlockSeq
        || resumeStartFrame !== current.cursor)) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  current.ready = true;
  current.audioEpoch = payload.audioEpoch;
  current.streamRevision = payload.streamRevision;
  current.expectedBlockSeq = payload.blockSeq;
  current.cursor = resumeStartFrame;
}

function applyAudioPcm(machine, event) {
  const payload = event.payload;
  validateAudioCursorPayload(payload);
  if (payload.frameCount !== 4_096) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  const current = machine.audio[event.client - 1];
  requireClientGeneration(event, current);
  const startFrame = parseSafeFrame(payload.startFrame);
  if (!current.open
      || !current.ready
      || current.paused
      || payload.audioEpoch !== current.audioEpoch
      || payload.streamRevision !== current.streamRevision
      || payload.blockSeq !== current.expectedBlockSeq
      || startFrame !== current.cursor
      || startFrame + 4_096n > MAX_SAFE_BIGINT) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  current.expectedBlockSeq += 1;
  current.cursor += 4_096n;
}

function applyAudioDiscontinuity(machine, event) {
  const payload = event.payload;
  validateAudioCursorPayload(payload);
  if (!['client', 'stream'].includes(payload.scope)) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  const current = machine.audio[event.client - 1];
  requireClientGeneration(event, current);
  if (!current.open || !current.ready) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  const resumeStartFrame = parseSafeFrame(payload.resumeStartFrame);
  if (payload.scope === 'client') {
    if (payload.audioEpoch !== current.audioEpoch
        || payload.streamRevision !== current.streamRevision
        || payload.blockSeq < current.expectedBlockSeq
        || resumeStartFrame < current.cursor) {
      fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
    }
  } else if (payload.streamRevision !== current.streamRevision + 1
      || (payload.audioEpoch !== current.audioEpoch
        && (payload.blockSeq !== 0 || resumeStartFrame !== 0n))) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  current.audioEpoch = payload.audioEpoch;
  current.streamRevision = payload.streamRevision;
  current.expectedBlockSeq = payload.blockSeq;
  current.cursor = resumeStartFrame;
  current.discontinuityCount += 1;
}

function applyAudioPause(machine, event, paused) {
  const payload = event.payload;
  if (!positiveU32(payload.generation)) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  const current = machine.audio[event.client - 1];
  requireClientGeneration(event, current);
  if (!current.open || !current.ready || current.paused === paused) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  current.paused = paused;
}

function applyAudioClose(machine, event) {
  const payload = event.payload;
  if (!positiveU32(payload.generation)
      || payload.code !== 1_000
      || payload.reason !== 'PHASE5_AUDIO_RECONNECT') {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  const current = machine.audio[event.client - 1];
  requireClientGeneration(event, current);
  if (!current.open) fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  current.open = false;
  current.ready = false;
  current.paused = false;
}

function validWorkerPayload(payload) {
  const exitPairValid = (
    payload.lastExitedPid === null && payload.lastExitSignal === null
  ) || (
    positiveSafeInteger(payload.lastExitedPid)
      && payload.lastExitSignal === 'SIGKILL'
  );
  return typeof payload.ready === 'boolean'
    && typeof payload.recovering === 'boolean'
    && payload.ready !== payload.recovering
    && (payload.ready ? positiveSafeInteger(payload.pid) : payload.pid === null)
    && nonNegativeSafeInteger(payload.restartCount)
    && nonEmptyString(payload.audioEpoch)
    && positiveSafeInteger(payload.supervisorGeneration)
    && exitPairValid;
}

function applyWorkerSample(machine, event) {
  const next = event.payload;
  if (!validWorkerPayload(next)) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  const previous = machine.worker;
  if (previous === null) {
    if (!next.ready
        || next.restartCount !== 0
        || next.lastExitedPid !== null
        || next.supervisorGeneration !== 1) {
      fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
    }
  } else if (previous.ready && !next.ready) {
    if (next.restartCount !== previous.restartCount
        || next.audioEpoch !== previous.audioEpoch
        || next.supervisorGeneration !== previous.supervisorGeneration + 1
        || next.lastExitedPid !== previous.pid
        || next.lastExitSignal !== 'SIGKILL') {
      fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
    }
  } else if (!previous.ready && next.ready) {
    if (next.pid === previous.lastExitedPid
        || next.restartCount !== previous.restartCount + 1
        || next.audioEpoch === previous.audioEpoch
        || next.supervisorGeneration !== previous.supervisorGeneration
        || !sameNullableExit(next, previous)) {
      fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
    }
  } else if (previous.ready && next.ready) {
    if (next.pid !== previous.pid
        || next.restartCount !== previous.restartCount
        || !sameNullableExit(next, previous)
        || next.supervisorGeneration !== previous.supervisorGeneration) {
      fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
    }
  } else if (next.pid !== previous.pid
      || next.restartCount !== previous.restartCount
      || next.audioEpoch !== previous.audioEpoch
      || next.supervisorGeneration !== previous.supervisorGeneration
      || !sameNullableExit(next, previous)) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  machine.worker = { ...next };
}

function validAgentBase(payload) {
  return typeof payload.requestId === 'string'
    && REQUEST_ID.test(payload.requestId)
    && ['injected', 'real'].includes(payload.source)
    && payload.model === 'bird_agent'
    && payload.attempts === 1
    && nonNegativeSafeInteger(payload.startedAtMonotonicMs);
}

function applyAgentStart(machine, event) {
  const payload = event.payload;
  if (!validAgentBase(payload)
      || payload.startedAtMonotonicMs !== event.atMonotonicMs) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  if (machine.pendingAgent !== null
      || machine.seenRequestIds.has(payload.requestId)) {
    fail('PHASE5_FAULT_TRANSPORT_AGENT_REQUEST_INVALID');
  }
  machine.seenRequestIds.add(payload.requestId);
  machine.pendingAgent = { ...payload };
}

function validAgentResult(payload) {
  if (!validAgentBase(payload)
      || !nonNegativeSafeInteger(payload.settledAtMonotonicMs)
      || payload.settledAtMonotonicMs < payload.startedAtMonotonicMs
      || !['timeout', 'invalid_output', 'ok'].includes(payload.status)) {
    return false;
  }
  if (payload.status === 'timeout') {
    return payload.source === 'injected'
      && payload.reason === 'ATTEMPT_TIMEOUT'
      && payload.httpStatus === null
      && payload.settledAtMonotonicMs - payload.startedAtMonotonicMs
        >= SPECIES_ATTEMPT_TIMEOUT_MS;
  }
  if (payload.status === 'invalid_output') {
    return payload.source === 'injected'
      && payload.reason === 'INVALID_OUTPUT'
      && payload.httpStatus === 200;
  }
  return payload.source === 'real'
    && payload.reason === null
    && payload.httpStatus === 200
    && payload.settledAtMonotonicMs - payload.startedAtMonotonicMs
      <= SPECIES_DEADLINE_MS;
}

function applyAgentSettle(machine, event) {
  const payload = event.payload;
  if (!validAgentResult(payload)
      || payload.settledAtMonotonicMs !== event.atMonotonicMs) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  const pending = machine.pendingAgent;
  if (pending === null
      || pending.requestId !== payload.requestId
      || pending.source !== payload.source
      || pending.model !== payload.model
      || pending.attempts !== payload.attempts
      || pending.startedAtMonotonicMs !== payload.startedAtMonotonicMs) {
    fail('PHASE5_FAULT_TRANSPORT_AGENT_REQUEST_INVALID');
  }
  machine.pendingAgent = null;
  machine.provider.lastResult = { ...payload };
}

function applyObserverFailure(event) {
  const { component, code, message } = event.payload;
  if (!['runtime', 'audio', 'worker', 'agent'].includes(component)
      || !nonEmptyString(code)
      || !nonEmptyString(message)) {
    fail('PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID');
  }
  fail('PHASE5_FAULT_OBSERVER_FAILURE_RECORDED');
}

function applyEvent(machine, event) {
  requirePayload(event.type, event.payload);
  if (event.type === 'runtime.open') applyRuntimeOpen(machine, event);
  else if (event.type === 'runtime.ready') applyRuntimeReady(machine, event);
  else if (event.type === 'runtime.snapshot') {
    applyRuntimeSnapshot(machine, event);
  } else if (event.type === 'runtime.close') applyRuntimeClose(machine, event);
  else if (event.type === 'runtime.egress') {
    applyRuntimeEgress(machine, event);
  } else if (event.type === 'audio.open') applyAudioOpen(machine, event);
  else if (event.type === 'audio.ready') applyAudioReady(machine, event);
  else if (event.type === 'audio.pcm') applyAudioPcm(machine, event);
  else if (event.type === 'audio.discontinuity') {
    applyAudioDiscontinuity(machine, event);
  } else if (event.type === 'audio.pause') {
    applyAudioPause(machine, event, true);
  } else if (event.type === 'audio.resume') {
    applyAudioPause(machine, event, false);
  } else if (event.type === 'audio.close') applyAudioClose(machine, event);
  else if (event.type === 'worker.sample') applyWorkerSample(machine, event);
  else if (event.type === 'agent.start') applyAgentStart(machine, event);
  else if (event.type === 'agent.settle') applyAgentSettle(machine, event);
  else applyObserverFailure(event);
}

function validateTransportEnvelope(event, index, runId, previousEvent) {
  if (!exactObjectKeys(event, TRANSPORT_FIELDS)
      || event.sequence !== index + 1
      || event.runId !== runId
      || !nonNegativeSafeInteger(event.atMonotonicMs)
      || !positiveSafeInteger(event.atUnixMs)
      || typeof event.type !== 'string'
      || (!CLIENT_TYPES.has(event.type) && !GLOBAL_TYPES.has(event.type))
      || !nonNegativeSafeInteger(event.client)
      || (CLIENT_TYPES.has(event.type)
        && (event.client < 1 || event.client > 4))
      || (GLOBAL_TYPES.has(event.type) && event.client !== 0)
      || typeof event.previousTransportSha256 !== 'string'
      || !HEX64.test(event.previousTransportSha256)
      || !isPlainObject(event.payload)
      || (previousEvent !== null
        && (event.atMonotonicMs < previousEvent.atMonotonicMs
          || event.atUnixMs < previousEvent.atUnixMs))) {
    fail('PHASE5_FAULT_TRANSPORT_ENVELOPE_INVALID');
  }
}

function replay(transportEvents, prefixCount) {
  const machine = machineState();
  for (let index = 0; index < prefixCount; index += 1) {
    applyEvent(machine, transportEvents[index]);
  }
  return machine;
}

function validateStabilityTail(evidence) {
  const finalScenarioEvent = evidence.scenarioEvents.at(-1);
  const prefixCount = finalScenarioEvent.transportPrefixCount;
  const tail = evidence.transportEvents.slice(prefixCount);
  if (tail.length === 0) {
    fail('PHASE5_FAULT_STABILITY_TAIL_INCOMPLETE');
  }

  const machine = replay(evidence.transportEvents, prefixCount);
  const start = replay(evidence.transportEvents, prefixCount);
  if (machine.pendingAgent !== null
      || machine.runtime.some((client) => !client.open || !client.ready)
      || machine.audio.some((client) => (
        !client.open || !client.ready || client.paused
      ))
      || machine.egress.some((entry) => entry.closed)
      || machine.worker === null
      || !machine.worker.ready
      || machine.worker.recovering) {
    fail('PHASE5_FAULT_STABILITY_TAIL_BASELINE_INVALID');
  }

  const audioCounts = [0, 0, 0, 0];
  const lastAudioMonotonic = new Array(4)
    .fill(finalScenarioEvent.atMonotonicMs);
  const lastAudioUnix = new Array(4).fill(finalScenarioEvent.atUnixMs);
  const runtimeSnapshotCounts = [0, 0, 0, 0];
  const lastRuntimeMonotonic = new Array(4)
    .fill(finalScenarioEvent.atMonotonicMs);
  const lastRuntimeUnix = new Array(4).fill(finalScenarioEvent.atUnixMs);
  let workerSamples = 0;
  let lastWorkerMonotonic = finalScenarioEvent.atMonotonicMs;
  let lastWorkerUnix = finalScenarioEvent.atUnixMs;
  for (const event of tail) {
    if (![
      'runtime.snapshot',
      'runtime.egress',
      'audio.pcm',
      'worker.sample',
      'agent.start',
      'agent.settle',
    ].includes(event.type)) {
      fail('PHASE5_FAULT_STABILITY_TAIL_UNEXPECTED_EFFECT');
    }
    if (event.type === 'runtime.snapshot') {
      const index = event.client - 1;
      if (event.atMonotonicMs - lastRuntimeMonotonic[index]
            > TAIL_MAX_OBSERVATION_GAP_MS
          || event.atUnixMs - lastRuntimeUnix[index]
            > TAIL_MAX_OBSERVATION_GAP_MS) {
        fail('PHASE5_FAULT_STABILITY_TAIL_OBSERVATION_GAP');
      }
      runtimeSnapshotCounts[index] += 1;
      lastRuntimeMonotonic[index] = event.atMonotonicMs;
      lastRuntimeUnix[index] = event.atUnixMs;
    } else if (event.type === 'runtime.egress') {
      const baseline = start.egress[event.client - 1];
      if (event.payload.generation !== baseline.generation
          || event.payload.closed
          || event.payload.closeCode !== null
          || event.payload.closeReason !== null) {
        fail('PHASE5_FAULT_STABILITY_TAIL_UNEXPECTED_EFFECT');
      }
    } else if (event.type === 'audio.pcm') {
      const index = event.client - 1;
      if (event.atMonotonicMs - lastAudioMonotonic[index]
            > TAIL_MAX_OBSERVATION_GAP_MS
          || event.atUnixMs - lastAudioUnix[index]
            > TAIL_MAX_OBSERVATION_GAP_MS) {
        fail('PHASE5_FAULT_STABILITY_TAIL_PCM_GAP');
      }
      audioCounts[index] += 1;
      lastAudioMonotonic[index] = event.atMonotonicMs;
      lastAudioUnix[index] = event.atUnixMs;
    } else if (event.type === 'worker.sample') {
      workerSamples += 1;
      if (event.atMonotonicMs - lastWorkerMonotonic
            > TAIL_MAX_OBSERVATION_GAP_MS
          || event.atUnixMs - lastWorkerUnix
            > TAIL_MAX_OBSERVATION_GAP_MS) {
        fail('PHASE5_FAULT_STABILITY_TAIL_OBSERVATION_GAP');
      }
      lastWorkerMonotonic = event.atMonotonicMs;
      lastWorkerUnix = event.atUnixMs;
      if (!isDeepStrictEqual(event.payload, start.worker)) {
        fail('PHASE5_FAULT_STABILITY_TAIL_UNEXPECTED_EFFECT');
      }
    } else if (event.type === 'agent.start') {
      if (event.payload.source !== 'real') {
        fail('PHASE5_FAULT_STABILITY_TAIL_UNEXPECTED_EFFECT');
      }
    } else if (event.payload.source !== 'real'
        || event.payload.status !== 'ok') {
      fail('PHASE5_FAULT_STABILITY_TAIL_UNEXPECTED_EFFECT');
    }
    applyEvent(machine, event);
  }

  const last = tail.at(-1);
  const { window } = evidence;
  if (last.atMonotonicMs - finalScenarioEvent.atMonotonicMs
        < FINAL_STABILITY_WINDOW_MS
      || last.atUnixMs - finalScenarioEvent.atUnixMs
        < FINAL_STABILITY_WINDOW_MS
      || window.endedAtMonotonicMs < last.atMonotonicMs
      || window.endedAtUnixMs < last.atUnixMs
      || window.endedAtMonotonicMs - last.atMonotonicMs
        > TAIL_MAX_OBSERVATION_GAP_MS
      || window.endedAtUnixMs - last.atUnixMs
        > TAIL_MAX_OBSERVATION_GAP_MS
      || runtimeSnapshotCounts.some((count) => count === 0)
      || workerSamples === 0
      || audioCounts.some((count) => count === 0)
      || lastAudioMonotonic.some((at) => (
        window.endedAtMonotonicMs - at > TAIL_MAX_OBSERVATION_GAP_MS
      ))
      || lastAudioUnix.some((at) => (
        window.endedAtUnixMs - at > TAIL_MAX_OBSERVATION_GAP_MS
      ))
      || lastRuntimeMonotonic.some((at) => (
        window.endedAtMonotonicMs - at > TAIL_MAX_OBSERVATION_GAP_MS
      ))
      || lastRuntimeUnix.some((at) => (
        window.endedAtUnixMs - at > TAIL_MAX_OBSERVATION_GAP_MS
      ))
      || window.endedAtMonotonicMs - lastWorkerMonotonic
        > TAIL_MAX_OBSERVATION_GAP_MS
      || window.endedAtUnixMs - lastWorkerUnix
        > TAIL_MAX_OBSERVATION_GAP_MS
      || machine.pendingAgent !== null
      || machine.world.worldGeneration !== start.world.worldGeneration
      || machine.world.revision <= start.world.revision
      || machine.world.eventSeq <= start.world.eventSeq
      || !isDeepStrictEqual(machine.worker, start.worker)) {
    fail('PHASE5_FAULT_STABILITY_TAIL_INCOMPLETE');
  }

  for (let index = 0; index < 4; index += 1) {
    const beforeRuntime = start.runtime[index];
    const afterRuntime = machine.runtime[index];
    const beforeAudio = start.audio[index];
    const afterAudio = machine.audio[index];
    const beforeEgress = start.egress[index];
    const afterEgress = machine.egress[index];
    if (!afterRuntime.open
        || !afterRuntime.ready
        || afterRuntime.generation !== beforeRuntime.generation
        || afterRuntime.clientIdentitySha256
          !== beforeRuntime.clientIdentitySha256
        || afterRuntime.snapshotWorldGeneration
          !== machine.world.worldGeneration
        || !afterAudio.open
        || !afterAudio.ready
        || afterAudio.paused
        || afterAudio.generation !== beforeAudio.generation
        || afterAudio.audioEpoch !== beforeAudio.audioEpoch
        || afterAudio.streamRevision !== beforeAudio.streamRevision
        || afterAudio.discontinuityCount !== beforeAudio.discontinuityCount
        || afterAudio.cursor <= beforeAudio.cursor
        || afterEgress.closed
        || afterEgress.generation !== beforeEgress.generation
        || afterEgress.queuedEntries !== 0
        || afterEgress.inFlight !== 0) {
      fail('PHASE5_FAULT_STABILITY_TAIL_UNEXPECTED_EFFECT');
    }
  }
  if (!isDeepStrictEqual(machine.provider.lastResult,
    start.provider.lastResult)
      && !(machine.provider.lastResult?.source === 'real'
        && machine.provider.lastResult?.status === 'ok')) {
    fail('PHASE5_FAULT_STABILITY_TAIL_UNEXPECTED_EFFECT');
  }
}

function snapshotState(machine) {
  if (machine.world === null
      || machine.worker === null
      || machine.runtime.some((value) => value === undefined)
      || machine.audio.some((value) => value === undefined)
      || machine.egress.some((value) => value === undefined)) {
    fail('PHASE5_FAULT_TRANSPORT_PRELUDE_INCOMPLETE');
  }
  if (new Set(machine.runtime.map(
    (client) => client.clientIdentitySha256,
  )).size !== 4) {
    fail('PHASE5_FAULT_RUNTIME_CLIENT_IDENTITY_INVALID');
  }
  const state = {
    world: { ...machine.world },
    runtimeClients: machine.runtime.map((client, index) => ({
      clientId: index + 1,
      connected: client.open && client.ready,
      generation: client.generation,
      snapshotWorldGeneration: client.open && client.ready
        ? client.snapshotWorldGeneration
        : null,
    })),
    audioClients: machine.audio.map((client, index) => ({
      clientId: index + 1,
      connected: client.open && client.ready,
      generation: client.generation,
      audioEpoch: client.audioEpoch,
      pcmCursorFrames: Number(client.cursor),
      discontinuityCount: client.discontinuityCount,
      paused: client.paused,
    })),
    worker: {
      pid: machine.worker.pid,
      ready: machine.worker.ready,
      recovering: machine.worker.recovering,
      audioEpoch: machine.worker.audioEpoch,
      restartCount: machine.worker.restartCount,
      supervisorGeneration: machine.worker.supervisorGeneration,
      lastExitedPid: machine.worker.lastExitedPid,
      lastExitSignal: machine.worker.lastExitSignal,
    },
    egress: machine.egress.map((entry, index) => ({
      clientId: index + 1,
      generation: entry.generation,
      queuedEntries: entry.queuedEntries,
      capacityEntries: entry.capacityEntries,
      closed: entry.closed,
      closeCode: entry.closeCode,
      closeReason: entry.closeReason,
    })),
    provider: {
      lastResult: machine.provider.lastResult === null
        ? null
        : { ...machine.provider.lastResult },
    },
  };
  try {
    validateFaultState(state);
  } catch {
    fail('PHASE5_FAULT_TRANSPORT_PRELUDE_INCOMPLETE');
  }
  if (state.audioClients.some(({ audioEpoch }) => (
    audioEpoch !== state.worker.audioEpoch
  ))) {
    fail('PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID');
  }
  return state;
}

function validateScenarioEvents(evidence) {
  const { scenarioEvents, transportEvents, runId } = evidence;
  let previousPrefix = 0;
  let previousScenarioEvent = null;
  for (let index = 0; index < scenarioEvents.length; index += 1) {
    const event = scenarioEvents[index];
    const scenarioIndex = Math.floor(index / PHASES.length);
    const phaseIndex = index % PHASES.length;
    if (!exactObjectKeys(event, SCENARIO_EVENT_FIELDS)
        || event.sequence !== index + 1
        || event.runId !== runId
        || event.scenario !== SCENARIOS[scenarioIndex]
        || event.phase !== PHASES[phaseIndex]
        || !nonNegativeSafeInteger(event.atMonotonicMs)
        || !positiveSafeInteger(event.atUnixMs)
        || !nonNegativeSafeInteger(event.transportPrefixCount)
        || event.transportPrefixCount > transportEvents.length
        || event.transportPrefixCount < previousPrefix
        || !isPlainObject(event.payload)
        || (previousScenarioEvent !== null
          && (event.atMonotonicMs <= previousScenarioEvent.atMonotonicMs
            || event.atUnixMs <= previousScenarioEvent.atUnixMs))) {
      fail('PHASE5_FAULT_TRANSPORT_SCENARIO_PLAN_INVALID');
    }
    if (event.transportPrefixCount > 0
        && (transportEvents[event.transportPrefixCount - 1].atMonotonicMs
          > event.atMonotonicMs
          || transportEvents[event.transportPrefixCount - 1].atUnixMs
            > event.atUnixMs)) {
      fail('PHASE5_FAULT_TRANSPORT_PREFIX_TIME_INVALID');
    }
    if (event.transportPrefixCount < transportEvents.length
        && (transportEvents[event.transportPrefixCount].atMonotonicMs
          <= event.atMonotonicMs
          || transportEvents[event.transportPrefixCount].atUnixMs
            <= event.atUnixMs)) {
      fail('PHASE5_FAULT_TRANSPORT_PREFIX_INCOMPLETE');
    }
    previousPrefix = event.transportPrefixCount;
    previousScenarioEvent = event;
  }
  for (let scenarioIndex = 0; scenarioIndex < SCENARIOS.length; scenarioIndex += 1) {
    const offset = scenarioIndex * PHASES.length;
    const beforePrefix = scenarioEvents[offset].transportPrefixCount;
    const faultPrefix = scenarioEvents[offset + 2].transportPrefixCount;
    const recoveryPrefix = scenarioEvents[offset + 4].transportPrefixCount;
    if (beforePrefix === 0
        || faultPrefix <= beforePrefix
        || recoveryPrefix <= faultPrefix) {
      fail('PHASE5_FAULT_TRANSPORT_PREFIX_PROGRESS_INVALID');
    }
  }
}

export function projectPhase5FaultTransport(evidence) {
  if (!isPlainObject(evidence)
      || !enumerableDataProperty(evidence, 'runId')
      || !enumerableDataProperty(evidence, 'window')
      || !enumerableDataProperty(evidence, 'transportEvents')
      || !enumerableDataProperty(evidence, 'scenarioEvents')
      || typeof evidence.runId !== 'string'
      || !UUID_V4.test(evidence.runId)
      || !exactObjectKeys(evidence.window, WINDOW_FIELDS)
      || !nonNegativeSafeInteger(evidence.window.startedAtMonotonicMs)
      || !nonNegativeSafeInteger(evidence.window.endedAtMonotonicMs)
      || !positiveSafeInteger(evidence.window.startedAtUnixMs)
      || !positiveSafeInteger(evidence.window.endedAtUnixMs)
      || evidence.window.endedAtMonotonicMs
        < evidence.window.startedAtMonotonicMs
      || evidence.window.endedAtUnixMs < evidence.window.startedAtUnixMs
      || !ordinaryDenseArray(evidence.transportEvents)
      || !ordinaryDenseArray(evidence.scenarioEvents, 35)) {
    fail('PHASE5_FAULT_TRANSPORT_PROJECTION_INPUT_INVALID');
  }

  let previousEvent = null;
  for (let index = 0; index < evidence.transportEvents.length; index += 1) {
    const event = evidence.transportEvents[index];
    validateTransportEnvelope(event, index, evidence.runId, previousEvent);
    previousEvent = event;
  }
  validateScenarioEvents(evidence);

  // Validate every event, including the stability tail after the final scenario
  // prefix. State projections below are still independently replayed by prefix.
  replay(evidence.transportEvents, evidence.transportEvents.length);
  validateStabilityTail(evidence);

  const stateEvents = [];
  for (const event of evidence.scenarioEvents) {
    if (!STATE_PHASES.has(event.phase)) continue;
    const machine = replay(
      evidence.transportEvents,
      event.transportPrefixCount,
    );
    stateEvents.push({
      scenario: event.scenario,
      phase: event.phase,
      atMonotonicMs: event.atMonotonicMs,
      state: snapshotState(machine),
    });
  }
  return {
    schemaVersion: 1,
    kind: 'phase5-fault-transport-projection',
    stateEvents,
  };
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clientTransportReceipt(event) {
  return {
    connectionGeneration: event.payload.generation,
    atMonotonicMs: event.atMonotonicMs,
    atUnixMs: event.atUnixMs,
    transportSequence: event.sequence,
    transportEventSha256: transportEventSha256(event),
  };
}

/**
 * Project the exact client-observations transport contract.
 *
 * This pure projector validates transport structure and state transitions, but
 * is not by itself a signature trust boundary.  Only the composite validator
 * may label its result trusted, after it has verified the signed closure and
 * supplied a validator-owned evidence snapshot.
 */
export function projectPhase5ClientObservationsTransport(evidence) {
  projectPhase5FaultTransport(evidence);

  const runtimeOpens = evidence.transportEvents
    .filter(({ type }) => type === 'runtime.open')
    .map((event) => ({
      client: event.client,
      connectionGeneration: event.payload.generation,
      atMonotonicMs: event.atMonotonicMs,
      atUnixMs: event.atUnixMs,
      mode: event.payload.mode,
      clientIdentitySha256: event.payload.clientIdentitySha256,
    }));
  const audioLifecycle = evidence.transportEvents
    .filter(({ type }) => (
      type === 'audio.open' || type === 'audio.close'
    ))
    .map((event) => ({
      client: event.client,
      connectionGeneration: event.payload.generation,
      type: event.type,
      atMonotonicMs: event.atMonotonicMs,
      atUnixMs: event.atUnixMs,
      payload: event.type === 'audio.open'
        ? {}
        : {
          code: event.payload.code,
          reason: event.payload.reason,
        },
    }));
  const pauses = evidence.transportEvents.filter((event) => (
    event.type === 'audio.pause' && event.client === 4
  ));
  const resumes = evidence.transportEvents.filter((event) => (
    event.type === 'audio.resume' && event.client === 4
  ));
  if (pauses.length !== 1 || resumes.length !== 1) {
    fail('PHASE5_CLIENT_TRANSPORT_SLOW_CLIENT_RECEIPTS_INVALID');
  }
  const discontinuities = evidence.transportEvents
    .filter(({ type }) => type === 'audio.discontinuity')
    .map((event) => ({
      client: event.client,
      connectionGeneration: event.payload.generation,
      atMonotonicMs: event.atMonotonicMs,
      atUnixMs: event.atUnixMs,
      transportSequence: event.sequence,
      transportEventSha256: transportEventSha256(event),
      scope: event.payload.scope,
      audioEpoch: event.payload.audioEpoch,
      streamRevision: event.payload.streamRevision,
      blockSeq: event.payload.blockSeq,
      resumeStartFrame: event.payload.resumeStartFrame,
    }));

  return deepFreeze({
    schemaVersion: 1,
    kind: 'phase5-client-observations-transport-projection',
    runId: evidence.runId,
    challenge: evidence.challenge,
    release: {
      releaseManifestSha256: evidence.release.releaseManifestSha256,
      releaseRevision: evidence.release.releaseRevision,
      sourceManifestSha256: evidence.release.sourceManifestSha256,
      audioArtifactSha256: evidence.release.audioArtifactSha256,
    },
    geometry: {
      sampleRate: evidence.geometry.sampleRate,
      blockFrames: evidence.geometry.blockFrames,
      poolSize: evidence.geometry.poolSize,
      rowVoices: [...evidence.geometry.rowVoices],
    },
    profile: {
      clients: evidence.profile.clients,
      slowClient: evidence.profile.slowClient,
      durationMinutes: evidence.profile.durationMinutes,
      speciesEndpoint: evidence.profile.speciesEndpoint,
      speciesModel: evidence.profile.speciesModel,
    },
    window: {
      startedAtMonotonicMs: evidence.window.startedAtMonotonicMs,
      endedAtMonotonicMs: evidence.window.endedAtMonotonicMs,
      startedAtUnixMs: evidence.window.startedAtUnixMs,
      endedAtUnixMs: evidence.window.endedAtUnixMs,
    },
    runtimeOpens,
    audioLifecycle,
    slowClient: {
      client: 4,
      pause: clientTransportReceipt(pauses[0]),
      resume: clientTransportReceipt(resumes[0]),
    },
    discontinuities,
  });
}
