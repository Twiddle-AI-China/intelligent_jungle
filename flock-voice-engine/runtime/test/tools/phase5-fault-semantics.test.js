import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAULT_ACTUATOR_PLAN,
  validateFaultScenarioSemantics,
} from '../../tools/lib/phase5-fault-semantics.mjs';

const SCENARIOS = Object.freeze([
  ['worker-crash-restart', 15_000],
  ['runtime-reconnect', 5_000],
  ['slow-client', 7_000],
  ['queue-pressure', 5_000],
  ['agent-timeout', 15_000],
  ['agent-malformed-response', 15_000],
  ['audio-epoch-discontinuity', 10_000],
]);
const PHASES = Object.freeze([
  'before',
  'fault-action',
  'fault-observed',
  'recovery-action',
  'recovery-observed',
]);
const ACTION_CONTRACTS = Object.freeze([
  ['signal-worker', 'candidate-audio-worker'],
  ['await-supervisor-ready', 'candidate-audio-supervisor'],
  ['disconnect-runtime', 'runtime-client-4'],
  ['reconnect-runtime', 'runtime-client-4'],
  ['pause-audio', 'audio-client-4'],
  ['resume-audio', 'audio-client-4'],
  ['saturate-egress', 'egress-client-4'],
  ['reconnect-egress', 'egress-client-4'],
  ['inject-provider-timeout', 'bird_agent'],
  ['clear-provider-timeout', 'bird_agent'],
  ['inject-provider-malformed-response', 'bird_agent'],
  ['clear-provider-malformed-response', 'bird_agent'],
  ['rotate-audio-epoch', 'candidate-audio-worker'],
  ['settle-audio-epoch', 'all-audio-clients'],
]);
const TIMEOUT_FIXTURE_ID = 'phase5-timeout-hold-open-v1';
const TIMEOUT_FIXTURE_SHA256 =
  '12baea86a4fdc350efbfaea53fde6f60b330db5292e860c84a9bef4606eac598';

function baseState(tick) {
  return {
    world: {
      worldGeneration: 'world-generation-a',
      revision: tick,
      eventSeq: tick + 10_000,
    },
    runtimeClients: Array.from({ length: 4 }, (_, index) => ({
      clientId: index + 1,
      connected: true,
      generation: 10 + index,
      snapshotWorldGeneration: 'world-generation-a',
    })),
    audioClients: Array.from({ length: 4 }, (_, index) => ({
      clientId: index + 1,
      connected: true,
      generation: 20 + index,
      audioEpoch: 'audio-epoch-a',
      pcmCursorFrames: 10_000 * (index + 1),
      discontinuityCount: 2,
      paused: false,
    })),
    worker: {
      pid: 500,
      ready: true,
      recovering: false,
      audioEpoch: 'audio-epoch-a',
      restartCount: 2,
      supervisorGeneration: 10,
      lastExitedPid: null,
      lastExitSignal: null,
    },
    egress: Array.from({ length: 4 }, (_, index) => ({
      clientId: index + 1,
      generation: 10 + index,
      queuedEntries: 0,
      capacityEntries: 256,
      closed: false,
      closeCode: null,
      closeReason: null,
    })),
    provider: {
      lastResult: null,
    },
  };
}

