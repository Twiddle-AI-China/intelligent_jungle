import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectPhase5FaultTransport,
} from '../../tools/lib/phase5-fault-transport-projection.mjs';
import {
  FAULT_ACTUATOR_PLAN,
  validateFaultScenarioSemantics,
  validateFaultState,
} from '../../tools/lib/phase5-fault-semantics.mjs';

const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const UNIX_BASE = 1_800_000_000_000;
const ZERO_SHA256 = '0'.repeat(64);
const CLIENT_IDENTITY = Object.freeze(
  [1, 2, 3, 4].map((clientId) => String(clientId).repeat(64)),
);
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
const TIMEOUT_FIXTURE_ID = 'phase5-timeout-hold-open-v1';
const TIMEOUT_FIXTURE_SHA256 =
  '12baea86a4fdc350efbfaea53fde6f60b330db5292e860c84a9bef4606eac598';

function transportEvent(sequence, client, type, atMonotonicMs, payload) {
  return {
    sequence,
    runId: RUN_ID,
    atMonotonicMs,
    atUnixMs: UNIX_BASE + atMonotonicMs,
    client,
    type,
    previousTransportSha256: ZERO_SHA256,
    payload,
  };
}

function scenarioEvent(
  sequence,
  scenario,
  phase,
  atMonotonicMs,
  transportPrefixCount,
) {
  return {
    sequence,
    runId: RUN_ID,
    scenario,
    phase,
    atMonotonicMs,
    atUnixMs: UNIX_BASE + atMonotonicMs,
    previousEventSha256: ZERO_SHA256,
    transportPrefixCount,
    transportPrefixSha256: ZERO_SHA256,
    payload: { producerClaim: `${scenario}:${phase}` },
    signature: Buffer.alloc(64).toString('base64'),
  };
}

