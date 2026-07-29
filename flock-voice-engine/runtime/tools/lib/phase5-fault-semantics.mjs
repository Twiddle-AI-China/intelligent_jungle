import { isDeepStrictEqual } from 'node:util';

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
const SCENARIO_PLAN = Object.freeze([
  Object.freeze({
    scenario: 'worker-crash-restart',
    recoverySloMs: 15_000,
    faultAction: Object.freeze({
      operation: 'signal-worker',
      target: 'candidate-audio-worker',
    }),
    recoveryAction: Object.freeze({
      operation: 'await-supervisor-ready',
      target: 'candidate-audio-supervisor',
    }),
  }),
  Object.freeze({
    scenario: 'runtime-reconnect',
    recoverySloMs: 5_000,
    faultAction: Object.freeze({
      operation: 'disconnect-runtime',
      target: 'runtime-client-4',
    }),
    recoveryAction: Object.freeze({
      operation: 'reconnect-runtime',
      target: 'runtime-client-4',
    }),
  }),
  Object.freeze({
    scenario: 'slow-client',
    recoverySloMs: 7_000,
    faultAction: Object.freeze({
      operation: 'pause-audio',
      target: 'audio-client-4',
    }),
    recoveryAction: Object.freeze({
      operation: 'resume-audio',
      target: 'audio-client-4',
    }),
  }),
  Object.freeze({
    scenario: 'queue-pressure',
    recoverySloMs: 5_000,
    faultAction: Object.freeze({
      operation: 'saturate-egress',
      target: 'egress-client-4',
    }),
    recoveryAction: Object.freeze({
      operation: 'reconnect-egress',
      target: 'egress-client-4',
    }),
  }),
  Object.freeze({
    scenario: 'agent-timeout',
    recoverySloMs: 15_000,
    faultAction: Object.freeze({
      operation: 'inject-provider-timeout',
      target: 'bird_agent',
    }),
    recoveryAction: Object.freeze({
      operation: 'clear-provider-timeout',
      target: 'bird_agent',
    }),
  }),
  Object.freeze({
    scenario: 'agent-malformed-response',
    recoverySloMs: 15_000,
    faultAction: Object.freeze({
      operation: 'inject-provider-malformed-response',
      target: 'bird_agent',
    }),
    recoveryAction: Object.freeze({
      operation: 'clear-provider-malformed-response',
      target: 'bird_agent',
    }),
  }),
  Object.freeze({
    scenario: 'audio-epoch-discontinuity',
    recoverySloMs: 10_000,
    faultAction: Object.freeze({
      operation: 'rotate-audio-epoch',
      target: 'candidate-audio-worker',
    }),
    recoveryAction: Object.freeze({
      operation: 'settle-audio-epoch',
      target: 'all-audio-clients',
    }),
  }),
]);

export const FAULT_ACTUATOR_PLAN = Object.freeze(
  SCENARIO_PLAN.flatMap((entry, index) => [
    Object.freeze({
      actuatorSequence: index * 2 + 1,
      scenario: entry.scenario,
      phase: 'fault-action',
      operation: entry.faultAction.operation,
      target: entry.faultAction.target,
    }),
    Object.freeze({
      actuatorSequence: index * 2 + 2,
      scenario: entry.scenario,
      phase: 'recovery-action',
      operation: entry.recoveryAction.operation,
      target: entry.recoveryAction.target,
    }),
  ]),
);