function scenarioStates(scenario, scenarioIndex, previousRecovery) {
  const before = previousRecovery === null
    ? baseState(1_000)
    : structuredClone(previousRecovery);
  if (previousRecovery !== null) {
    before.world.revision += 8;
    before.world.eventSeq += 8;
    for (const client of before.audioClients) {
      client.pcmCursorFrames += 4_096;
    }
  }
  const fault = structuredClone(before);
  const recovery = structuredClone(before);
  fault.world.revision += 1;
  fault.world.eventSeq += 1;
  recovery.world.revision += 2;
  recovery.world.eventSeq += 2;

  if (scenario === 'worker-crash-restart') {
    fault.worker.pid = null;
    fault.worker.ready = false;
    fault.worker.recovering = true;
    fault.worker.supervisorGeneration += 1;
    fault.worker.lastExitedPid = before.worker.pid;
    fault.worker.lastExitSignal = 'SIGKILL';
    recovery.worker.pid = 501;
    recovery.worker.recovering = false;
    recovery.worker.audioEpoch = 'audio-epoch-b';
    recovery.worker.restartCount += 1;
    recovery.worker.supervisorGeneration += 1;
    recovery.worker.lastExitedPid = before.worker.pid;
    recovery.worker.lastExitSignal = 'SIGKILL';
    for (const client of recovery.audioClients) {
      client.audioEpoch = 'audio-epoch-b';
      client.pcmCursorFrames = 4_096;
      client.discontinuityCount += 1;
    }
  } else if (scenario === 'runtime-reconnect') {
    fault.runtimeClients[3].connected = false;
    fault.runtimeClients[3].snapshotWorldGeneration = null;
    fault.egress[3].closed = true;
    fault.egress[3].closeCode = 1_000;
    fault.egress[3].closeReason = 'PHASE5_RUNTIME_RECONNECT';
    recovery.runtimeClients[3].generation += 1;
    recovery.egress[3].generation += 1;
    for (let index = 0; index < 4; index += 1) {
      fault.audioClients[index].pcmCursorFrames += 4_096;
      recovery.audioClients[index].pcmCursorFrames += 8_192;
    }
  } else if (scenario === 'slow-client') {
    fault.audioClients[3].paused = true;
    recovery.audioClients[3].pcmCursorFrames += 4_096;
    for (let index = 0; index < 3; index += 1) {
      fault.audioClients[index].pcmCursorFrames += 4_096;
      recovery.audioClients[index].pcmCursorFrames += 8_192;
    }
  } else if (scenario === 'queue-pressure') {
    fault.egress[3].queuedEntries = fault.egress[3].capacityEntries;
    fault.egress[3].closed = true;
    fault.egress[3].closeCode = 4_410;
    fault.egress[3].closeReason = 'EGRESS_OVERFLOW';
    fault.runtimeClients[3].connected = false;
    fault.runtimeClients[3].snapshotWorldGeneration = null;
    recovery.egress[3].generation += 1;
    recovery.runtimeClients[3].generation += 1;
    for (let index = 0; index < 4; index += 1) {
      fault.audioClients[index].pcmCursorFrames += 4_096;
      recovery.audioClients[index].pcmCursorFrames += 8_192;
    }
  } else if (scenario === 'agent-timeout') {
    fault.provider.lastResult = {
      requestId: 'injected-timeout-1',
      source: 'injected',
      model: 'bird_agent',
      status: 'timeout',
      reason: 'ATTEMPT_TIMEOUT',
      attempts: 1,
      startedAtMonotonicMs: 90_100,
      settledAtMonotonicMs: 102_100,
      httpStatus: null,
    };
    recovery.provider.lastResult = {
      requestId: 'real-timeout-recovery-1',
      source: 'real',
      model: 'bird_agent',
      status: 'ok',
      reason: null,
      attempts: 1,
      startedAtMonotonicMs: 102_200,
      settledAtMonotonicMs: 102_700,
      httpStatus: 200,
    };
    for (let index = 0; index < 4; index += 1) {
      fault.audioClients[index].pcmCursorFrames += 4_096;
      recovery.audioClients[index].pcmCursorFrames += 8_192;
    }
  } else if (scenario === 'agent-malformed-response') {
    fault.provider.lastResult = {
      requestId: 'injected-malformed-1',
      source: 'injected',
      model: 'bird_agent',
      status: 'invalid_output',
      reason: 'INVALID_OUTPUT',
      attempts: 1,
      startedAtMonotonicMs: 110_100,
      settledAtMonotonicMs: 110_500,
      httpStatus: 200,
    };
    recovery.provider.lastResult = {
      requestId: 'real-malformed-recovery-1',
      source: 'real',
      model: 'bird_agent',
      status: 'ok',
      reason: null,
      attempts: 1,
      startedAtMonotonicMs: 110_600,
      settledAtMonotonicMs: 111_100,
      httpStatus: 200,
    };
    for (let index = 0; index < 4; index += 1) {
      fault.audioClients[index].pcmCursorFrames += 4_096;
      recovery.audioClients[index].pcmCursorFrames += 8_192;
    }
  } else if (scenario === 'audio-epoch-discontinuity') {
    fault.worker.audioEpoch = 'audio-epoch-c';
    recovery.worker.audioEpoch = 'audio-epoch-c';
    for (let index = 0; index < 4; index += 1) {
      fault.audioClients[index].audioEpoch = 'audio-epoch-c';
      fault.audioClients[index].discontinuityCount += 1;
      fault.audioClients[index].pcmCursorFrames = 0;
      recovery.audioClients[index].audioEpoch = 'audio-epoch-c';
      recovery.audioClients[index].discontinuityCount += 1;
      recovery.audioClients[index].pcmCursorFrames = 4_096;
    }
  }
  return { before, fault, recovery };
}