function createFixture() {
  const transportEvents = [];
  const scenarioEvents = [];
  const runtimeGenerations = [1, 1, 1, 1];
  const runtimeProbeSequences = [1, 1, 1, 1];
  const egressGenerations = [1, 1, 1, 1];
  const audioGenerations = [1, 1, 1, 1];
  const audioEpochs = ['epoch-a', 'epoch-a', 'epoch-a', 'epoch-a'];
  const streamRevisions = [1, 1, 1, 1];
  const audioBlockSequences = [0, 0, 0, 0];
  const audioCursors = [0, 0, 0, 0];
  let worldRevision = 0;
  let workerPid = 500;
  let workerEpoch = 'epoch-a';
  let workerRestartCount = 0;
  let supervisorGeneration = 1;
  let lastExitedPid = null;
  let lastExitSignal = null;

  function emit(client, type, atMonotonicMs, payload) {
    transportEvents.push(transportEvent(
      transportEvents.length + 1,
      client,
      type,
      atMonotonicMs,
      payload,
    ));
  }

  function emitWorldSnapshot(atMonotonicMs) {
    worldRevision += 1;
    runtimeProbeSequences[0] += 1;
    emit(1, 'runtime.snapshot', atMonotonicMs, {
      generation: runtimeGenerations[0],
      worldGeneration: 'world-a',
      revision: worldRevision,
      eventSeq: worldRevision,
      probeSeq: runtimeProbeSequences[0],
    });
  }

  function emitAllRuntimeSnapshots(atMonotonicMs) {
    worldRevision += 1;
    for (let clientId = 1; clientId <= 4; clientId += 1) {
      const index = clientId - 1;
      runtimeProbeSequences[index] += 1;
      emit(clientId, 'runtime.snapshot', atMonotonicMs, {
        generation: runtimeGenerations[index],
        worldGeneration: 'world-a',
        revision: worldRevision,
        eventSeq: worldRevision,
        probeSeq: runtimeProbeSequences[index],
      });
    }
  }

  function emitPcm(clientId, atMonotonicMs) {
    const index = clientId - 1;
    emit(clientId, 'audio.pcm', atMonotonicMs, {
      generation: audioGenerations[index],
      audioEpoch: audioEpochs[index],
      streamRevision: streamRevisions[index],
      blockSeq: audioBlockSequences[index],
      startFrame: String(audioCursors[index]),
      frameCount: 4_096,
    });
    audioBlockSequences[index] += 1;
    audioCursors[index] += 4_096;
  }

  function emitStreamDiscontinuity(clientId, atMonotonicMs, audioEpoch) {
    const index = clientId - 1;
    streamRevisions[index] += 1;
    audioEpochs[index] = audioEpoch;
    audioBlockSequences[index] = 0;
    audioCursors[index] = 0;
    emit(clientId, 'audio.discontinuity', atMonotonicMs, {
      generation: audioGenerations[index],
      audioEpoch,
      streamRevision: streamRevisions[index],
      blockSeq: 0,
      resumeStartFrame: '0',
      scope: 'stream',
    });
  }

  function emitWorker(atMonotonicMs, overrides = {}) {
    emit(0, 'worker.sample', atMonotonicMs, {
      pid: workerPid,
      ready: true,
      recovering: false,
      restartCount: workerRestartCount,
      audioEpoch: workerEpoch,
      supervisorGeneration,
      lastExitedPid,
      lastExitSignal,
      ...overrides,
    });
  }

  function addScenario(
    scenario,
    base,
    {
      prepareBefore = () => {},
      fault,
      recovery,
      faultObservedOffset = 500,
      recoveryActionOffset = 600,
      recoveryObservedOffset = 1_000,
    },
  ) {
    if (scenarioEvents.length > 0) {
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base - 20 + clientId);
      }
      emitWorldSnapshot(base - 10);
    }
    prepareBefore(base);
    const beforePrefix = transportEvents.length;
    scenarioEvents.push(scenarioEvent(
      scenarioEvents.length + 1,
      scenario,
      'before',
      base,
      beforePrefix,
    ));
    scenarioEvents.push(scenarioEvent(
      scenarioEvents.length + 1,
      scenario,
      'fault-action',
      base + 100,
      beforePrefix,
    ));
    fault(base);
    const faultPrefix = transportEvents.length;
    scenarioEvents.push(scenarioEvent(
      scenarioEvents.length + 1,
      scenario,
      'fault-observed',
      base + faultObservedOffset,
      faultPrefix,
    ));
    scenarioEvents.push(scenarioEvent(
      scenarioEvents.length + 1,
      scenario,
      'recovery-action',
      base + recoveryActionOffset,
      faultPrefix,
    ));
    recovery(base);
    const recoveryPrefix = transportEvents.length;
    scenarioEvents.push(scenarioEvent(
      scenarioEvents.length + 1,
      scenario,
      'recovery-observed',
      base + recoveryObservedOffset,
      recoveryPrefix,
    ));
  }

  for (let clientId = 1; clientId <= 4; clientId += 1) {
    const index = clientId - 1;
    const base = clientId * 20;
    emit(clientId, 'runtime.open', base, {
      generation: runtimeGenerations[index],
      mode: 'bootstrap',
      clientIdentitySha256: CLIENT_IDENTITY[index],
    });
    emit(clientId, 'runtime.ready', base + 1, {
      generation: runtimeGenerations[index],
      worldGeneration: 'world-a',
      revision: worldRevision,
      eventSeq: worldRevision,
    });
    emit(clientId, 'runtime.snapshot', base + 2, {
      generation: runtimeGenerations[index],
      worldGeneration: 'world-a',
      revision: worldRevision,
      eventSeq: worldRevision,
      probeSeq: runtimeProbeSequences[index],
    });
    emit(clientId, 'runtime.egress', base + 3, {
      generation: egressGenerations[index],
      capacityEntries: 256,
      queuedEntries: 0,
      inFlight: 0,
      closed: false,
      closeCode: null,
      closeReason: null,
    });
    emit(clientId, 'audio.open', base + 4, {
      generation: audioGenerations[index],
    });
    emit(clientId, 'audio.ready', base + 5, {
      generation: audioGenerations[index],
      audioEpoch: audioEpochs[index],
      streamRevision: streamRevisions[index],
      blockSeq: audioBlockSequences[index],
      resumeStartFrame: String(audioCursors[index]),
    });
    emitPcm(clientId, base + 6);
  }
  emitWorker(100);

  addScenario('worker-crash-restart', 1_000, {
    fault(base) {
      emitWorldSnapshot(base + 200);
      lastExitedPid = workerPid;
      lastExitSignal = 'SIGKILL';
      supervisorGeneration += 1;
      emitWorker(base + 201, {
        pid: null,
        ready: false,
        recovering: true,
        lastExitedPid,
        lastExitSignal,
      });
    },
    recovery(base) {
      workerPid = 501;
      workerEpoch = 'epoch-b';
      workerRestartCount = 1;
      emitWorker(base + 700);
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitStreamDiscontinuity(clientId, base + 710 + clientId, workerEpoch);
      }
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base + 720 + clientId);
      }
      emitWorldSnapshot(base + 730);
    },
  });

  addScenario('runtime-reconnect', 30_000, {
    fault(base) {
      emit(4, 'runtime.egress', base + 199, {
        generation: egressGenerations[3],
        capacityEntries: 256,
        queuedEntries: 0,
        inFlight: 0,
        closed: true,
        closeCode: 1_000,
        closeReason: 'PHASE5_RUNTIME_RECONNECT',
      });
      emit(4, 'runtime.close', base + 200, {
        generation: runtimeGenerations[3],
        code: 1_000,
        reason: 'PHASE5_RUNTIME_RECONNECT',
      });
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base + 200 + clientId);
      }
      emitWorldSnapshot(base + 210);
    },
    recovery(base) {
      egressGenerations[3] += 1;
      emit(4, 'runtime.egress', base + 699, {
        generation: egressGenerations[3],
        capacityEntries: 256,
        queuedEntries: 0,
        inFlight: 0,
        closed: false,
        closeCode: null,
        closeReason: null,
      });
      runtimeGenerations[3] += 1;
      emit(4, 'runtime.open', base + 700, {
        generation: runtimeGenerations[3],
        mode: 'resume',
        clientIdentitySha256: CLIENT_IDENTITY[3],
      });
      emit(4, 'runtime.ready', base + 701, {
        generation: runtimeGenerations[3],
        worldGeneration: 'world-a',
        revision: worldRevision,
        eventSeq: worldRevision,
      });
      runtimeProbeSequences[3] += 1;
      emit(4, 'runtime.snapshot', base + 702, {
        generation: runtimeGenerations[3],
        worldGeneration: 'world-a',
        revision: worldRevision,
        eventSeq: worldRevision,
        probeSeq: runtimeProbeSequences[3],
      });
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base + 702 + clientId);
      }
      emitWorldSnapshot(base + 710);
    },
  });

  addScenario('slow-client', 60_000, {
    fault(base) {
      emit(4, 'audio.pause', base + 200, {
        generation: audioGenerations[3],
      });
      for (let clientId = 1; clientId <= 3; clientId += 1) {
        emitPcm(clientId, base + 210 + clientId);
      }
      emitWorldSnapshot(base + 220);
    },
    recovery(base) {
      emit(4, 'audio.resume', base + 2_300, {
        generation: audioGenerations[3],
      });
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base + 2_310 + clientId);
      }
      emitWorldSnapshot(base + 2_320);
    },
    faultObservedOffset: 2_200,
    recoveryActionOffset: 2_250,
    recoveryObservedOffset: 3_000,
  });

  addScenario('queue-pressure', 90_000, {
    fault(base) {
      emit(4, 'runtime.egress', base + 200, {
        generation: egressGenerations[3],
        capacityEntries: 256,
        queuedEntries: 256,
        inFlight: 0,
        closed: true,
        closeCode: 4_410,
        closeReason: 'EGRESS_OVERFLOW',
      });
      emit(4, 'runtime.close', base + 201, {
        generation: runtimeGenerations[3],
        code: 4_410,
        reason: 'EGRESS_OVERFLOW',
      });
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base + 210 + clientId);
      }
      emitWorldSnapshot(base + 220);
    },
    recovery(base) {
      egressGenerations[3] += 1;
      emit(4, 'runtime.egress', base + 700, {
        generation: egressGenerations[3],
        capacityEntries: 256,
        queuedEntries: 0,
        inFlight: 0,
        closed: false,
        closeCode: null,
        closeReason: null,
      });
      runtimeGenerations[3] += 1;
      emit(4, 'runtime.open', base + 701, {
        generation: runtimeGenerations[3],
        mode: 'resume',
        clientIdentitySha256: CLIENT_IDENTITY[3],
      });
      emit(4, 'runtime.ready', base + 702, {
        generation: runtimeGenerations[3],
        worldGeneration: 'world-a',
        revision: worldRevision,
        eventSeq: worldRevision,
      });
      runtimeProbeSequences[3] += 1;
      emit(4, 'runtime.snapshot', base + 703, {
        generation: runtimeGenerations[3],
        worldGeneration: 'world-a',
        revision: worldRevision,
        eventSeq: worldRevision,
        probeSeq: runtimeProbeSequences[3],
      });
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base + 710 + clientId);
      }
      emitWorldSnapshot(base + 720);
    },
  });

  addScenario('agent-timeout', 120_000, {
    fault(base) {
      emit(0, 'agent.start', base + 101, {
        requestId: 'timeout-injected-1',
        source: 'injected',
        model: 'bird_agent',
        attempts: 1,
        startedAtMonotonicMs: base + 101,
      });
      emit(0, 'agent.settle', base + 12_101, {
        requestId: 'timeout-injected-1',
        source: 'injected',
        model: 'bird_agent',
        status: 'timeout',
        reason: 'ATTEMPT_TIMEOUT',
        attempts: 1,
        startedAtMonotonicMs: base + 101,
        settledAtMonotonicMs: base + 12_101,
        httpStatus: null,
      });
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base + 12_101 + clientId);
      }
      emitWorldSnapshot(base + 12_110);
    },
    recovery(base) {
      emit(0, 'agent.start', base + 12_301, {
        requestId: 'timeout-real-1',
        source: 'real',
        model: 'bird_agent',
        attempts: 1,
        startedAtMonotonicMs: base + 12_301,
      });
      emit(0, 'agent.settle', base + 12_401, {
        requestId: 'timeout-real-1',
        source: 'real',
        model: 'bird_agent',
        status: 'ok',
        reason: null,
        attempts: 1,
        startedAtMonotonicMs: base + 12_301,
        settledAtMonotonicMs: base + 12_401,
        httpStatus: 200,
      });
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base + 12_401 + clientId);
      }
      emitWorldSnapshot(base + 12_410);
    },
    faultObservedOffset: 12_200,
    recoveryActionOffset: 12_300,
    recoveryObservedOffset: 13_000,
  });

  addScenario('agent-malformed-response', 160_000, {
    fault(base) {
      emit(0, 'agent.start', base + 101, {
        requestId: 'malformed-injected-1',
        source: 'injected',
        model: 'bird_agent',
        attempts: 1,
        startedAtMonotonicMs: base + 101,
      });
      emit(0, 'agent.settle', base + 200, {
        requestId: 'malformed-injected-1',
        source: 'injected',
        model: 'bird_agent',
        status: 'invalid_output',
        reason: 'INVALID_OUTPUT',
        attempts: 1,
        startedAtMonotonicMs: base + 101,
        settledAtMonotonicMs: base + 200,
        httpStatus: 200,
      });
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base + 200 + clientId);
      }
      emitWorldSnapshot(base + 210);
    },
    recovery(base) {
      emit(0, 'agent.start', base + 601, {
        requestId: 'malformed-real-1',
        source: 'real',
        model: 'bird_agent',
        attempts: 1,
        startedAtMonotonicMs: base + 601,
      });
      emit(0, 'agent.settle', base + 700, {
        requestId: 'malformed-real-1',
        source: 'real',
        model: 'bird_agent',
        status: 'ok',
        reason: null,
        attempts: 1,
        startedAtMonotonicMs: base + 601,
        settledAtMonotonicMs: base + 700,
        httpStatus: 200,
      });
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base + 700 + clientId);
      }
      emitWorldSnapshot(base + 710);
    },
  });

  addScenario('audio-epoch-discontinuity', 190_000, {
    fault(base) {
      workerEpoch = 'epoch-c';
      emitWorker(base + 200);
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitStreamDiscontinuity(clientId, base + 210 + clientId, workerEpoch);
      }
      emitWorldSnapshot(base + 220);
    },
    recovery(base) {
      for (let clientId = 1; clientId <= 4; clientId += 1) {
        emitPcm(clientId, base + 700 + clientId);
      }
      emitWorldSnapshot(base + 710);
    },
  });

  for (let atMonotonicMs = 191_001;
    atMonotonicMs < 221_000;
    atMonotonicMs += 93) {
    for (let clientId = 1; clientId <= 4; clientId += 1) {
      emitPcm(clientId, atMonotonicMs);
    }
    emitAllRuntimeSnapshots(atMonotonicMs);
    emitWorker(atMonotonicMs);
  }
  for (let clientId = 1; clientId <= 4; clientId += 1) {
    emitPcm(clientId, 221_000);
  }
  emitAllRuntimeSnapshots(221_001);
  emitWorker(221_002);

  return {
    runId: RUN_ID,
    window: {
      startedAtMonotonicMs: 0,
      endedAtMonotonicMs: 221_002,
      startedAtUnixMs: UNIX_BASE,
      endedAtUnixMs: UNIX_BASE + 221_002,
    },
    transportEvents,
    scenarioEvents,
  };
}