const STATE_FIELDS = Object.freeze([
  'world',
  'runtimeClients',
  'audioClients',
  'worker',
  'egress',
  'provider',
]);
const WORLD_FIELDS = Object.freeze([
  'worldGeneration',
  'revision',
  'eventSeq',
]);
const RUNTIME_CLIENT_FIELDS = Object.freeze([
  'clientId',
  'connected',
  'generation',
  'snapshotWorldGeneration',
]);
const AUDIO_CLIENT_FIELDS = Object.freeze([
  'clientId',
  'connected',
  'generation',
  'audioEpoch',
  'pcmCursorFrames',
  'discontinuityCount',
  'paused',
]);
const WORKER_FIELDS = Object.freeze([
  'pid',
  'ready',
  'recovering',
  'audioEpoch',
  'restartCount',
  'supervisorGeneration',
  'lastExitedPid',
  'lastExitSignal',
]);
const EGRESS_FIELDS = Object.freeze([
  'clientId',
  'generation',
  'queuedEntries',
  'capacityEntries',
  'closed',
  'closeCode',
  'closeReason',
]);
const PROVIDER_FIELDS = Object.freeze(['lastResult']);
const PROVIDER_RESULT_FIELDS = Object.freeze([
  'requestId',
  'source',
  'model',
  'status',
  'reason',
  'attempts',
  'startedAtMonotonicMs',
  'settledAtMonotonicMs',
  'httpStatus',
]);
const STATE_PAYLOAD_FIELDS = Object.freeze(['kind', 'state']);
const ACTION_PAYLOAD_FIELDS = Object.freeze(['kind', 'action']);
const ACTION_FIELDS = Object.freeze(['operation', 'target', 'receipt']);
const RECEIPT_FIELDS = Object.freeze([
  Object.freeze([
    'actuatorSequence',
    'pid',
    'signal',
    'supervisorGeneration',
    'accepted',
  ]),
  Object.freeze([
    'actuatorSequence',
    'supervisorGeneration',
    'observedPid',
    'observedAudioEpoch',
    'ready',
    'recovering',
    'accepted',
  ]),
  Object.freeze([
    'actuatorSequence',
    'clientId',
    'beforeGeneration',
    'closeCode',
    'closeReason',
    'accepted',
  ]),
  Object.freeze([
    'actuatorSequence',
    'clientId',
    'beforeGeneration',
    'afterGeneration',
    'snapshotWorldGeneration',
    'accepted',
  ]),
  Object.freeze([
    'actuatorSequence',
    'clientId',
    'beforePaused',
    'afterPaused',
    'accepted',
  ]),
  Object.freeze([
    'actuatorSequence',
    'clientId',
    'beforePaused',
    'afterPaused',
    'accepted',
  ]),
  Object.freeze([
    'actuatorSequence',
    'clientId',
    'capacityEntries',
    'acceptedEntries',
    'rejectedEntries',
    'closeCode',
    'closeReason',
  ]),
  Object.freeze([
    'actuatorSequence',
    'clientId',
    'beforeGeneration',
    'afterGeneration',
    'accepted',
  ]),
  Object.freeze([
    'actuatorSequence',
    'requestId',
    'fixture',
    'accepted',
    'fixtureId',
    'fixtureSha256',
    'attemptTimeoutMs',
    'deadlineMs',
    'idleAdmission',
  ]),
  Object.freeze(['actuatorSequence', 'fixture', 'realRequestId', 'accepted']),
  Object.freeze(['actuatorSequence', 'requestId', 'fixture', 'accepted']),
  Object.freeze(['actuatorSequence', 'fixture', 'realRequestId', 'accepted']),
  Object.freeze([
    'actuatorSequence',
    'beforeAudioEpoch',
    'afterAudioEpoch',
    'accepted',
  ]),
  Object.freeze([
    'actuatorSequence',
    'audioEpoch',
    'clientCount',
    'accepted',
  ]),
]);
const PROJECTION_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'stateEvents',
]);
const PROJECTED_STATE_FIELDS = Object.freeze([
  'scenario',
  'phase',
  'atMonotonicMs',
  'state',
]);
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const PHASE5_SPECIES_ATTEMPT_TIMEOUT_MS = 12_000;
export const PHASE5_SPECIES_DEADLINE_MS = 15_000;
const TIMEOUT_FIXTURE_ID = 'phase5-timeout-hold-open-v1';
const TIMEOUT_FIXTURE_SHA256 =
  '12baea86a4fdc350efbfaea53fde6f60b330db5292e860c84a9bef4606eac598';

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
      || value.length !== expectedLength) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedLength + 1 || !keys.includes('length')) return false;
  for (let index = 0; index < expectedLength; index += 1) {
    if (!enumerableDataProperty(value, String(index))) return false;
  }
  return keys.every((key) => (
    key === 'length'
      || (typeof key === 'string'
        && /^(?:0|[1-9][0-9]*)$/.test(key)
        && Number(key) < expectedLength)
  ));
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validRequestId(value) {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validateWorld(world) {
  return exactObjectKeys(world, WORLD_FIELDS)
    && nonEmptyString(world.worldGeneration)
    && nonNegativeSafeInteger(world.revision)
    && nonNegativeSafeInteger(world.eventSeq);
}

function validateRuntimeClient(client, clientId, world) {
  if (!exactObjectKeys(client, RUNTIME_CLIENT_FIELDS)
      || client.clientId !== clientId
      || typeof client.connected !== 'boolean'
      || !nonNegativeSafeInteger(client.generation)) {
    return false;
  }
  return client.connected
    ? client.snapshotWorldGeneration === world.worldGeneration
    : client.snapshotWorldGeneration === null;
}

function validateAudioClient(client, clientId) {
  return exactObjectKeys(client, AUDIO_CLIENT_FIELDS)
    && client.clientId === clientId
    && typeof client.connected === 'boolean'
    && nonNegativeSafeInteger(client.generation)
    && nonEmptyString(client.audioEpoch)
    && nonNegativeSafeInteger(client.pcmCursorFrames)
    && nonNegativeSafeInteger(client.discontinuityCount)
    && typeof client.paused === 'boolean'
    && (!client.paused || client.connected);
}

function validateWorker(worker) {
  if (!exactObjectKeys(worker, WORKER_FIELDS)
      || typeof worker.ready !== 'boolean'
      || typeof worker.recovering !== 'boolean'
      || !nonEmptyString(worker.audioEpoch)
      || !nonNegativeSafeInteger(worker.restartCount)
      || !nonNegativeSafeInteger(worker.supervisorGeneration)
      || !(worker.lastExitedPid === null
        || positiveSafeInteger(worker.lastExitedPid))
      || !(worker.lastExitSignal === null
        || worker.lastExitSignal === 'SIGKILL')
      || ((worker.lastExitedPid === null)
        !== (worker.lastExitSignal === null))) {
    return false;
  }
  return worker.ready
    ? positiveSafeInteger(worker.pid) && !worker.recovering
    : worker.pid === null && worker.recovering;
}

function validateEgress(entry, clientId) {
  if (!(exactObjectKeys(entry, EGRESS_FIELDS)
      && entry.clientId === clientId
      && nonNegativeSafeInteger(entry.generation)
      && nonNegativeSafeInteger(entry.queuedEntries)
      && entry.capacityEntries === 256
      && entry.queuedEntries <= entry.capacityEntries
      && typeof entry.closed === 'boolean'
      && (entry.closeCode === null || positiveSafeInteger(entry.closeCode))
      && (entry.closeReason === null
        || (typeof entry.closeReason === 'string'
          && entry.closeReason.length > 0)))) {
    return false;
  }
  return entry.closed
    ? entry.closeCode !== null && entry.closeReason !== null
    : entry.closeCode === null && entry.closeReason === null;
}

function validateProviderResult(value) {
  if (value === null) return true;
  if (!(
    exactObjectKeys(value, PROVIDER_RESULT_FIELDS)
      && validRequestId(value.requestId)
      && ['injected', 'real'].includes(value.source)
      && value.model === 'bird_agent'
      && ['timeout', 'invalid_output', 'ok'].includes(value.status)
      && (value.reason === null || nonEmptyString(value.reason))
      && positiveSafeInteger(value.attempts)
      && nonNegativeSafeInteger(value.startedAtMonotonicMs)
      && nonNegativeSafeInteger(value.settledAtMonotonicMs)
      && value.settledAtMonotonicMs >= value.startedAtMonotonicMs
      && (value.httpStatus === null
        || (Number.isSafeInteger(value.httpStatus)
          && value.httpStatus >= 100
          && value.httpStatus <= 599))
  )) {
    return false;
  }
  if (value.status === 'timeout') {
    return ['ATTEMPT_TIMEOUT', 'DEADLINE_EXCEEDED'].includes(value.reason)
      && value.httpStatus === null;
  }
  if (value.status === 'invalid_output') {
    return value.reason === 'INVALID_OUTPUT' && value.httpStatus === 200;
  }
  return value.reason === null && value.httpStatus === 200;
}

function validateProvider(provider) {
  return exactObjectKeys(provider, PROVIDER_FIELDS)
    && validateProviderResult(provider.lastResult);
}

export function validateFaultState(state) {
  if (!exactObjectKeys(state, STATE_FIELDS)
      || !validateWorld(state.world)
      || !ordinaryDenseArray(state.runtimeClients, 4)
      || !ordinaryDenseArray(state.audioClients, 4)
      || !validateWorker(state.worker)
      || !ordinaryDenseArray(state.egress, 4)
      || !validateProvider(state.provider)) {
    fail('PHASE5_FAULT_STATE_INVALID');
  }
  for (let index = 0; index < 4; index += 1) {
    if (!validateRuntimeClient(state.runtimeClients[index], index + 1, state.world)
        || !validateAudioClient(state.audioClients[index], index + 1)
        || !validateEgress(state.egress[index], index + 1)) {
      fail('PHASE5_FAULT_STATE_INVALID');
    }
  }
  return state;
}

function validateRequiredEventFields(event) {
  if (!isPlainObject(event)
      || !enumerableDataProperty(event, 'scenario')
      || !enumerableDataProperty(event, 'phase')
      || !enumerableDataProperty(event, 'atMonotonicMs')
      || !enumerableDataProperty(event, 'payload')
      || typeof event.scenario !== 'string'
      || typeof event.phase !== 'string'
      || !nonNegativeSafeInteger(event.atMonotonicMs)) {
    fail('PHASE5_FAULT_EVENT_SHAPE_INVALID');
  }
}

function validateStatePayload(payload) {
  if (!exactObjectKeys(payload, STATE_PAYLOAD_FIELDS)
      || payload.kind !== 'state') {
    fail('PHASE5_FAULT_PAYLOAD_INVALID');
  }
  validateFaultState(payload.state);
}

function acceptedReceipt(receipt) {
  return receipt.accepted === true;
}

function validateReceiptShape(receipt, actuatorSequence) {
  const fields = RECEIPT_FIELDS[actuatorSequence - 1];
  if (fields === undefined
      || !exactObjectKeys(receipt, fields)
      || receipt.actuatorSequence !== actuatorSequence) {
    fail('PHASE5_FAULT_ACTION_RECEIPT_INVALID');
  }
  let valid = false;
  if (actuatorSequence === 1) {
    valid = positiveSafeInteger(receipt.pid)
      && receipt.signal === 'SIGKILL'
      && nonNegativeSafeInteger(receipt.supervisorGeneration)
      && acceptedReceipt(receipt);
  } else if (actuatorSequence === 2) {
    valid = nonNegativeSafeInteger(receipt.supervisorGeneration)
      && positiveSafeInteger(receipt.observedPid)
      && nonEmptyString(receipt.observedAudioEpoch)
      && receipt.ready === true
      && receipt.recovering === false
      && acceptedReceipt(receipt);
  } else if (actuatorSequence === 3) {
    valid = receipt.clientId === 4
      && nonNegativeSafeInteger(receipt.beforeGeneration)
      && receipt.closeCode === 1_000
      && receipt.closeReason === 'PHASE5_RUNTIME_RECONNECT'
      && acceptedReceipt(receipt);
  } else if (actuatorSequence === 4) {
    valid = receipt.clientId === 4
      && nonNegativeSafeInteger(receipt.beforeGeneration)
      && nonNegativeSafeInteger(receipt.afterGeneration)
      && nonEmptyString(receipt.snapshotWorldGeneration)
      && acceptedReceipt(receipt);
  } else if (actuatorSequence === 5 || actuatorSequence === 6) {
    valid = receipt.clientId === 4
      && typeof receipt.beforePaused === 'boolean'
      && typeof receipt.afterPaused === 'boolean'
      && acceptedReceipt(receipt);
  } else if (actuatorSequence === 7) {
    valid = receipt.clientId === 4
      && receipt.capacityEntries === 256
      && receipt.acceptedEntries === 256
      && positiveSafeInteger(receipt.rejectedEntries)
      && receipt.closeCode === 4_410
      && receipt.closeReason === 'EGRESS_OVERFLOW';
  } else if (actuatorSequence === 8) {
    valid = receipt.clientId === 4
      && nonNegativeSafeInteger(receipt.beforeGeneration)
      && nonNegativeSafeInteger(receipt.afterGeneration)
      && acceptedReceipt(receipt);
  } else if (actuatorSequence === 9 || actuatorSequence === 11) {
    const expectedFixture = actuatorSequence === 9
      ? 'timeout'
      : 'malformed-response';
    valid = validRequestId(receipt.requestId)
      && receipt.fixture === expectedFixture
      && acceptedReceipt(receipt);
    if (actuatorSequence === 9) {
      valid = valid
        && receipt.fixtureId === TIMEOUT_FIXTURE_ID
        && receipt.fixtureSha256 === TIMEOUT_FIXTURE_SHA256
        && receipt.attemptTimeoutMs === PHASE5_SPECIES_ATTEMPT_TIMEOUT_MS
        && receipt.deadlineMs === PHASE5_SPECIES_DEADLINE_MS
        && receipt.idleAdmission === true;
    }
  } else if (actuatorSequence === 10 || actuatorSequence === 12) {
    const expectedFixture = actuatorSequence === 10
      ? 'timeout'
      : 'malformed-response';
    valid = receipt.fixture === expectedFixture
      && validRequestId(receipt.realRequestId)
      && acceptedReceipt(receipt);
  } else if (actuatorSequence === 13) {
    valid = nonEmptyString(receipt.beforeAudioEpoch)
      && nonEmptyString(receipt.afterAudioEpoch)
      && acceptedReceipt(receipt);
  } else if (actuatorSequence === 14) {
    valid = nonEmptyString(receipt.audioEpoch)
      && receipt.clientCount === 4
      && acceptedReceipt(receipt);
  }
  if (!valid) fail('PHASE5_FAULT_ACTION_RECEIPT_INVALID');
}

function validateActionPayload(payload, expected) {
  if (!exactObjectKeys(payload, ACTION_PAYLOAD_FIELDS)
      || payload.kind !== 'action'
      || !exactObjectKeys(payload.action, ACTION_FIELDS)
      || payload.action.operation !== expected.operation
      || payload.action.target !== expected.target) {
    fail('PHASE5_FAULT_ACTION_INVALID');
  }
  validateReceiptShape(payload.action.receipt, expected.actuatorSequence);
}

function client(array, clientId) {
  return array[clientId - 1];
}

function strictlyAdvancingWorld(before, fault, recovery) {
  return before.world.worldGeneration === fault.world.worldGeneration
    && before.world.worldGeneration === recovery.world.worldGeneration
    && before.world.revision < fault.world.revision
    && fault.world.revision < recovery.world.revision
    && before.world.eventSeq < fault.world.eventSeq
    && fault.world.eventSeq < recovery.world.eventSeq;
}

function stableClientIdentity(before, fault, recovery, clientId, collection) {
  const beforeClient = client(before[collection], clientId);
  const faultClient = client(fault[collection], clientId);
  const recoveryClient = client(recovery[collection], clientId);
  return beforeClient.clientId === faultClient.clientId
    && beforeClient.clientId === recoveryClient.clientId;
}

function exactStableCollection(before, fault, recovery, collection) {
  return isDeepStrictEqual(before[collection], fault[collection])
    && isDeepStrictEqual(before[collection], recovery[collection]);
}

function exactStableValue(before, fault, recovery, field) {
  return isDeepStrictEqual(before[field], fault[field])
    && isDeepStrictEqual(before[field], recovery[field]);
}

function stableAudioMetadata(left, right) {
  return left.clientId === right.clientId
    && left.connected === right.connected
    && left.generation === right.generation
    && left.audioEpoch === right.audioEpoch
    && left.discontinuityCount === right.discontinuityCount
    && left.paused === right.paused;
}

function normalAudioProgress(before, fault, recovery) {
  return [1, 2, 3, 4].every((clientId) => {
    const beforeClient = client(before.audioClients, clientId);
    const faultClient = client(fault.audioClients, clientId);
    const recoveryClient = client(recovery.audioClients, clientId);
    return beforeClient.connected
      && faultClient.connected
      && recoveryClient.connected
      && !beforeClient.paused
      && stableAudioMetadata(beforeClient, faultClient)
      && stableAudioMetadata(beforeClient, recoveryClient)
      && faultClient.pcmCursorFrames > beforeClient.pcmCursorFrames
      && recoveryClient.pcmCursorFrames > faultClient.pcmCursorFrames;
  });
}

function realProviderSuccess(result) {
  return result !== null
    && result.source === 'real'
    && result.model === 'bird_agent'
    && result.status === 'ok'
    && result.reason === null
    && result.httpStatus === 200;
}

function sharedProviderTransition(previous, next, observedAtMonotonicMs) {
  if (next === null) return previous === null;
  if (!realProviderSuccess(next)
      || next.settledAtMonotonicMs > observedAtMonotonicMs) {
    return false;
  }
  if (previous === null || isDeepStrictEqual(previous, next)) return true;
  return next.requestId !== previous.requestId
    && next.startedAtMonotonicMs >= previous.settledAtMonotonicMs;
}

function sharedProviderTimeline(events, before, fault, recovery) {
  const beforeResult = before.provider.lastResult;
  return (beforeResult === null
      || (realProviderSuccess(beforeResult)
        && beforeResult.settledAtMonotonicMs <= events[0].atMonotonicMs))
    && sharedProviderTransition(
      beforeResult,
      fault.provider.lastResult,
      events[2].atMonotonicMs,
    )
    && sharedProviderTransition(
      fault.provider.lastResult,
      recovery.provider.lastResult,
      events[4].atMonotonicMs,
    );
}

function validateWorkerScenario(events, before, fault, recovery) {
  const workerValid = before.worker.ready
    && !before.worker.recovering
    && positiveSafeInteger(before.worker.pid)
    && !fault.worker.ready
    && fault.worker.recovering
    && fault.worker.pid === null
    && fault.worker.audioEpoch === before.worker.audioEpoch
    && fault.worker.restartCount === before.worker.restartCount
    && fault.worker.supervisorGeneration
      === before.worker.supervisorGeneration + 1
    && fault.worker.lastExitedPid === before.worker.pid
    && fault.worker.lastExitSignal === 'SIGKILL'
    && recovery.worker.ready
    && !recovery.worker.recovering
    && positiveSafeInteger(recovery.worker.pid)
    && recovery.worker.pid !== before.worker.pid
    && recovery.worker.audioEpoch !== before.worker.audioEpoch
    && recovery.worker.restartCount === before.worker.restartCount + 1
    && recovery.worker.supervisorGeneration
      === fault.worker.supervisorGeneration
    && recovery.worker.lastExitedPid === before.worker.pid
    && recovery.worker.lastExitSignal === 'SIGKILL';
  const audioValid = [1, 2, 3, 4].every((clientId) => {
    const beforeClient = client(before.audioClients, clientId);
    const faultClient = client(fault.audioClients, clientId);
    const recoveryClient = client(recovery.audioClients, clientId);
    return stableClientIdentity(before, fault, recovery, clientId, 'audioClients')
      && beforeClient.connected
      && faultClient.connected
      && recoveryClient.connected
      && !beforeClient.paused
      && !faultClient.paused
      && !recoveryClient.paused
      && faultClient.generation === beforeClient.generation
      && recoveryClient.generation === beforeClient.generation
      && faultClient.audioEpoch === beforeClient.audioEpoch
      && recoveryClient.audioEpoch === recovery.worker.audioEpoch
      && faultClient.discontinuityCount === beforeClient.discontinuityCount
      && recoveryClient.discontinuityCount
        === beforeClient.discontinuityCount + 1
      && faultClient.pcmCursorFrames >= beforeClient.pcmCursorFrames
      && recoveryClient.pcmCursorFrames > 0;
  });
  if (!workerValid
      || !strictlyAdvancingWorld(before, fault, recovery)
      || !audioValid
      || !exactStableCollection(before, fault, recovery, 'runtimeClients')
      || !exactStableCollection(before, fault, recovery, 'egress')
      || !sharedProviderTimeline(events, before, fault, recovery)) {
    fail('PHASE5_FAULT_WORKER_SEMANTICS_INVALID');
  }
}

function validateRuntimeReconnectScenario(events, before, fault, recovery) {
  const beforeC4 = client(before.runtimeClients, 4);
  const faultC4 = client(fault.runtimeClients, 4);
  const recoveryC4 = client(recovery.runtimeClients, 4);
  const c4Valid = beforeC4.connected
    && !faultC4.connected
    && faultC4.generation === beforeC4.generation
    && faultC4.snapshotWorldGeneration === null
    && recoveryC4.connected
    && recoveryC4.generation === beforeC4.generation + 1
    && recoveryC4.snapshotWorldGeneration === recovery.world.worldGeneration;
  const hotValid = [1, 2, 3].every((clientId) => {
    const beforeClient = client(before.runtimeClients, clientId);
    const faultClient = client(fault.runtimeClients, clientId);
    const recoveryClient = client(recovery.runtimeClients, clientId);
    return beforeClient.connected
      && faultClient.connected
      && recoveryClient.connected
      && beforeClient.generation === faultClient.generation
      && beforeClient.generation === recoveryClient.generation;
  });
  const beforeEgress = client(before.egress, 4);
  const faultEgress = client(fault.egress, 4);
  const recoveryEgress = client(recovery.egress, 4);
  const targetEgressValid = !beforeEgress.closed
    && beforeEgress.queuedEntries === 0
    && faultEgress.closed
    && faultEgress.generation === beforeEgress.generation
    && faultEgress.queuedEntries === beforeEgress.queuedEntries
    && faultEgress.closeCode === 1_000
    && faultEgress.closeReason === 'PHASE5_RUNTIME_RECONNECT'
    && !recoveryEgress.closed
    && recoveryEgress.generation === beforeEgress.generation + 1
    && recoveryEgress.queuedEntries === 0
    && recoveryEgress.closeCode === null
    && recoveryEgress.closeReason === null;
  const hotEgressValid = [1, 2, 3].every((clientId) => (
    isDeepStrictEqual(
      client(before.egress, clientId),
      client(fault.egress, clientId),
    )
      && isDeepStrictEqual(
        client(before.egress, clientId),
        client(recovery.egress, clientId),
      )
  ));
  if (!strictlyAdvancingWorld(before, fault, recovery)
      || !c4Valid
      || !hotValid
      || !targetEgressValid
      || !hotEgressValid
      || !normalAudioProgress(before, fault, recovery)
      || !exactStableValue(before, fault, recovery, 'worker')
      || !sharedProviderTimeline(events, before, fault, recovery)) {
    fail('PHASE5_FAULT_RUNTIME_RECONNECT_SEMANTICS_INVALID');
  }
}

function validateSlowClientScenario(events, before, fault, recovery) {
  const faultActionAt = events[1].atMonotonicMs;
  const faultObservedAt = events[2].atMonotonicMs;
  const beforeC4 = client(before.audioClients, 4);
  const faultC4 = client(fault.audioClients, 4);
  const recoveryC4 = client(recovery.audioClients, 4);
  const c4Valid = beforeC4.connected
    && faultC4.connected
    && recoveryC4.connected
    && !beforeC4.paused
    && faultC4.paused
    && !recoveryC4.paused
    && beforeC4.generation === faultC4.generation
    && beforeC4.generation === recoveryC4.generation
    && beforeC4.audioEpoch === faultC4.audioEpoch
    && beforeC4.audioEpoch === recoveryC4.audioEpoch
    && beforeC4.discontinuityCount === faultC4.discontinuityCount
    && beforeC4.discontinuityCount === recoveryC4.discontinuityCount
    && faultC4.pcmCursorFrames === beforeC4.pcmCursorFrames
    && recoveryC4.pcmCursorFrames > faultC4.pcmCursorFrames;
  const hotValid = [1, 2, 3].every((clientId) => {
    const beforeClient = client(before.audioClients, clientId);
    const faultClient = client(fault.audioClients, clientId);
    const recoveryClient = client(recovery.audioClients, clientId);
    return beforeClient.connected
      && faultClient.connected
      && recoveryClient.connected
      && !beforeClient.paused
      && !faultClient.paused
      && !recoveryClient.paused
      && beforeClient.generation === faultClient.generation
      && beforeClient.generation === recoveryClient.generation
      && beforeClient.audioEpoch === faultClient.audioEpoch
      && beforeClient.audioEpoch === recoveryClient.audioEpoch
      && beforeClient.discontinuityCount === faultClient.discontinuityCount
      && beforeClient.discontinuityCount === recoveryClient.discontinuityCount
      && faultClient.pcmCursorFrames > beforeClient.pcmCursorFrames
      && recoveryClient.pcmCursorFrames > faultClient.pcmCursorFrames;
  });
  if (faultObservedAt - faultActionAt < 2_000
      || !strictlyAdvancingWorld(before, fault, recovery)
      || !c4Valid
      || !hotValid
      || !exactStableCollection(before, fault, recovery, 'runtimeClients')
      || !exactStableCollection(before, fault, recovery, 'egress')
      || !exactStableValue(before, fault, recovery, 'worker')
      || !sharedProviderTimeline(events, before, fault, recovery)) {
    fail('PHASE5_FAULT_SLOW_CLIENT_SEMANTICS_INVALID');
  }
}

function validateQueuePressureScenario(events, before, fault, recovery) {
  const beforeRuntime = client(before.runtimeClients, 4);
  const faultRuntime = client(fault.runtimeClients, 4);
  const recoveryRuntime = client(recovery.runtimeClients, 4);
  const beforeEgress = client(before.egress, 4);
  const faultEgress = client(fault.egress, 4);
  const recoveryEgress = client(recovery.egress, 4);
  const c4Valid = beforeRuntime.connected
    && !faultRuntime.connected
    && faultRuntime.generation === beforeRuntime.generation
    && faultRuntime.snapshotWorldGeneration === null
    && recoveryRuntime.connected
    && recoveryRuntime.generation === beforeRuntime.generation + 1
    && recoveryRuntime.snapshotWorldGeneration
      === recovery.world.worldGeneration
    && !beforeEgress.closed
    && faultEgress.closed
    && faultEgress.generation === beforeEgress.generation
    && faultEgress.capacityEntries === 256
    && faultEgress.queuedEntries === faultEgress.capacityEntries
    && faultEgress.closeCode === 4_410
    && faultEgress.closeReason === 'EGRESS_OVERFLOW'
    && !recoveryEgress.closed
    && recoveryEgress.generation === beforeEgress.generation + 1
    && recoveryEgress.queuedEntries === 0
    && recoveryEgress.closeCode === null
    && recoveryEgress.closeReason === null;
  const hotValid = [1, 2, 3].every((clientId) => {
    const runtimeStates = [before, fault, recovery]
      .map((state) => client(state.runtimeClients, clientId));
    const egressStates = [before, fault, recovery]
      .map((state) => client(state.egress, clientId));
    return runtimeStates.every(({ connected }) => connected)
      && egressStates.every(({ closed }) => !closed)
      && isDeepStrictEqual(runtimeStates[0], runtimeStates[1])
      && isDeepStrictEqual(runtimeStates[0], runtimeStates[2])
      && isDeepStrictEqual(egressStates[0], egressStates[1])
      && isDeepStrictEqual(egressStates[0], egressStates[2]);
  });
  if (!strictlyAdvancingWorld(before, fault, recovery)
      || !c4Valid
      || !hotValid
      || !normalAudioProgress(before, fault, recovery)
      || !exactStableValue(before, fault, recovery, 'worker')
      || !sharedProviderTimeline(events, before, fault, recovery)) {
    fail('PHASE5_FAULT_QUEUE_PRESSURE_SEMANTICS_INVALID');
  }
}

function validateAgentScenario(events, before, fault, recovery, expectedKind) {
  const injected = fault.provider.lastResult;
  const realSuccess = recovery.provider.lastResult;
  const prior = before.provider.lastResult;
  const expectedFailure = expectedKind === 'timeout'
    ? injected !== null
      && injected.status === 'timeout'
      && injected.reason === 'ATTEMPT_TIMEOUT'
      && injected.httpStatus === null
      && injected.settledAtMonotonicMs - injected.startedAtMonotonicMs
        >= PHASE5_SPECIES_ATTEMPT_TIMEOUT_MS
    : injected !== null
      && injected.status === 'invalid_output'
      && injected.reason === 'INVALID_OUTPUT'
      && injected.httpStatus === 200;
  const valid = strictlyAdvancingWorld(before, fault, recovery)
    && (prior === null
      || (realProviderSuccess(prior)
        && prior.settledAtMonotonicMs <= events[0].atMonotonicMs))
    && injected !== null
    && injected.source === 'injected'
    && injected.model === 'bird_agent'
    && injected.attempts === 1
    && (prior === null || injected.requestId !== prior.requestId)
    && expectedFailure
    && injected.startedAtMonotonicMs >= events[1].atMonotonicMs
    && injected.settledAtMonotonicMs <= events[2].atMonotonicMs
    && realSuccess !== null
    && realProviderSuccess(realSuccess)
    && realSuccess.requestId !== injected.requestId
    && realSuccess.startedAtMonotonicMs >= events[3].atMonotonicMs
    && realSuccess.settledAtMonotonicMs <= events[4].atMonotonicMs
    && realSuccess.startedAtMonotonicMs >= injected.settledAtMonotonicMs
    && exactStableCollection(before, fault, recovery, 'runtimeClients')
    && normalAudioProgress(before, fault, recovery)
    && exactStableValue(before, fault, recovery, 'worker')
    && exactStableCollection(before, fault, recovery, 'egress');
  if (!valid) fail('PHASE5_FAULT_AGENT_SEMANTICS_INVALID');
}

function validateAudioEpochScenario(events, before, fault, recovery) {
  const workerValid = before.worker.ready
    && fault.worker.ready
    && recovery.worker.ready
    && fault.worker.pid === before.worker.pid
    && recovery.worker.pid === before.worker.pid
    && fault.worker.recovering === before.worker.recovering
    && recovery.worker.recovering === before.worker.recovering
    && fault.worker.audioEpoch !== before.worker.audioEpoch
    && recovery.worker.audioEpoch === fault.worker.audioEpoch
    && fault.worker.restartCount === before.worker.restartCount
    && recovery.worker.restartCount === before.worker.restartCount
    && fault.worker.supervisorGeneration === before.worker.supervisorGeneration
    && recovery.worker.supervisorGeneration === before.worker.supervisorGeneration
    && fault.worker.lastExitedPid === before.worker.lastExitedPid
    && recovery.worker.lastExitedPid === before.worker.lastExitedPid
    && fault.worker.lastExitSignal === before.worker.lastExitSignal
    && recovery.worker.lastExitSignal === before.worker.lastExitSignal;
  const clientsValid = [1, 2, 3, 4].every((clientId) => {
    const beforeClient = client(before.audioClients, clientId);
    const faultClient = client(fault.audioClients, clientId);
    const recoveryClient = client(recovery.audioClients, clientId);
    return beforeClient.connected
      && faultClient.connected
      && recoveryClient.connected
      && beforeClient.generation === faultClient.generation
      && beforeClient.generation === recoveryClient.generation
      && faultClient.audioEpoch !== beforeClient.audioEpoch
      && recoveryClient.audioEpoch === faultClient.audioEpoch
      && faultClient.audioEpoch === fault.worker.audioEpoch
      && faultClient.discontinuityCount === beforeClient.discontinuityCount + 1
      && recoveryClient.discontinuityCount === faultClient.discontinuityCount
      && faultClient.pcmCursorFrames === 0
      && recoveryClient.pcmCursorFrames > faultClient.pcmCursorFrames;
  });
  if (!workerValid
      || !strictlyAdvancingWorld(before, fault, recovery)
      || !clientsValid
      || !exactStableCollection(before, fault, recovery, 'runtimeClients')
      || !exactStableCollection(before, fault, recovery, 'egress')
      || !sharedProviderTimeline(events, before, fault, recovery)) {
    fail('PHASE5_FAULT_AUDIO_EPOCH_SEMANTICS_INVALID');
  }
}

function expectedActionReceipts(scenario, before, fault, recovery) {
  if (scenario === 'worker-crash-restart') {
    return [
      {
        actuatorSequence: 1,
        pid: before.worker.pid,
        signal: 'SIGKILL',
        supervisorGeneration: before.worker.supervisorGeneration,
        accepted: true,
      },
      {
        actuatorSequence: 2,
        supervisorGeneration: recovery.worker.supervisorGeneration,
        observedPid: recovery.worker.pid,
        observedAudioEpoch: recovery.worker.audioEpoch,
        ready: recovery.worker.ready,
        recovering: recovery.worker.recovering,
        accepted: true,
      },
    ];
  }
  if (scenario === 'runtime-reconnect') {
    return [
      {
        actuatorSequence: 3,
        clientId: 4,
        beforeGeneration: before.runtimeClients[3].generation,
        closeCode: 1_000,
        closeReason: 'PHASE5_RUNTIME_RECONNECT',
        accepted: true,
      },
      {
        actuatorSequence: 4,
        clientId: 4,
        beforeGeneration: before.runtimeClients[3].generation,
        afterGeneration: recovery.runtimeClients[3].generation,
        snapshotWorldGeneration:
          recovery.runtimeClients[3].snapshotWorldGeneration,
        accepted: true,
      },
    ];
  }
  if (scenario === 'slow-client') {
    return [
      {
        actuatorSequence: 5,
        clientId: 4,
        beforePaused: before.audioClients[3].paused,
        afterPaused: fault.audioClients[3].paused,
        accepted: true,
      },
      {
        actuatorSequence: 6,
        clientId: 4,
        beforePaused: fault.audioClients[3].paused,
        afterPaused: recovery.audioClients[3].paused,
        accepted: true,
      },
    ];
  }
  if (scenario === 'queue-pressure') {
    return [
      {
        actuatorSequence: 7,
        clientId: 4,
        capacityEntries: fault.egress[3].capacityEntries,
        acceptedEntries: fault.egress[3].capacityEntries,
        rejectedEntries: 1,
        closeCode: fault.egress[3].closeCode,
        closeReason: fault.egress[3].closeReason,
      },
      {
        actuatorSequence: 8,
        clientId: 4,
        beforeGeneration: before.egress[3].generation,
        afterGeneration: recovery.egress[3].generation,
        accepted: true,
      },
    ];
  }
  if (scenario === 'agent-timeout'
      || scenario === 'agent-malformed-response') {
    const fixture = scenario === 'agent-timeout'
      ? 'timeout'
      : 'malformed-response';
    const firstSequence = scenario === 'agent-timeout' ? 9 : 11;
    const faultReceipt = {
      actuatorSequence: firstSequence,
      requestId: fault.provider.lastResult.requestId,
      fixture,
      accepted: true,
    };
    if (scenario === 'agent-timeout') {
      Object.assign(faultReceipt, {
        fixtureId: TIMEOUT_FIXTURE_ID,
        fixtureSha256: TIMEOUT_FIXTURE_SHA256,
        attemptTimeoutMs: PHASE5_SPECIES_ATTEMPT_TIMEOUT_MS,
        deadlineMs: PHASE5_SPECIES_DEADLINE_MS,
        idleAdmission: true,
      });
    }
    return [
      faultReceipt,
      {
        actuatorSequence: firstSequence + 1,
        fixture,
        realRequestId: recovery.provider.lastResult.requestId,
        accepted: true,
      },
    ];
  }
  return [
    {
      actuatorSequence: 13,
      beforeAudioEpoch: before.worker.audioEpoch,
      afterAudioEpoch: fault.worker.audioEpoch,
      accepted: true,
    },
    {
      actuatorSequence: 14,
      audioEpoch: recovery.worker.audioEpoch,
      clientCount: recovery.audioClients.length,
      accepted: true,
    },
  ];
}

function validateActionReceiptBindings(scenario, events, before, fault, recovery) {
  const expected = expectedActionReceipts(
    scenario,
    before,
    fault,
    recovery,
  );
  const observed = [
    events[1].payload.action.receipt,
    events[3].payload.action.receipt,
  ];
  if (!isDeepStrictEqual(observed, expected)) {
    fail('PHASE5_FAULT_ACTION_RECEIPT_INVALID');
  }
}

function validateStateContinuity(previousRecoveryEvent, nextBeforeEvent) {
  const previous = previousRecoveryEvent.payload.state;
  const next = nextBeforeEvent.payload.state;
  const worldValid = next.world.worldGeneration === previous.world.worldGeneration
    && next.world.revision > previous.world.revision
    && next.world.eventSeq > previous.world.eventSeq;
  const audioValid = [1, 2, 3, 4].every((clientId) => {
    const previousClient = client(previous.audioClients, clientId);
    const nextClient = client(next.audioClients, clientId);
    return stableAudioMetadata(previousClient, nextClient)
      && nextClient.connected
      && !nextClient.paused
      && nextClient.pcmCursorFrames > previousClient.pcmCursorFrames;
  });
  const providerValid = sharedProviderTransition(
    previous.provider.lastResult,
    next.provider.lastResult,
    nextBeforeEvent.atMonotonicMs,
  );
  if (!worldValid
      || !isDeepStrictEqual(previous.runtimeClients, next.runtimeClients)
      || !audioValid
      || !isDeepStrictEqual(previous.worker, next.worker)
      || !isDeepStrictEqual(previous.egress, next.egress)
      || !providerValid) {
    fail('PHASE5_FAULT_STATE_CONTINUITY_INVALID');
  }
}

function validateScenarioSemantics(scenario, events) {
  const before = events[0].payload.state;
  const fault = events[2].payload.state;
  const recovery = events[4].payload.state;
  if (scenario === 'worker-crash-restart') {
    validateWorkerScenario(events, before, fault, recovery);
  } else if (scenario === 'runtime-reconnect') {
    validateRuntimeReconnectScenario(events, before, fault, recovery);
  } else if (scenario === 'slow-client') {
    validateSlowClientScenario(events, before, fault, recovery);
  } else if (scenario === 'queue-pressure') {
    validateQueuePressureScenario(events, before, fault, recovery);
  } else if (scenario === 'agent-timeout') {
    validateAgentScenario(events, before, fault, recovery, 'timeout');
  } else if (scenario === 'agent-malformed-response') {
    validateAgentScenario(events, before, fault, recovery, 'malformed-response');
  } else if (scenario === 'audio-epoch-discontinuity') {
    validateAudioEpochScenario(events, before, fault, recovery);
  }
  validateActionReceiptBindings(scenario, events, before, fault, recovery);
}

function validateTransportProjection(projection, scenarioEvents) {
  const expectedEvents = scenarioEvents.filter(({ phase }) => STATE_PHASES.has(phase));
  if (!exactObjectKeys(projection, PROJECTION_FIELDS)
      || projection.schemaVersion !== 1
      || projection.kind !== 'phase5-fault-transport-projection'
      || !ordinaryDenseArray(projection.stateEvents, expectedEvents.length)) {
    fail('PHASE5_FAULT_TRANSPORT_PROJECTION_INVALID');
  }
  for (let index = 0; index < expectedEvents.length; index += 1) {
    const projected = projection.stateEvents[index];
    const expected = expectedEvents[index];
    if (!exactObjectKeys(projected, PROJECTED_STATE_FIELDS)
        || projected.scenario !== expected.scenario
        || projected.phase !== expected.phase
        || projected.atMonotonicMs !== expected.atMonotonicMs) {
      fail('PHASE5_FAULT_TRANSPORT_PROJECTION_INVALID');
    }
    validateFaultState(projected.state);
    if (!isDeepStrictEqual(projected.state, expected.payload.state)) {
      fail('PHASE5_FAULT_TRANSPORT_PROJECTION_MISMATCH');
    }
  }
}

export function validateFaultScenarioSemantics(input, transportProjection) {
  if (transportProjection === undefined) {
    fail('PHASE5_FAULT_TRANSPORT_PROJECTION_REQUIRED');
  }
  if (!exactObjectKeys(input, ['scenarioEvents'])
      || !ordinaryDenseArray(input.scenarioEvents, SCENARIO_PLAN.length * PHASES.length)) {
    fail('PHASE5_FAULT_SEMANTICS_INPUT_INVALID');
  }

  let previousEvent = null;
  let previousRecoveryEvent = null;
  let actionIndex = 0;
  for (let scenarioIndex = 0; scenarioIndex < SCENARIO_PLAN.length; scenarioIndex += 1) {
    const expectedScenario = SCENARIO_PLAN[scenarioIndex];
    const offset = scenarioIndex * PHASES.length;
    const events = input.scenarioEvents.slice(offset, offset + PHASES.length);
    for (let phaseIndex = 0; phaseIndex < PHASES.length; phaseIndex += 1) {
      const event = events[phaseIndex];
      validateRequiredEventFields(event);
      if (event.scenario !== expectedScenario.scenario
          || event.phase !== PHASES[phaseIndex]) {
        fail('PHASE5_FAULT_EVENT_PLAN_INVALID');
      }
      if (previousEvent !== null
          && event.atMonotonicMs <= previousEvent.atMonotonicMs) {
        if (phaseIndex === 0) fail('PHASE5_FAULT_SCENARIO_OVERLAP');
        fail('PHASE5_FAULT_EVENT_TIME_INVALID');
      }
      if (STATE_PHASES.has(event.phase)) {
        validateStatePayload(event.payload);
      } else {
        validateActionPayload(event.payload, FAULT_ACTUATOR_PLAN[actionIndex]);
        actionIndex += 1;
      }
      previousEvent = event;
    }
    if (events[4].atMonotonicMs - events[1].atMonotonicMs
        > expectedScenario.recoverySloMs) {
      fail('PHASE5_FAULT_RECOVERY_SLO_EXCEEDED');
    }
    if (previousRecoveryEvent !== null) {
      validateStateContinuity(previousRecoveryEvent, events[0]);
    }
    validateScenarioSemantics(expectedScenario.scenario, events);
    previousRecoveryEvent = events[4];
  }
  if (actionIndex !== FAULT_ACTUATOR_PLAN.length) {
    fail('PHASE5_FAULT_ACTION_INVALID');
  }
  validateTransportProjection(transportProjection, input.scenarioEvents);
  return input;
}