function actionForSequence(actuatorSequence, states) {
  const { before, fault, recovery } = states;
  const [operation, target] = ACTION_CONTRACTS[actuatorSequence - 1];
  let receipt;
  if (actuatorSequence === 1) {
    receipt = {
      actuatorSequence,
      pid: before.worker.pid,
      signal: 'SIGKILL',
      supervisorGeneration: before.worker.supervisorGeneration,
      accepted: true,
    };
  } else if (actuatorSequence === 2) {
    receipt = {
      actuatorSequence,
      supervisorGeneration: recovery.worker.supervisorGeneration,
      observedPid: recovery.worker.pid,
      observedAudioEpoch: recovery.worker.audioEpoch,
      ready: recovery.worker.ready,
      recovering: recovery.worker.recovering,
      accepted: true,
    };
  } else if (actuatorSequence === 3) {
    receipt = {
      actuatorSequence,
      clientId: 4,
      beforeGeneration: before.runtimeClients[3].generation,
      closeCode: 1_000,
      closeReason: 'PHASE5_RUNTIME_RECONNECT',
      accepted: true,
    };
  } else if (actuatorSequence === 4) {
    receipt = {
      actuatorSequence,
      clientId: 4,
      beforeGeneration: before.runtimeClients[3].generation,
      afterGeneration: recovery.runtimeClients[3].generation,
      snapshotWorldGeneration:
        recovery.runtimeClients[3].snapshotWorldGeneration,
      accepted: true,
    };
  } else if (actuatorSequence === 5) {
    receipt = {
      actuatorSequence,
      clientId: 4,
      beforePaused: before.audioClients[3].paused,
      afterPaused: fault.audioClients[3].paused,
      accepted: true,
    };
  } else if (actuatorSequence === 6) {
    receipt = {
      actuatorSequence,
      clientId: 4,
      beforePaused: fault.audioClients[3].paused,
      afterPaused: recovery.audioClients[3].paused,
      accepted: true,
    };
  } else if (actuatorSequence === 7) {
    receipt = {
      actuatorSequence,
      clientId: 4,
      capacityEntries: fault.egress[3].capacityEntries,
      acceptedEntries: fault.egress[3].capacityEntries,
      rejectedEntries: 1,
      closeCode: fault.egress[3].closeCode,
      closeReason: fault.egress[3].closeReason,
    };
  } else if (actuatorSequence === 8) {
    receipt = {
      actuatorSequence,
      clientId: 4,
      beforeGeneration: before.egress[3].generation,
      afterGeneration: recovery.egress[3].generation,
      accepted: true,
    };
  } else if (actuatorSequence === 9 || actuatorSequence === 11) {
    receipt = {
      actuatorSequence,
      requestId: fault.provider.lastResult.requestId,
      fixture: fault.provider.lastResult.status === 'timeout'
        ? 'timeout'
        : 'malformed-response',
      accepted: true,
    };
    if (actuatorSequence === 9) {
      receipt.fixtureId = TIMEOUT_FIXTURE_ID;
      receipt.fixtureSha256 = TIMEOUT_FIXTURE_SHA256;
      receipt.attemptTimeoutMs = 12_000;
      receipt.deadlineMs = 15_000;
      receipt.idleAdmission = true;
    }
  } else if (actuatorSequence === 10 || actuatorSequence === 12) {
    receipt = {
      actuatorSequence,
      fixture: fault.provider.lastResult.status === 'timeout'
        ? 'timeout'
        : 'malformed-response',
      realRequestId: recovery.provider.lastResult.requestId,
      accepted: true,
    };
  } else if (actuatorSequence === 13) {
    receipt = {
      actuatorSequence,
      beforeAudioEpoch: before.worker.audioEpoch,
      afterAudioEpoch: fault.worker.audioEpoch,
      accepted: true,
    };
  } else {
    receipt = {
      actuatorSequence,
      audioEpoch: recovery.worker.audioEpoch,
      clientCount: recovery.audioClients.length,
      accepted: true,
    };
  }
  return { operation, target, receipt };
}

function fixture() {
  let actuatorSequence = 1;
  let previousRecovery = null;
  const scenarioEvents = SCENARIOS.flatMap(([scenario], scenarioIndex) => {
    const states = scenarioStates(scenario, scenarioIndex, previousRecovery);
    const { before, fault, recovery } = states;
    previousRecovery = recovery;
    const base = 10_000 + scenarioIndex * 20_000;
    let offsets = [0, 100, 200, 300, 1_000];
    if (scenario === 'slow-client') {
      offsets = [0, 100, 2_100, 2_200, 3_000];
    } else if (scenario === 'agent-timeout') {
      offsets = [0, 100, 12_100, 12_200, 12_800];
    } else if (scenario === 'agent-malformed-response') {
      offsets = [0, 100, 500, 600, 1_200];
    }
    const phaseStates = [before, null, fault, null, recovery];
    return PHASES.map((phase, phaseIndex) => {
      const event = {
        scenario,
        phase,
        atMonotonicMs: base + offsets[phaseIndex],
      };
      if (phase.endsWith('action')) {
        event.payload = {
          kind: 'action',
          action: actionForSequence(actuatorSequence, states),
        };
        actuatorSequence += 1;
      } else {
        event.payload = {
          kind: 'state',
          state: phaseStates[phaseIndex],
        };
      }
      return event;
    });
  });
  return { scenarioEvents };
}