function stateAt(projection, scenario, phase) {
  return projection.stateEvents.find((event) => (
    event.scenario === scenario && event.phase === phase
  )).state;
}

function actionReceipt(actuatorSequence, before, fault, recovery) {
  if (actuatorSequence === 1) {
    return {
      actuatorSequence,
      pid: before.worker.pid,
      signal: 'SIGKILL',
      supervisorGeneration: before.worker.supervisorGeneration,
      accepted: true,
    };
  }
  if (actuatorSequence === 2) {
    return {
      actuatorSequence,
      supervisorGeneration: recovery.worker.supervisorGeneration,
      observedPid: recovery.worker.pid,
      observedAudioEpoch: recovery.worker.audioEpoch,
      ready: recovery.worker.ready,
      recovering: recovery.worker.recovering,
      accepted: true,
    };
  }
  if (actuatorSequence === 3) {
    return {
      actuatorSequence,
      clientId: 4,
      beforeGeneration: before.runtimeClients[3].generation,
      closeCode: 1_000,
      closeReason: 'PHASE5_RUNTIME_RECONNECT',
      accepted: true,
    };
  }
  if (actuatorSequence === 4) {
    return {
      actuatorSequence,
      clientId: 4,
      beforeGeneration: before.runtimeClients[3].generation,
      afterGeneration: recovery.runtimeClients[3].generation,
      snapshotWorldGeneration:
        recovery.runtimeClients[3].snapshotWorldGeneration,
      accepted: true,
    };
  }
  if (actuatorSequence === 5 || actuatorSequence === 6) {
    const beforePaused = actuatorSequence === 5
      ? before.audioClients[3].paused
      : fault.audioClients[3].paused;
    const afterPaused = actuatorSequence === 5
      ? fault.audioClients[3].paused
      : recovery.audioClients[3].paused;
    return {
      actuatorSequence,
      clientId: 4,
      beforePaused,
      afterPaused,
      accepted: true,
    };
  }
  if (actuatorSequence === 7) {
    return {
      actuatorSequence,
      clientId: 4,
      capacityEntries: fault.egress[3].capacityEntries,
      acceptedEntries: fault.egress[3].capacityEntries,
      rejectedEntries: 1,
      closeCode: fault.egress[3].closeCode,
      closeReason: fault.egress[3].closeReason,
    };
  }
  if (actuatorSequence === 8) {
    return {
      actuatorSequence,
      clientId: 4,
      beforeGeneration: before.egress[3].generation,
      afterGeneration: recovery.egress[3].generation,
      accepted: true,
    };
  }
  if (actuatorSequence === 9 || actuatorSequence === 11) {
    const receipt = {
      actuatorSequence,
      requestId: fault.provider.lastResult.requestId,
      fixture: actuatorSequence === 9 ? 'timeout' : 'malformed-response',
      accepted: true,
    };
    if (actuatorSequence === 9) {
      Object.assign(receipt, {
        fixtureId: TIMEOUT_FIXTURE_ID,
        fixtureSha256: TIMEOUT_FIXTURE_SHA256,
        attemptTimeoutMs: 12_000,
        deadlineMs: 15_000,
        idleAdmission: true,
      });
    }
    return receipt;
  }
  if (actuatorSequence === 10 || actuatorSequence === 12) {
    return {
      actuatorSequence,
      fixture: actuatorSequence === 10 ? 'timeout' : 'malformed-response',
      realRequestId: recovery.provider.lastResult.requestId,
      accepted: true,
    };
  }
  if (actuatorSequence === 13) {
    return {
      actuatorSequence,
      beforeAudioEpoch: before.worker.audioEpoch,
      afterAudioEpoch: fault.worker.audioEpoch,
      accepted: true,
    };
  }
  return {
    actuatorSequence,
    audioEpoch: recovery.worker.audioEpoch,
    clientCount: recovery.audioClients.length,
    accepted: true,
  };
}

