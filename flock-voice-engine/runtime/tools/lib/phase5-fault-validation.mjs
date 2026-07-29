import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  canonicalJson,
  validateSignedFaultEventEvidence,
} from './phase5-fault-evidence.mjs';
import {
  projectPhase5ClientObservationsTransport,
  projectPhase5FaultTransport,
} from './phase5-fault-transport-projection.mjs';
import {
  validateFaultScenarioSemantics,
} from './phase5-fault-semantics.mjs';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RUN_BINDING_FIELDS = Object.freeze([
  'runId',
  'challenge',
  'release',
  'geometry',
  'profile',
  'signerSpkiSha256',
  'faultSessionEvidenceSha256',
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
const FIXED_ROW_VOICES = Object.freeze([
  'bass',
  'pad',
  'lead',
  'pluck',
  'pad',
]);
const SCENARIOS = Object.freeze([
  Object.freeze({
    scenario: 'worker-crash-restart',
    recoverySloMs: 15_000,
  }),
  Object.freeze({
    scenario: 'runtime-reconnect',
    recoverySloMs: 5_000,
  }),
  Object.freeze({
    scenario: 'slow-client',
    recoverySloMs: 7_000,
  }),
  Object.freeze({
    scenario: 'queue-pressure',
    recoverySloMs: 5_000,
  }),
  Object.freeze({
    scenario: 'agent-timeout',
    recoverySloMs: 15_000,
  }),
  Object.freeze({
    scenario: 'agent-malformed-response',
    recoverySloMs: 15_000,
  }),
  Object.freeze({
    scenario: 'audio-epoch-discontinuity',
    recoverySloMs: 10_000,
  }),
]);
const STATE_PHASES = new Set([
  'before',
  'fault-observed',
  'recovery-observed',
]);

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

function validateRunBinding(runBinding) {
  if (!exactObjectKeys(runBinding, RUN_BINDING_FIELDS)
      || typeof runBinding.runId !== 'string'
      || !UUID_V4.test(runBinding.runId)
      || typeof runBinding.challenge !== 'string'
      || !HEX64.test(runBinding.challenge)
      || typeof runBinding.signerSpkiSha256 !== 'string'
      || !HEX64.test(runBinding.signerSpkiSha256)
      || typeof runBinding.faultSessionEvidenceSha256 !== 'string'
      || !HEX64.test(runBinding.faultSessionEvidenceSha256)
      || !exactObjectKeys(runBinding.release, RELEASE_FIELDS)
      || !HEX64.test(runBinding.release.releaseManifestSha256)
      || !HEX40.test(runBinding.release.releaseRevision)
      || !HEX64.test(runBinding.release.sourceManifestSha256)
      || !HEX64.test(runBinding.release.audioArtifactSha256)
      || !exactObjectKeys(runBinding.geometry, GEOMETRY_FIELDS)
      || runBinding.geometry.sampleRate !== 44_100
      || runBinding.geometry.blockFrames !== 4_096
      || runBinding.geometry.poolSize !== 5
      || !ordinaryDenseArray(
        runBinding.geometry.rowVoices,
        FIXED_ROW_VOICES.length,
      )
      || runBinding.geometry.rowVoices.some((voice, index) => (
        voice !== FIXED_ROW_VOICES[index]
      ))
      || !exactObjectKeys(runBinding.profile, PROFILE_FIELDS)
      || runBinding.profile.clients !== 4
      || runBinding.profile.slowClient !== 4
      || runBinding.profile.durationMinutes !== 30
      || runBinding.profile.speciesEndpoint
        !== 'http://127.0.0.1:8081/v1'
      || runBinding.profile.speciesModel !== 'bird_agent') {
    fail('PHASE5_FAULT_RUN_BINDING_INVALID');
  }
}

function validateCrossBinding(evidence, runBinding) {
  if (evidence.runId !== runBinding.runId
      || evidence.challenge !== runBinding.challenge
      || evidence.signer.publicKeySpkiSha256
        !== runBinding.signerSpkiSha256
      || !isDeepStrictEqual(evidence.release, runBinding.release)
      || !isDeepStrictEqual(evidence.geometry, runBinding.geometry)
      || !isDeepStrictEqual(evidence.profile, runBinding.profile)) {
    fail('PHASE5_FAULT_RUN_BINDING_MISMATCH');
  }
}

function semanticsInput(evidence) {
  return {
    scenarioEvents: evidence.scenarioEvents.map((event) => ({
      scenario: event.scenario,
      phase: event.phase,
      atMonotonicMs: event.atMonotonicMs,
      payload: event.payload,
    })),
  };
}

function stateAt(projection, scenario, phase) {
  const event = projection.stateEvents.find((candidate) => (
    candidate.scenario === scenario && candidate.phase === phase
  ));
  if (event === undefined) {
    fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
  }
  return event.state;
}

function exactEgressPayload(payload, state) {
  return payload.generation === state.generation
    && payload.capacityEntries === state.capacityEntries
    && payload.queuedEntries === state.queuedEntries
    && payload.inFlight === 0
    && payload.closed === state.closed
    && payload.closeCode === state.closeCode
    && payload.closeReason === state.closeReason;
}

function exactWorkerPayload(payload, state) {
  return isDeepStrictEqual(payload, state);
}

function neutralObservation(event, baseline) {
  if (event.type === 'runtime.snapshot' || event.type === 'audio.pcm') {
    return true;
  }
  if (event.type === 'runtime.egress') {
    return exactEgressPayload(
      event.payload,
      baseline.egress[event.client - 1],
    );
  }
  if (event.type === 'worker.sample') {
    return exactWorkerPayload(event.payload, baseline.worker);
  }
  if (event.type === 'agent.start') {
    return event.payload.source === 'real';
  }
  if (event.type === 'agent.settle') {
    return event.payload.source === 'real' && event.payload.status === 'ok';
  }
  return false;
}

function effect(type, client, match = () => true) {
  return { type, client, match };
}

function discontinuityEffect(clientId, state) {
  const audio = state.audioClients[clientId - 1];
  return effect('audio.discontinuity', clientId, (payload) => (
    payload.generation === audio.generation
      && payload.audioEpoch === audio.audioEpoch
      && payload.blockSeq === 0
      && payload.resumeStartFrame === '0'
      && payload.scope === 'stream'
  ));
}

function agentStartEffect(result) {
  return effect('agent.start', 0, (payload) => (
    payload.requestId === result.requestId
      && payload.source === result.source
      && payload.model === result.model
      && payload.attempts === result.attempts
      && payload.startedAtMonotonicMs === result.startedAtMonotonicMs
  ));
}

function agentSettleEffect(result) {
  return effect('agent.settle', 0, (payload) => (
    isDeepStrictEqual(payload, result)
  ));
}

function egressEffect(state) {
  return effect('runtime.egress', 4, (payload) => (
    exactEgressPayload(payload, state.egress[3])
  ));
}

function runtimeCloseEffect(state, code, reason) {
  return effect('runtime.close', 4, (payload) => (
    payload.generation === state.runtimeClients[3].generation
      && payload.code === code
      && payload.reason === reason
  ));
}

function runtimeOpenEffect(state) {
  return effect('runtime.open', 4, (payload) => (
    payload.generation === state.runtimeClients[3].generation
      && payload.mode === 'resume'
  ));
}

function runtimeReadyEffect(state) {
  return effect('runtime.ready', 4, (payload) => (
    payload.generation === state.runtimeClients[3].generation
      && payload.worldGeneration === state.world.worldGeneration
  ));
}

function expectedEffects(scenario, before, fault, recovery) {
  if (scenario === 'worker-crash-restart') {
    return {
      fault: [
        effect('worker.sample', 0, (payload) => (
          exactWorkerPayload(payload, fault.worker)
        )),
      ],
      recovery: [
        effect('worker.sample', 0, (payload) => (
          exactWorkerPayload(payload, recovery.worker)
        )),
        ...[1, 2, 3, 4].map((clientId) => (
          discontinuityEffect(clientId, recovery)
        )),
      ],
    };
  }
  if (scenario === 'runtime-reconnect') {
    return {
      fault: [
        egressEffect(fault),
        runtimeCloseEffect(before, 1_000, 'PHASE5_RUNTIME_RECONNECT'),
      ],
      recovery: [
        egressEffect(recovery),
        runtimeOpenEffect(recovery),
        runtimeReadyEffect(recovery),
      ],
    };
  }
  if (scenario === 'slow-client') {
    return {
      fault: [
        effect('audio.pause', 4, (payload) => (
          payload.generation === fault.audioClients[3].generation
        )),
      ],
      recovery: [
        effect('audio.resume', 4, (payload) => (
          payload.generation === recovery.audioClients[3].generation
        )),
      ],
    };
  }
  if (scenario === 'queue-pressure') {
    return {
      fault: [
        egressEffect(fault),
        runtimeCloseEffect(before, 4_410, 'EGRESS_OVERFLOW'),
      ],
      recovery: [
        egressEffect(recovery),
        runtimeOpenEffect(recovery),
        runtimeReadyEffect(recovery),
      ],
    };
  }
  if (scenario === 'agent-timeout'
      || scenario === 'agent-malformed-response') {
    return {
      fault: [
        agentStartEffect(fault.provider.lastResult),
        agentSettleEffect(fault.provider.lastResult),
      ],
      recovery: [
        agentStartEffect(recovery.provider.lastResult),
        agentSettleEffect(recovery.provider.lastResult),
      ],
    };
  }
  return {
    fault: [
      effect('worker.sample', 0, (payload) => (
        exactWorkerPayload(payload, fault.worker)
      )),
      ...[1, 2, 3, 4].map((clientId) => (
        discontinuityEffect(clientId, fault)
      )),
    ],
    recovery: [],
  };
}

function consumeInterval(
  evidence,
  startPrefix,
  endPrefix,
  baseline,
  expected,
  phase,
) {
  let expectedIndex = 0;
  let observationEventCount = 0;
  const effects = [];
  for (let index = startPrefix; index < endPrefix; index += 1) {
    const event = evidence.transportEvents[index];
    const candidate = expected[expectedIndex];
    if (candidate !== undefined
        && event.type === candidate.type
        && event.client === candidate.client
        && candidate.match(event.payload)) {
      effects.push({
        phase,
        sequence: event.sequence,
        type: event.type,
        client: event.client,
      });
      expectedIndex += 1;
    } else if (neutralObservation(event, baseline)) {
      observationEventCount += 1;
    } else {
      fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
    }
  }
  if (expectedIndex !== expected.length) {
    fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
  }
  return { effects, observationEventCount };
}

function validateNeutralGap(evidence, startPrefix, endPrefix, baseline) {
  for (let index = startPrefix; index < endPrefix; index += 1) {
    if (!neutralObservation(evidence.transportEvents[index], baseline)) {
      fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
    }
  }
}

function validatePrelude(evidence, endPrefix) {
  const seen = Array.from({ length: 4 }, () => ({
    runtimeOpen: false,
    runtimeReady: false,
    runtimeSnapshot: false,
    runtimeEgress: false,
    audioOpen: false,
    audioReady: false,
    audioPcm: false,
  }));
  let worker = null;
  for (let index = 0; index < endPrefix; index += 1) {
    const event = evidence.transportEvents[index];
    const client = event.client === 0 ? null : seen[event.client - 1];
    if (event.type === 'runtime.open') {
      if (client.runtimeOpen || event.payload.mode !== 'bootstrap') {
        fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
      }
      client.runtimeOpen = true;
    } else if (event.type === 'runtime.ready') {
      if (client.runtimeReady) {
        fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
      }
      client.runtimeReady = true;
    } else if (event.type === 'runtime.snapshot') {
      client.runtimeSnapshot = true;
    } else if (event.type === 'runtime.egress') {
      if (event.payload.queuedEntries !== 0
          || event.payload.inFlight !== 0
          || event.payload.closed
          || event.payload.closeCode !== null
          || event.payload.closeReason !== null) {
        fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
      }
      client.runtimeEgress = true;
    } else if (event.type === 'audio.open') {
      if (client.audioOpen) {
        fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
      }
      client.audioOpen = true;
    } else if (event.type === 'audio.ready') {
      if (client.audioReady) {
        fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
      }
      client.audioReady = true;
    } else if (event.type === 'audio.pcm') {
      client.audioPcm = true;
    } else if (event.type === 'worker.sample') {
      if (!event.payload.ready
          || event.payload.recovering
          || event.payload.restartCount !== 0
          || event.payload.supervisorGeneration !== 1
          || event.payload.lastExitedPid !== null
          || event.payload.lastExitSignal !== null
          || (worker !== null
            && !exactWorkerPayload(event.payload, worker))) {
        fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
      }
      worker = event.payload;
    } else if (event.type === 'agent.start') {
      if (event.payload.source !== 'real') {
        fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
      }
    } else if (event.type === 'agent.settle') {
      if (event.payload.source !== 'real'
          || event.payload.status !== 'ok') {
        fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
      }
    } else {
      fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
    }
  }
  if (worker === null || seen.some((client) => (
    !Object.values(client).every(Boolean)
  ))) {
    fail('PHASE5_FAULT_EFFECT_LEDGER_INVALID');
  }
}

function buildEffectLedger(evidence, projection) {
  const ledger = [];
  validatePrelude(
    evidence,
    evidence.scenarioEvents[0].transportPrefixCount,
  );
  for (let scenarioIndex = 0;
    scenarioIndex < SCENARIOS.length;
    scenarioIndex += 1) {
    const plan = SCENARIOS[scenarioIndex];
    const offset = scenarioIndex * 5;
    const events = evidence.scenarioEvents.slice(offset, offset + 5);
    const before = stateAt(projection, plan.scenario, 'before');
    const fault = stateAt(projection, plan.scenario, 'fault-observed');
    const recovery = stateAt(
      projection,
      plan.scenario,
      'recovery-observed',
    );
    const expected = expectedEffects(plan.scenario, before, fault, recovery);
    validateNeutralGap(
      evidence,
      events[0].transportPrefixCount,
      events[1].transportPrefixCount,
      before,
    );
    const faultResult = consumeInterval(
      evidence,
      events[1].transportPrefixCount,
      events[2].transportPrefixCount,
      before,
      expected.fault,
      'fault',
    );
    validateNeutralGap(
      evidence,
      events[2].transportPrefixCount,
      events[3].transportPrefixCount,
      fault,
    );
    const recoveryResult = consumeInterval(
      evidence,
      events[3].transportPrefixCount,
      events[4].transportPrefixCount,
      fault,
      expected.recovery,
      'recovery',
    );
    if (scenarioIndex + 1 < SCENARIOS.length) {
      const nextBefore = evidence.scenarioEvents[offset + 5];
      validateNeutralGap(
        evidence,
        events[4].transportPrefixCount,
        nextBefore.transportPrefixCount,
        recovery,
      );
    }
    ledger.push({
      scenario: plan.scenario,
      passed: true,
      recoveryDurationMs:
        events[4].atMonotonicMs - events[1].atMonotonicMs,
      recoverySloMs: plan.recoverySloMs,
      faultAction: {
        operation: events[1].payload.action.operation,
        target: events[1].payload.action.target,
        atMonotonicMs: events[1].atMonotonicMs,
      },
      recoveryAction: {
        operation: events[3].payload.action.operation,
        target: events[3].payload.action.target,
        atMonotonicMs: events[3].atMonotonicMs,
      },
      observationEventCount:
        faultResult.observationEventCount
          + recoveryResult.observationEventCount,
      effects: [...faultResult.effects, ...recoveryResult.effects],
    });
  }
  return ledger;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneRelease(release) {
  return {
    releaseManifestSha256: release.releaseManifestSha256,
    releaseRevision: release.releaseRevision,
    sourceManifestSha256: release.sourceManifestSha256,
    audioArtifactSha256: release.audioArtifactSha256,
  };
}

function cloneGeometry(geometry) {
  return {
    sampleRate: geometry.sampleRate,
    blockFrames: geometry.blockFrames,
    poolSize: geometry.poolSize,
    rowVoices: [...geometry.rowVoices],
  };
}

function cloneProfile(profile) {
  return {
    clients: profile.clients,
    slowClient: profile.slowClient,
    durationMinutes: profile.durationMinutes,
    speciesEndpoint: profile.speciesEndpoint,
    speciesModel: profile.speciesModel,
  };
}

function cloneWindow(window) {
  return {
    startedAtMonotonicMs: window.startedAtMonotonicMs,
    endedAtMonotonicMs: window.endedAtMonotonicMs,
    startedAtUnixMs: window.startedAtUnixMs,
    endedAtUnixMs: window.endedAtUnixMs,
  };
}

function validatorOwnedSnapshot(value, code) {
  try {
    const canonical = canonicalJson(value);
    return {
      canonical,
      value: JSON.parse(canonical),
    };
  } catch {
    fail(code);
  }
}

function validatePhase5FaultEvidenceOwned(evidence, runBinding) {
  const bindingSnapshot = validatorOwnedSnapshot(
    runBinding,
    'PHASE5_FAULT_RUN_BINDING_INVALID',
  );
  validateRunBinding(bindingSnapshot.value);
  const evidenceSnapshot = validatorOwnedSnapshot(
    evidence,
    'PHASE5_FAULT_EVIDENCE_SHAPE_INVALID',
  );
  const trustedBinding = bindingSnapshot.value;
  const signedEvidence = evidenceSnapshot.value;

  validateSignedFaultEventEvidence(signedEvidence, {
    expectedSignerSpkiSha256: trustedBinding.signerSpkiSha256,
  });
  validateCrossBinding(signedEvidence, trustedBinding);
  const projection = projectPhase5FaultTransport(signedEvidence);
  const input = semanticsInput(signedEvidence);
  validateFaultScenarioSemantics(input, projection);
  const ledger = buildEffectLedger(signedEvidence, projection);

  const faultValidation = deepFreeze({
    schemaVersion: 1,
    kind: 'phase5-fault-validation-result',
    passed: true,
    runId: trustedBinding.runId,
    challenge: trustedBinding.challenge,
    release: cloneRelease(trustedBinding.release),
    geometry: cloneGeometry(trustedBinding.geometry),
    profile: cloneProfile(trustedBinding.profile),
    window: cloneWindow(signedEvidence.window),
    signerSpkiSha256: trustedBinding.signerSpkiSha256,
    faultSessionEvidenceSha256:
      trustedBinding.faultSessionEvidenceSha256,
    evidence: {
      schemaVersion: signedEvidence.schemaVersion,
      faultEventsSha256: createHash('sha256')
        .update(Buffer.from(evidenceSnapshot.canonical, 'utf8'))
        .digest('hex'),
      scenarioEventCount: signedEvidence.scenarioEvents.length,
      transportEventCount: signedEvidence.transportEvents.length,
      projectedStateCount: projection.stateEvents.length,
      unexpectedStabilityFailureCount: 0,
      eventChainSha256: signedEvidence.eventChainSha256,
      transportChainSha256: signedEvidence.transportChainSha256,
    },
    ledger,
  });
  const neutralTransportProjection =
    projectPhase5ClientObservationsTransport(signedEvidence);
  const signedTransportProjection = deepFreeze({
    ...neutralTransportProjection,
    kind: 'phase5-client-observations-signed-transport-projection',
  });
  return {
    faultValidation,
    signedTransportProjection,
  };
}

export function validatePhase5FaultEvidence(evidence, runBinding) {
  return validatePhase5FaultEvidenceOwned(
    evidence,
    runBinding,
  ).faultValidation;
}

export function validatePhase5FaultEvidenceWithClientProjection(
  evidence,
  runBinding,
) {
  const {
    faultValidation,
    signedTransportProjection,
  } = validatePhase5FaultEvidenceOwned(evidence, runBinding);
  return deepFreeze({
    schemaVersion: 1,
    kind: 'phase5-fault-validation-with-client-projection-result',
    faultValidation,
    signedTransportProjection,
  });
}