function eventAt(input, scenario, phase) {
  return input.scenarioEvents.find((event) => (
    event.scenario === scenario && event.phase === phase
  ));
}

function stateAt(input, scenario, phase) {
  return eventAt(input, scenario, phase).payload.state;
}

function transportProjection(input) {
  return {
    schemaVersion: 1,
    kind: 'phase5-fault-transport-projection',
    stateEvents: input.scenarioEvents
      .filter(({ phase }) => !phase.endsWith('action'))
      .map(({ scenario, phase, atMonotonicMs, payload }) => ({
        scenario,
        phase,
        atMonotonicMs,
        state: structuredClone(payload.state),
      })),
  };
}

function validate(input, projection = transportProjection(input)) {
  return validateFaultScenarioSemantics(input, projection);
}

test('freezes fourteen fixed-target receipt-bearing actions and accepts typed seven-scenario evidence', () => {
  assert.deepEqual(
    FAULT_ACTUATOR_PLAN.map(({
      actuatorSequence,
      scenario,
      phase,
      operation,
      target,
    }) => (
      [actuatorSequence, scenario, phase, operation, target]
    )),
    SCENARIOS.flatMap(([scenario], index) => [
      [
        index * 2 + 1,
        scenario,
        'fault-action',
        ...ACTION_CONTRACTS[index * 2],
      ],
      [
        index * 2 + 2,
        scenario,
        'recovery-action',
        ...ACTION_CONTRACTS[index * 2 + 1],
      ],
    ]),
  );
  const input = fixture();
  assert.equal(validate(input), input);
});

test('rejects marker payloads, empty payloads and the wrong payload kind', () => {
  for (const payload of [
    { marker: 'looks-successful' },
    {},
    { kind: 'state', state: {} },
    { kind: 'action', action: {} },
  ]) {
    const input = fixture();
    input.scenarioEvents[0].payload = payload;
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_(?:PAYLOAD|STATE)_INVALID/,
    );
  }
});

test('rejects operation/receipt tampering and every arbitrary actuator argument', () => {
  for (const mutate of [
    (action) => { action.receipt.actuatorSequence = 2; },
    (action) => { action.operation = 'run-shell'; },
    (action) => { action.target = 'production-audio-worker'; },
    (action) => { action.shell = 'kill -9 1'; },
    (action) => { action.container = 'production'; },
    (action) => { action.receipt.shell = 'kill -9 1'; },
  ]) {
    const input = fixture();
    mutate(input.scenarioEvents[1].payload.action);
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_ACTION(?:_RECEIPT)?_INVALID/,
    );
  }
});

test('all fourteen receipts are exact and bound to the observed transition', () => {
  const attacks = [
    (receipt) => { receipt.pid += 1; },
    (receipt) => { receipt.observedPid += 1; },
    (receipt) => { receipt.closeCode = 4_411; },
    (receipt) => { receipt.afterGeneration += 1; },
    (receipt) => { receipt.afterPaused = false; },
    (receipt) => { receipt.beforePaused = false; },
    (receipt) => { receipt.acceptedEntries -= 1; },
    (receipt) => { receipt.afterGeneration -= 1; },
    (receipt) => { receipt.requestId = 'other-timeout-request'; },
    (receipt) => { receipt.realRequestId = 'other-real-request'; },
    (receipt) => { receipt.requestId = 'other-malformed-request'; },
    (receipt) => { receipt.realRequestId = 'other-real-request'; },
    (receipt) => { receipt.afterAudioEpoch = 'forged-audio-epoch'; },
    (receipt) => { receipt.clientCount = 3; },
  ];
  for (const [index, attack] of attacks.entries()) {
    const input = fixture();
    const actionEvents = input.scenarioEvents.filter(({ phase }) => (
      phase.endsWith('action')
    ));
    attack(actionEvents[index].payload.action.receipt);
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_ACTION_RECEIPT_INVALID/,
      `actuator receipt ${index + 1}`,
    );
  }
});

test('timeout receipt freezes the admitted 12s/15s fixture identity', () => {
  const attacks = [
    (receipt) => { receipt.fixtureId = 'other-timeout-fixture'; },
    (receipt) => { receipt.fixtureSha256 = '0'.repeat(64); },
    (receipt) => { receipt.attemptTimeoutMs = 11_999; },
    (receipt) => { receipt.deadlineMs = 14_999; },
    (receipt) => { receipt.idleAdmission = false; },
    (receipt) => { receipt.idleAdmission = 1; },
  ];
  for (const attack of attacks) {
    const input = fixture();
    const receipt = input.scenarioEvents
      .filter(({ phase }) => phase.endsWith('action'))[8]
      .payload.action.receipt;
    attack(receipt);
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_ACTION_RECEIPT_INVALID/,
    );
  }
});