function typedSemanticsInput(evidence, projection) {
  let actuatorIndex = 0;
  const scenarioEvents = evidence.scenarioEvents.map((event) => {
    let payload;
    if (event.phase.endsWith('action')) {
      const scenarioIndex = SCENARIOS.indexOf(event.scenario);
      const before = stateAt(projection, event.scenario, 'before');
      const fault = stateAt(projection, event.scenario, 'fault-observed');
      const recovery = stateAt(
        projection,
        event.scenario,
        'recovery-observed',
      );
      const contract = FAULT_ACTUATOR_PLAN[actuatorIndex];
      payload = {
        kind: 'action',
        action: {
          operation: contract.operation,
          target: contract.target,
          receipt: actionReceipt(
            scenarioIndex * 2 + (event.phase === 'fault-action' ? 1 : 2),
            before,
            fault,
            recovery,
          ),
        },
      };
      actuatorIndex += 1;
    } else {
      payload = {
        kind: 'state',
        state: structuredClone(
          stateAt(projection, event.scenario, event.phase),
        ),
      };
    }
    return {
      scenario: event.scenario,
      phase: event.phase,
      atMonotonicMs: event.atMonotonicMs,
      payload,
    };
  });
  assert.equal(actuatorIndex, FAULT_ACTUATOR_PLAN.length);
  return { scenarioEvents };
}