test('validates exact state types, ordered client sets and integer fields', () => {
  const attacks = [
    (state) => { state.extra = true; },
    (state) => { state.world.revision = true; },
    (state) => { state.world.worldGeneration = ''; },
    (state) => { state.world.eventSeq = 1.5; },
    (state) => { state.audioClients[0].audioEpoch = 30; },
    (state) => { state.worker.audioEpoch = ''; },
    (state) => { state.worker.pid = 500.5; },
    (state) => { state.worker.recovering = 0; },
    (state) => { state.worker.supervisorGeneration = true; },
    (state) => { state.worker.lastExitedPid = '500'; },
    (state) => { state.worker.lastExitSignal = 'SIGTERM'; },
    (state) => { delete state.worker.recovering; },
    (state) => { state.runtimeClients[0].clientId = 2; },
    (state) => { state.audioClients.pop(); },
    (state) => {
      state.egress[0].capacityEntries = 8_192;
    },
    (state) => { state.provider.lastResult = {}; },
  ];
  for (const attack of attacks) {
    const input = fixture();
    attack(input.scenarioEvents[0].payload.state);
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_STATE_INVALID/,
    );
  }
});

test('accepts a legal prior shared real provider success before the target request', () => {
  const input = fixture();
  stateAt(input, 'agent-timeout', 'before').provider.lastResult = {
    requestId: 'prior-shared-real-success',
    source: 'real',
    model: 'bird_agent',
    status: 'ok',
    reason: null,
    attempts: 1,
    startedAtMonotonicMs: 88_000,
    settledAtMonotonicMs: 88_500,
    httpStatus: 200,
  };
  assert.equal(validate(input), input);
});

test('worker crash requires old/new pid, one restart, a new epoch and no world rebuild', () => {
  const attacks = [
    (before, fault) => { fault.worker.pid = before.worker.pid; },
    (_before, fault) => { fault.worker.ready = true; },
    (_before, fault) => { fault.worker.recovering = false; },
    (before, fault) => {
      fault.worker.supervisorGeneration = before.worker.supervisorGeneration;
    },
    (_before, fault) => { fault.worker.lastExitedPid = null; },
    (_before, fault) => { fault.worker.lastExitSignal = null; },
    (before, _fault, recovery) => { recovery.worker.pid = before.worker.pid; },
    (_before, _fault, recovery) => { recovery.worker.recovering = true; },
    (before, _fault, recovery) => {
      recovery.worker.audioEpoch = before.worker.audioEpoch;
    },
    (before, _fault, recovery) => {
      recovery.worker.restartCount = before.worker.restartCount;
    },
    (before, _fault, recovery) => {
      recovery.world.worldGeneration = 'world-generation-forged';
    },
    (_before, fault, recovery) => {
      recovery.audioClients[0].pcmCursorFrames = 0;
    },
    (before, _fault, recovery) => {
      recovery.audioClients[3].discontinuityCount =
        before.audioClients[3].discontinuityCount;
    },
  ];
  for (const attack of attacks) {
    const input = fixture();
    attack(
      stateAt(input, 'worker-crash-restart', 'before'),
      stateAt(input, 'worker-crash-restart', 'fault-observed'),
      stateAt(input, 'worker-crash-restart', 'recovery-observed'),
    );
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_(?:STATE|WORKER_SEMANTICS)_INVALID/,
    );
  }
});

test('runtime reconnect changes only client 4 generation and restores its snapshot barrier', () => {
  const attacks = [
    (_before, fault) => { fault.runtimeClients[3].connected = true; },
    (_before, fault) => {
      fault.runtimeClients[3].snapshotWorldGeneration = 'world-generation-a';
    },
    (before, _fault, recovery) => {
      recovery.runtimeClients[3].generation = before.runtimeClients[3].generation;
    },
    (_before, _fault, recovery) => {
      recovery.runtimeClients[3].snapshotWorldGeneration = null;
    },
    (before, _fault, recovery) => {
      recovery.runtimeClients[0].generation = before.runtimeClients[0].generation + 1;
    },
    (_before, fault) => { fault.egress[3].closed = false; },
    (_before, fault) => { fault.egress[3].closeCode = 4_410; },
    (before, _fault, recovery) => {
      recovery.egress[3].generation = before.egress[3].generation;
    },
  ];
  for (const attack of attacks) {
    const input = fixture();
    attack(
      stateAt(input, 'runtime-reconnect', 'before'),
      stateAt(input, 'runtime-reconnect', 'fault-observed'),
      stateAt(input, 'runtime-reconnect', 'recovery-observed'),
    );
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_(?:STATE|RUNTIME_RECONNECT_SEMANTICS)_INVALID/,
    );
  }
});

test('slow client pauses for at least two seconds on one generation while hot clients advance', () => {
  const attacks = [
    (input) => {
      eventAt(input, 'slow-client', 'fault-observed').atMonotonicMs =
        eventAt(input, 'slow-client', 'fault-action').atMonotonicMs + 1_999;
    },
    (input) => {
      stateAt(input, 'slow-client', 'fault-observed').audioClients[3].paused = false;
    },
    (input) => {
      stateAt(input, 'slow-client', 'recovery-observed').audioClients[3].generation += 1;
    },
    (input) => {
      const before = stateAt(input, 'slow-client', 'before').audioClients[0];
      stateAt(input, 'slow-client', 'fault-observed')
        .audioClients[0].pcmCursorFrames = before.pcmCursorFrames;
    },
  ];
  for (const attack of attacks) {
    const input = fixture();
    attack(input);
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_SLOW_CLIENT_SEMANTICS_INVALID/,
    );
  }
});

test('queue pressure requires exact 4410/EGRESS_OVERFLOW and a new client 4 generation', () => {
  const attacks = [
    (_before, fault) => { fault.egress[3].queuedEntries -= 1; },
    (_before, fault) => { fault.egress[3].closeCode = 4_409; },
    (_before, fault) => { fault.egress[3].closeReason = 'overflow'; },
    (_before, fault) => { fault.egress[0].closed = true; },
    (_before, fault) => { fault.audioClients[3].connected = false; },
    (before, _fault, recovery) => {
      recovery.egress[3].generation = before.egress[3].generation;
    },
    (before, _fault, recovery) => {
      recovery.audioClients[3].generation = before.audioClients[3].generation + 1;
    },
  ];
  for (const attack of attacks) {
    const input = fixture();
    attack(
      stateAt(input, 'queue-pressure', 'before'),
      stateAt(input, 'queue-pressure', 'fault-observed'),
      stateAt(input, 'queue-pressure', 'recovery-observed'),
    );
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_(?:STATE|QUEUE_PRESSURE_SEMANTICS)_INVALID/,
    );
  }
});

test('rejects undeclared effects in every scenario even when projection repeats them', () => {
  const attacks = [
    {
      scenario: 'worker-crash-restart',
      code: /PHASE5_FAULT_WORKER_SEMANTICS_INVALID/,
      mutate(input) {
        const fault = stateAt(input, this.scenario, 'fault-observed').runtimeClients[0];
        fault.connected = false;
        fault.snapshotWorldGeneration = null;
        stateAt(input, this.scenario, 'recovery-observed')
          .runtimeClients[0].generation += 1;
      },
    },
    {
      scenario: 'runtime-reconnect',
      code: /PHASE5_FAULT_RUNTIME_RECONNECT_SEMANTICS_INVALID/,
      mutate(input) {
        stateAt(input, this.scenario, 'fault-observed').audioClients[3].connected = false;
      },
    },
    {
      scenario: 'runtime-reconnect',
      code: /PHASE5_FAULT_RUNTIME_RECONNECT_SEMANTICS_INVALID/,
      mutate(input) {
        for (const phase of ['fault-observed', 'recovery-observed']) {
          const audio = stateAt(input, this.scenario, phase).audioClients[3];
          audio.audioEpoch = 'undeclared-runtime-epoch';
          audio.discontinuityCount += 1;
        }
      },
    },
    {
      scenario: 'slow-client',
      code: /PHASE5_FAULT_SLOW_CLIENT_SEMANTICS_INVALID/,
      mutate(input) {
        const fault = stateAt(input, this.scenario, 'fault-observed').egress[0];
        fault.closed = true;
        fault.closeCode = 4_410;
        fault.closeReason = 'EGRESS_OVERFLOW';
        stateAt(input, this.scenario, 'recovery-observed').egress[0].generation += 1;
      },
    },
    {
      scenario: 'queue-pressure',
      code: /PHASE5_FAULT_QUEUE_PRESSURE_SEMANTICS_INVALID/,
      mutate(input) {
        for (const phase of ['fault-observed', 'recovery-observed']) {
          stateAt(input, this.scenario, phase).audioClients[0]
            .discontinuityCount += 1;
        }
      },
    },
    {
      scenario: 'agent-timeout',
      code: /PHASE5_FAULT_AGENT_SEMANTICS_INVALID/,
      mutate(input) {
        stateAt(input, this.scenario, 'fault-observed').audioClients[0].connected = false;
      },
    },
    {
      scenario: 'agent-malformed-response',
      code: /PHASE5_FAULT_AGENT_SEMANTICS_INVALID/,
      mutate(input) {
        for (const phase of ['fault-observed', 'recovery-observed']) {
          const worker = stateAt(input, this.scenario, phase).worker;
          worker.pid += 100;
          worker.restartCount += 1;
          worker.supervisorGeneration += 1;
        }
      },
    },
    {
      scenario: 'audio-epoch-discontinuity',
      code: /PHASE5_FAULT_AUDIO_EPOCH_SEMANTICS_INVALID/,
      mutate(input) {
        const fault = stateAt(input, this.scenario, 'fault-observed').egress[0];
        fault.closed = true;
        fault.closeCode = 4_410;
        fault.closeReason = 'EGRESS_OVERFLOW';
        stateAt(input, this.scenario, 'recovery-observed').egress[0].generation += 1;
      },
    },
  ];
  for (const attack of attacks) {
    const input = fixture();
    attack.mutate(input);
    assert.throws(() => validate(input), attack.code, attack.scenario);
  }
});