function eventOf(evidence, type, predicate = () => true) {
  return evidence.transportEvents.find((event) => (
    event.type === type && predicate(event)
  ));
}

function resequenceTransport(evidence) {
  evidence.transportEvents.sort((left, right) => (
    left.atMonotonicMs - right.atMonotonicMs
  ));
  for (let index = 0; index < evidence.transportEvents.length; index += 1) {
    evidence.transportEvents[index].sequence = index + 1;
  }
}

test('projects all twenty-one states for the fixed seven-scenario plan from raw prefixes', () => {
  const evidence = createFixture();
  const projection = projectPhase5FaultTransport(evidence);

  assert.deepEqual(Object.keys(projection), [
    'schemaVersion',
    'kind',
    'stateEvents',
  ]);
  assert.equal(projection.schemaVersion, 1);
  assert.equal(projection.kind, 'phase5-fault-transport-projection');
  assert.equal(projection.stateEvents.length, 21);
  assert.deepEqual(
    projection.stateEvents.map(({ scenario, phase }) => [scenario, phase]),
    SCENARIOS.flatMap((scenario) => [
      [scenario, 'before'],
      [scenario, 'fault-observed'],
      [scenario, 'recovery-observed'],
    ]),
  );
  for (const event of projection.stateEvents) {
    assert.equal(validateFaultState(event.state), event.state);
  }

  const workerBefore = stateAt(
    projection,
    'worker-crash-restart',
    'before',
  );
  const workerFault = stateAt(
    projection,
    'worker-crash-restart',
    'fault-observed',
  );
  const workerRecovery = stateAt(
    projection,
    'worker-crash-restart',
    'recovery-observed',
  );
  assert.equal(workerBefore.worker.pid, 500);
  assert.deepEqual(workerBefore.worker, {
    pid: 500,
    ready: true,
    recovering: false,
    audioEpoch: 'epoch-a',
    restartCount: 0,
    supervisorGeneration: 1,
    lastExitedPid: null,
    lastExitSignal: null,
  });
  assert.equal(workerFault.worker.pid, null);
  assert.equal(workerFault.worker.recovering, true);
  assert.equal(workerFault.worker.lastExitedPid, 500);
  assert.equal(workerFault.worker.lastExitSignal, 'SIGKILL');
  assert.equal(workerRecovery.worker.pid, 501);
  assert.equal(workerRecovery.worker.audioEpoch, 'epoch-b');
  assert.equal(workerRecovery.worker.supervisorGeneration, 2);

  const reconnectFault = stateAt(
    projection,
    'runtime-reconnect',
    'fault-observed',
  );
  const reconnectRecovery = stateAt(
    projection,
    'runtime-reconnect',
    'recovery-observed',
  );
  assert.equal(reconnectFault.runtimeClients[3].connected, false);
  assert.equal(
    reconnectRecovery.runtimeClients[3].generation,
    reconnectFault.runtimeClients[3].generation + 1,
  );

  const slowBefore = stateAt(projection, 'slow-client', 'before');
  const slowFault = stateAt(projection, 'slow-client', 'fault-observed');
  const slowRecovery = stateAt(projection, 'slow-client', 'recovery-observed');
  assert.equal(slowFault.audioClients[3].paused, true);
  assert.equal(
    slowFault.audioClients[3].pcmCursorFrames,
    slowBefore.audioClients[3].pcmCursorFrames,
  );
  assert.equal(slowRecovery.audioClients[3].paused, false);
  assert.ok(
    slowRecovery.audioClients[3].pcmCursorFrames
      > slowFault.audioClients[3].pcmCursorFrames,
  );

  const queueFault = stateAt(projection, 'queue-pressure', 'fault-observed');
  const queueRecovery = stateAt(
    projection,
    'queue-pressure',
    'recovery-observed',
  );
  assert.deepEqual(
    [
      queueFault.egress[3].queuedEntries,
      queueFault.egress[3].closeCode,
      queueFault.egress[3].closeReason,
    ],
    [256, 4_410, 'EGRESS_OVERFLOW'],
  );
  assert.equal(queueRecovery.egress[3].closed, false);
  assert.equal(
    queueRecovery.egress[3].generation,
    queueFault.egress[3].generation + 1,
  );

  const timeoutFault = stateAt(projection, 'agent-timeout', 'fault-observed');
  const timeoutRecovery = stateAt(
    projection,
    'agent-timeout',
    'recovery-observed',
  );
  assert.equal(timeoutFault.provider.lastResult.status, 'timeout');
  assert.equal(timeoutRecovery.provider.lastResult.status, 'ok');
  const malformedFault = stateAt(
    projection,
    'agent-malformed-response',
    'fault-observed',
  );
  assert.equal(malformedFault.provider.lastResult.status, 'invalid_output');

  const epochBefore = stateAt(
    projection,
    'audio-epoch-discontinuity',
    'before',
  );
  const epochFault = stateAt(
    projection,
    'audio-epoch-discontinuity',
    'fault-observed',
  );
  assert.notEqual(epochFault.worker.audioEpoch, epochBefore.worker.audioEpoch);
  assert.deepEqual(
    epochFault.audioClients.map(({ discontinuityCount }) => discontinuityCount),
    epochBefore.audioClients.map(({ discontinuityCount }) => (
      discontinuityCount + 1
    )),
  );
});