test('accepts only legal shared real provider successes outside target agent effects', () => {
  const input = fixture();
  const shared = {
    requestId: 'shared-runtime-success',
    source: 'real',
    model: 'bird_agent',
    status: 'ok',
    reason: null,
    attempts: 1,
    startedAtMonotonicMs: 30_100,
    settledAtMonotonicMs: 30_150,
    httpStatus: 200,
  };
  stateAt(input, 'runtime-reconnect', 'fault-observed').provider.lastResult =
    structuredClone(shared);
  for (const scenario of [
    'runtime-reconnect',
    'slow-client',
    'queue-pressure',
  ]) {
    for (const phase of ['before', 'fault-observed', 'recovery-observed']) {
      if (scenario === 'runtime-reconnect' && phase === 'before') continue;
      stateAt(input, scenario, phase).provider.lastResult = structuredClone(shared);
    }
  }
  stateAt(input, 'agent-timeout', 'before').provider.lastResult =
    structuredClone(shared);
  assert.equal(validate(input), input);

  const injected = fixture();
  stateAt(injected, 'runtime-reconnect', 'fault-observed').provider.lastResult = {
    ...shared,
    requestId: 'undeclared-injected-result',
    source: 'injected',
    status: 'timeout',
    reason: 'ATTEMPT_TIMEOUT',
    settledAtMonotonicMs: 42_100,
    httpStatus: null,
  };
  assert.throws(
    () => validate(injected),
    /PHASE5_FAULT_RUNTIME_RECONNECT_SEMANTICS_INVALID/,
  );
});

for (const scenario of ['agent-timeout', 'agent-malformed-response']) {
  test(`${scenario} requires the injected failure and a distinct real bird_agent success`, () => {
    const commonAttacks = [
      (_before, fault) => { fault.provider.lastResult.source = 'real'; },
      (_before, _fault, recovery) => { recovery.provider.lastResult = null; },
      (_before, fault, recovery) => {
        recovery.provider.lastResult.requestId =
          fault.provider.lastResult.requestId;
      },
      (_before, _fault, recovery) => {
        recovery.provider.lastResult.source = 'injected';
      },
      (_before, _fault, recovery) => {
        recovery.provider.lastResult.model = 'other';
      },
      (_before, _fault, recovery) => {
        recovery.provider.lastResult.status = 'invalid_output';
      },
      (_before, _fault, recovery) => {
        recovery.provider.lastResult.httpStatus = 201;
      },
      (before, _fault, recovery) => {
        recovery.world.revision = before.world.revision;
      },
    ];
    const scenarioAttacks = scenario === 'agent-timeout'
      ? [
        (_before, fault) => { fault.provider.lastResult.status = 'invalid_output'; },
        (_before, fault) => { fault.provider.lastResult.reason = 'DEADLINE_EXCEEDED'; },
        (_before, fault) => {
          fault.provider.lastResult.settledAtMonotonicMs =
            fault.provider.lastResult.startedAtMonotonicMs + 11_999;
        },
        (_before, fault) => { fault.provider.lastResult.httpStatus = 200; },
      ]
      : [
        (_before, fault) => { fault.provider.lastResult.status = 'timeout'; },
        (_before, fault) => { fault.provider.lastResult.reason = 'BAD_OUTPUT'; },
        (_before, fault) => { fault.provider.lastResult.httpStatus = null; },
      ];
    for (const attack of [...scenarioAttacks, ...commonAttacks]) {
      const input = fixture();
      const fault = stateAt(input, scenario, 'fault-observed');
      attack(
        stateAt(input, scenario, 'before'),
        fault,
        stateAt(input, scenario, 'recovery-observed'),
      );
      assert.throws(
        () => validate(input),
        /PHASE5_FAULT_(?:STATE|AGENT_SEMANTICS)_INVALID/,
      );
    }
  });
}

test('binds provider monotonic timestamps inside their signed scenario event window', () => {
  const attacks = [
    (input) => {
      const observed = eventAt(input, 'agent-timeout', 'fault-observed');
      const result = stateAt(input, 'agent-timeout', 'fault-observed')
        .provider.lastResult;
      result.settledAtMonotonicMs = observed.atMonotonicMs + 1;
    },
    (input) => {
      const action = eventAt(input, 'agent-timeout', 'recovery-action');
      const result = stateAt(input, 'agent-timeout', 'recovery-observed')
        .provider.lastResult;
      result.startedAtMonotonicMs = action.atMonotonicMs - 1;
    },
    (input) => {
      const observed = eventAt(input, 'agent-timeout', 'recovery-observed');
      const result = stateAt(input, 'agent-timeout', 'recovery-observed')
        .provider.lastResult;
      result.settledAtMonotonicMs = observed.atMonotonicMs + 1;
    },
    (input) => {
      const observed = eventAt(input, 'agent-malformed-response', 'fault-observed');
      const result = stateAt(input, 'agent-malformed-response', 'fault-observed')
        .provider.lastResult;
      result.startedAtMonotonicMs = observed.atMonotonicMs + 1;
      result.settledAtMonotonicMs = observed.atMonotonicMs + 2;
    },
  ];
  for (const attack of attacks) {
    const input = fixture();
    attack(input);
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_AGENT_SEMANTICS_INVALID/,
    );
  }
});

test('rejects rollback between one scenario recovery and the next before state', () => {
  const attacks = [
    (state) => { state.worker.restartCount -= 1; },
    (state) => { state.worker.supervisorGeneration -= 1; },
    (state) => { state.runtimeClients[0].generation -= 1; },
    (state) => { state.audioClients[0].discontinuityCount -= 1; },
    (state) => { state.audioClients[0].pcmCursorFrames -= 8_192; },
  ];
  for (const attack of attacks) {
    const input = fixture();
    attack(stateAt(input, 'runtime-reconnect', 'before'));
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_STATE_CONTINUITY_INVALID/,
    );
  }
});

test('epoch rotation yields exactly one discontinuity per client and then new-epoch PCM', () => {
  const attacks = [
    (before, fault) => {
      fault.audioClients[0].audioEpoch = before.audioClients[0].audioEpoch;
    },
    (before, fault) => {
      fault.audioClients[1].discontinuityCount =
        before.audioClients[1].discontinuityCount + 2;
    },
    (_before, fault, recovery) => {
      recovery.audioClients[2].discontinuityCount =
        fault.audioClients[2].discontinuityCount + 1;
    },
    (_before, fault, recovery) => {
      recovery.audioClients[3].pcmCursorFrames =
        fault.audioClients[3].pcmCursorFrames;
    },
  ];
  for (const attack of attacks) {
    const input = fixture();
    attack(
      stateAt(input, 'audio-epoch-discontinuity', 'before'),
      stateAt(input, 'audio-epoch-discontinuity', 'fault-observed'),
      stateAt(input, 'audio-epoch-discontinuity', 'recovery-observed'),
    );
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_AUDIO_EPOCH_SEMANTICS_INVALID/,
    );
  }
});

test('enforces strict phase order, non-overlap and each recovery SLO', () => {
  {
    const input = fixture();
    input.scenarioEvents[1].phase = 'before';
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_EVENT_PLAN_INVALID/,
    );
  }
  {
    const input = fixture();
    eventAt(input, 'runtime-reconnect', 'recovery-observed').atMonotonicMs =
      eventAt(input, 'runtime-reconnect', 'fault-action').atMonotonicMs + 5_001;
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_RECOVERY_SLO_EXCEEDED/,
    );
  }
  {
    const input = fixture();
    input.scenarioEvents[5].atMonotonicMs =
      input.scenarioEvents[4].atMonotonicMs;
    assert.throws(
      () => validate(input),
      /PHASE5_FAULT_SCENARIO_OVERLAP/,
    );
  }
});

test('transport projection is a required independent argument, never producer input', () => {
  const input = fixture();
  const projection = transportProjection(input);
  assert.equal(validateFaultScenarioSemantics(input, projection), input);
  assert.throws(
    () => validateFaultScenarioSemantics(input),
    /PHASE5_FAULT_TRANSPORT_PROJECTION_REQUIRED/,
  );

  const embedded = fixture();
  embedded.transportProjection = transportProjection(embedded);
  assert.throws(
    () => validateFaultScenarioSemantics(embedded, embedded.transportProjection),
    /PHASE5_FAULT_SEMANTICS_INPUT_INVALID/,
  );

  const mismatch = fixture();
  const mismatchedProjection = transportProjection(mismatch);
  mismatchedProjection.stateEvents[7].state.world.revision += 1;
  assert.throws(
    () => validateFaultScenarioSemantics(mismatch, mismatchedProjection),
    /PHASE5_FAULT_TRANSPORT_PROJECTION_MISMATCH/,
  );

  for (const projection of [
    {},
    { marker: 'projected' },
    {
      schemaVersion: 1,
      kind: 'phase5-fault-transport-projection',
      stateEvents: [],
    },
  ]) {
    const malformed = fixture();
    assert.throws(
      () => validateFaultScenarioSemantics(malformed, projection),
      /PHASE5_FAULT_TRANSPORT_PROJECTION_INVALID/,
    );
  }
});