test('projected raw timeline composes with all typed scenario semantics', () => {
  const evidence = createFixture();
  const projection = projectPhase5FaultTransport(evidence);
  const input = typedSemanticsInput(evidence, projection);
  assert.equal(
    validateFaultScenarioSemantics(input, projection),
    input,
  );
});

test('never reads producer-reported state, including future state claims', () => {
  const evidence = createFixture();
  const expected = projectPhase5FaultTransport(evidence);
  for (const event of evidence.scenarioEvents) {
    event.payload = {
      kind: 'state',
      state: {
        futureWorld: Number.MAX_SAFE_INTEGER,
        forged: true,
      },
    };
  }
  assert.deepEqual(projectPhase5FaultTransport(evidence), expected);
});

test('rejects a missing or incomplete initial prelude', () => {
  const evidence = createFixture();
  evidence.scenarioEvents[0].transportPrefixCount = 1;
  assert.throws(
    () => projectPhase5FaultTransport(evidence),
    /PHASE5_FAULT_TRANSPORT_(?:PRELUDE_INCOMPLETE|PREFIX_INCOMPLETE)/,
  );
});

test('rejects generation, PCM cursor and block sequence attacks', () => {
  for (const mutate of [
    (evidence) => {
      eventOf(evidence, 'runtime.snapshot', ({ client }) => client === 4)
        .payload.generation += 1;
    },
    (evidence) => {
      eventOf(evidence, 'audio.pcm').payload.startFrame = '4096';
    },
    (evidence) => {
      eventOf(evidence, 'audio.pcm').payload.blockSeq += 1;
    },
    (evidence) => {
      eventOf(evidence, 'audio.pcm').payload.blockSeq = 0x1_0000_0000;
    },
    (evidence) => {
      eventOf(evidence, 'audio.pcm').payload.streamRevision =
        0x1_0000_0000;
    },
    (evidence) => {
      eventOf(evidence, 'audio.pcm').payload.generation = 0x1_0000_0000;
    },
  ]) {
    const evidence = createFixture();
    mutate(evidence);
    assert.throws(
      () => projectPhase5FaultTransport(evidence),
      /PHASE5_FAULT_TRANSPORT_(?:PAYLOAD|TRANSITION)_INVALID/,
    );
  }
});

test('audio reconnect cannot silently reset epoch revision block or cursor', () => {
  const evidence = createFixture();
  const lastPcm = [...evidence.transportEvents].reverse().find((event) => (
    event.type === 'audio.pcm' && event.client === 1
  ));
  const append = (type, atMonotonicMs, payload) => {
    evidence.transportEvents.push(transportEvent(
      evidence.transportEvents.length + 1,
      1,
      type,
      atMonotonicMs,
      payload,
    ));
  };
  append('audio.close', 221_100, {
    generation: 1,
    code: 1_000,
    reason: 'PHASE5_AUDIO_RECONNECT',
  });
  append('audio.open', 221_101, { generation: 2 });
  append('audio.ready', 221_102, {
    generation: 2,
    audioEpoch: 'silently-forged-epoch',
    streamRevision: lastPcm.payload.streamRevision,
    blockSeq: lastPcm.payload.blockSeq + 1,
    resumeStartFrame: String(
      Number(lastPcm.payload.startFrame) + lastPcm.payload.frameCount,
    ),
  });
  assert.throws(
    () => projectPhase5FaultTransport(evidence),
    /PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID/,
  );
});

test('stability tail rejects every unconsumed effect and pending operation', () => {
  const attacks = [
    (evidence, append) => append(1, 'runtime.close', {
      generation: 1,
      code: 1_000,
      reason: 'PHASE5_RUNTIME_RECONNECT',
    }),
    (evidence, append) => append(1, 'audio.pause', { generation: 1 }),
    (evidence, append) => append(0, 'worker.sample', {
      pid: null,
      ready: false,
      recovering: true,
      restartCount: 1,
      audioEpoch: 'epoch-c',
      supervisorGeneration: 3,
      lastExitedPid: 501,
      lastExitSignal: 'SIGKILL',
    }),
    (evidence, append, atMonotonicMs) => append(0, 'agent.start', {
      requestId: 'tail-pending-real-request',
      source: 'real',
      model: 'bird_agent',
      attempts: 1,
      startedAtMonotonicMs: atMonotonicMs,
    }),
    (evidence, append) => append(1, 'audio.close', {
      generation: 1,
      code: 1_000,
      reason: 'PHASE5_AUDIO_RECONNECT',
    }),
    (evidence, append) => append(4, 'runtime.egress', {
      generation: 3,
      capacityEntries: 256,
      queuedEntries: 256,
      inFlight: 0,
      closed: true,
      closeCode: 4_410,
      closeReason: 'EGRESS_OVERFLOW',
    }),
  ];
  for (const attack of attacks) {
    const evidence = createFixture();
    const atMonotonicMs = evidence.transportEvents.at(-1).atMonotonicMs + 100;
    const append = (clientId, type, payload) => {
      evidence.transportEvents.push(transportEvent(
        evidence.transportEvents.length + 1,
        clientId,
        type,
        atMonotonicMs,
        payload,
      ));
    };
    attack(evidence, append, atMonotonicMs);
    assert.throws(
      () => projectPhase5FaultTransport(evidence),
      /PHASE5_FAULT_STABILITY_TAIL_(?:UNEXPECTED_EFFECT|INCOMPLETE)/,
    );
  }
});

test('stability tail cannot be omitted or closed before thirty seconds', () => {
  const evidence = createFixture();
  const finalPrefix = evidence.scenarioEvents.at(-1).transportPrefixCount;
  evidence.transportEvents = evidence.transportEvents.slice(0, finalPrefix);
  assert.throws(
    () => projectPhase5FaultTransport(evidence),
    /PHASE5_FAULT_STABILITY_TAIL_INCOMPLETE/,
  );
});

test('stability tail observations must cover the signed window end', () => {
  const evidence = createFixture();
  evidence.window.endedAtMonotonicMs += 1_000;
  evidence.window.endedAtUnixMs += 1_000;
  assert.throws(
    () => projectPhase5FaultTransport(evidence),
    /PHASE5_FAULT_STABILITY_TAIL_INCOMPLETE/,
  );
});

test('stability tail requires continuous runtime and worker observations', () => {
  const evidence = createFixture();
  const finalPrefix = evidence.scenarioEvents.at(-1).transportPrefixCount;
  const collapsedAt =
    evidence.scenarioEvents.at(-1).atMonotonicMs + 1;
  for (const event of evidence.transportEvents.slice(finalPrefix)) {
    if (['runtime.snapshot', 'worker.sample'].includes(event.type)) {
      event.atMonotonicMs = collapsedAt;
      event.atUnixMs = UNIX_BASE + collapsedAt;
    }
  }
  resequenceTransport(evidence);
  assert.throws(
    () => projectPhase5FaultTransport(evidence),
    /PHASE5_FAULT_STABILITY_TAIL_(?:OBSERVATION_GAP|INCOMPLETE)/,
  );
});

test('stability tail rejects real provider calls beyond the fixed deadline', () => {
  const evidence = createFixture();
  const startedAtMonotonicMs =
    evidence.scenarioEvents.at(-1).atMonotonicMs + 3;
  const settledAtMonotonicMs =
    evidence.window.endedAtMonotonicMs - 102;
  evidence.transportEvents.push(
    transportEvent(
      1,
      0,
      'agent.start',
      startedAtMonotonicMs,
      {
        requestId: 'tail-over-deadline-real',
        source: 'real',
        model: 'bird_agent',
        attempts: 1,
        startedAtMonotonicMs,
      },
    ),
    transportEvent(
      1,
      0,
      'agent.settle',
      settledAtMonotonicMs,
      {
        requestId: 'tail-over-deadline-real',
        source: 'real',
        model: 'bird_agent',
        status: 'ok',
        reason: null,
        attempts: 1,
        startedAtMonotonicMs,
        settledAtMonotonicMs,
        httpStatus: 200,
      },
    ),
  );
  resequenceTransport(evidence);
  assert.throws(
    () => projectPhase5FaultTransport(evidence),
    /PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID/,
  );
});

test('four runtime clients require pairwise-distinct connection identities', () => {
  const evidence = createFixture();
  for (const event of evidence.transportEvents) {
    if (event.type === 'runtime.open') {
      event.payload.clientIdentitySha256 = 'f'.repeat(64);
    }
  }
  assert.throws(
    () => projectPhase5FaultTransport(evidence),
    /PHASE5_FAULT_RUNTIME_CLIENT_IDENTITY_INVALID/,
  );
});

test('rejects pause/resume no-ops instead of projecting claimed transitions', () => {
  const evidence = createFixture();
  const resume = eventOf(evidence, 'audio.resume');
  resume.type = 'audio.pause';
  assert.throws(
    () => projectPhase5FaultTransport(evidence),
    /PHASE5_FAULT_TRANSPORT_TRANSITION_INVALID/,
  );
});

test('rejects duplicate request ids and settle events that do not match start', () => {
  {
    const evidence = createFixture();
    const realStart = eventOf(
      evidence,
      'agent.start',
      ({ payload }) => payload.requestId === 'timeout-real-1',
    );
    realStart.payload.requestId = 'timeout-injected-1';
    assert.throws(
      () => projectPhase5FaultTransport(evidence),
      /PHASE5_FAULT_TRANSPORT_AGENT_REQUEST_INVALID/,
    );
  }
  {
    const evidence = createFixture();
    const settle = eventOf(
      evidence,
      'agent.settle',
      ({ payload }) => payload.requestId === 'malformed-injected-1',
    );
    settle.payload.requestId = 'not-the-started-request';
    assert.throws(
      () => projectPhase5FaultTransport(evidence),
      /PHASE5_FAULT_TRANSPORT_AGENT_REQUEST_INVALID/,
    );
  }
});

test('rejects world rollback, queue overflow and unknown close reasons', () => {
  for (const mutate of [
    (evidence) => {
      const snapshots = evidence.transportEvents.filter(
        ({ type, client }) => type === 'runtime.snapshot' && client === 1,
      );
      snapshots[3].payload.revision = 0;
    },
    (evidence) => {
      const overflow = eventOf(
        evidence,
        'runtime.egress',
        ({ payload }) => payload.closed,
      );
      overflow.payload.queuedEntries = 257;
    },
    (evidence) => {
      eventOf(evidence, 'runtime.close').payload.reason = 'looks-reasonable';
    },
  ]) {
    const evidence = createFixture();
    mutate(evidence);
    assert.throws(
      () => projectPhase5FaultTransport(evidence),
      /PHASE5_FAULT_TRANSPORT_(?:PAYLOAD|TRANSITION)_INVALID/,
    );
  }
});

test('validates observer failure payload exactly and then always fails closed', () => {
  {
    const evidence = createFixture();
    const target = eventOf(evidence, 'runtime.snapshot', ({ client }) => client === 1);
    target.client = 0;
    target.type = 'observer.failure';
    target.payload = {
      component: 'runtime',
      code: 'TELEMETRY_STALE',
      message: 'runtime telemetry stopped advancing',
    };
    assert.throws(
      () => projectPhase5FaultTransport(evidence),
      /PHASE5_FAULT_OBSERVER_FAILURE_RECORDED/,
    );
  }
  {
    const evidence = createFixture();
    const target = eventOf(evidence, 'runtime.snapshot', ({ client }) => client === 1);
    target.client = 0;
    target.type = 'observer.failure';
    target.payload = {
      component: 'runtime',
      code: 'TELEMETRY_STALE',
      message: 'runtime telemetry stopped advancing',
      ignored: true,
    };
    assert.throws(
      () => projectPhase5FaultTransport(evidence),
      /PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID/,
    );
  }
});

test('rejects a state prefix that includes future transport', () => {
  const evidence = createFixture();
  const first = evidence.scenarioEvents[0];
  const futureIndex = evidence.transportEvents.findIndex(
    ({ atMonotonicMs }) => atMonotonicMs > first.atMonotonicMs,
  );
  first.transportPrefixCount = futureIndex + 1;
  assert.throws(
    () => projectPhase5FaultTransport(evidence),
    /PHASE5_FAULT_TRANSPORT_PREFIX_TIME_INVALID/,
  );
});

test('rejects a prefix that omits transport already observed before its event', () => {
  const evidence = createFixture();
  const before = evidence.scenarioEvents.find((event) => (
    event.scenario === 'runtime-reconnect' && event.phase === 'before'
  ));
  const firstExcluded = evidence.transportEvents[before.transportPrefixCount];
  firstExcluded.atMonotonicMs = before.atMonotonicMs - 2;
  firstExcluded.atUnixMs = before.atUnixMs - 2;
  evidence.transportEvents[before.transportPrefixCount + 1].atMonotonicMs =
    before.atMonotonicMs - 1;
  evidence.transportEvents[before.transportPrefixCount + 1].atUnixMs =
    before.atUnixMs - 1;
  assert.throws(
    () => projectPhase5FaultTransport(evidence),
    /PHASE5_FAULT_TRANSPORT_PREFIX_INCOMPLETE/,
  );
});

test('rejects a forged observed state bound to the unchanged before prefix', () => {
  const evidence = createFixture();
  const before = evidence.scenarioEvents[0];
  const faultObserved = evidence.scenarioEvents[2];
  faultObserved.transportPrefixCount = before.transportPrefixCount;
  faultObserved.payload = {
    kind: 'state',
    state: { worker: { ready: false } },
  };
  assert.throws(
    () => projectPhase5FaultTransport(evidence),
    /PHASE5_FAULT_TRANSPORT_PREFIX_(?:PROGRESS_INVALID|INCOMPLETE)/,
  );
});

test('rejects extra payload keys and JavaScript numeric type confusion', () => {
  for (const mutate of [
    (evidence) => {
      eventOf(evidence, 'runtime.open').payload.extra = true;
    },
    (evidence) => {
      eventOf(evidence, 'runtime.egress').payload.queuedEntries = true;
    },
    (evidence) => {
      eventOf(evidence, 'worker.sample').payload.restartCount = 0.5;
    },
    (evidence) => {
      eventOf(evidence, 'audio.pcm').payload.frameCount = 4_095;
    },
  ]) {
    const evidence = createFixture();
    mutate(evidence);
    assert.throws(
      () => projectPhase5FaultTransport(evidence),
      /PHASE5_FAULT_TRANSPORT_PAYLOAD_INVALID/,
    );
  }
});
