import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import {
  canonicalJson,
  createEd25519SignerDescriptor,
  createSignedFaultEventEvidence,
} from '../../tools/lib/phase5-fault-evidence.mjs';
import {
  FAULT_ACTUATOR_PLAN,
} from '../../tools/lib/phase5-fault-semantics.mjs';
import {
  projectPhase5FaultTransport,
} from '../../tools/lib/phase5-fault-transport-projection.mjs';

export const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const UNIX_BASE = 1_800_000_000_000;
const ZERO_SHA256 = '0'.repeat(64);
export const CHALLENGE = '1'.repeat(64);
export const FAULT_SESSION_EVIDENCE_SHA256 = '2'.repeat(64);
export const RELEASE = Object.freeze({
  releaseManifestSha256: 'a'.repeat(64),
  releaseRevision: 'b'.repeat(40),
  sourceManifestSha256: 'c'.repeat(64),
  audioArtifactSha256: 'd'.repeat(64),
});
export const GEOMETRY = Object.freeze({
  sampleRate: 44_100,
  blockFrames: 4_096,
  poolSize: 5,
  rowVoices: ['bass', 'pad', 'lead', 'pluck', 'pad'],
});
export const PROFILE = Object.freeze({
  clients: 4,
  slowClient: 4,
  durationMinutes: 30,
  speciesEndpoint: 'http://127.0.0.1:8081/v1',
  speciesModel: 'bird_agent',
});
export const WINDOW = Object.freeze({
  startedAtMonotonicMs: 0,
  endedAtMonotonicMs: 1_800_000,
  startedAtUnixMs: UNIX_BASE,
  endedAtUnixMs: UNIX_BASE + 1_800_000,
});
const CLIENT_IDENTITY = Object.freeze(
  [1, 2, 3, 4].map((clientId) => String(clientId).repeat(64)),
);
export const SCENARIOS = Object.freeze([
  'worker-crash-restart',
  'runtime-reconnect',
  'slow-client',
  'queue-pressure',
  'agent-timeout',
  'agent-malformed-response',
  'audio-epoch-discontinuity',
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

function createRawFixture() {
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

  function emitRuntimeSnapshot(clientId, atMonotonicMs) {
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

  addScenario('audio-epoch-discontinuity', 1_769_000, {
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

  for (let atMonotonicMs = 1_770_001;
    atMonotonicMs < 1_800_000;
    atMonotonicMs += 93) {
    for (let clientId = 1; clientId <= 4; clientId += 1) {
      emitPcm(clientId, atMonotonicMs);
    }
    emitWorldSnapshot(atMonotonicMs);
    for (let clientId = 2; clientId <= 4; clientId += 1) {
      emitRuntimeSnapshot(clientId, atMonotonicMs);
    }
    emitWorker(atMonotonicMs);
  }
  for (let clientId = 1; clientId <= 4; clientId += 1) {
    emitPcm(clientId, 1_800_000);
  }
  emitWorldSnapshot(1_800_000);
  for (let clientId = 2; clientId <= 4; clientId += 1) {
    emitRuntimeSnapshot(clientId, 1_800_000);
  }
  emitWorker(1_800_000);

  return {
    runId: RUN_ID,
    window: structuredClone(WINDOW),
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

function typedScenarioDrafts(raw, projection) {
  let actuatorIndex = 0;
  const drafts = raw.scenarioEvents.map((event) => {
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
      atUnixMs: event.atUnixMs,
      transportPrefixCount: event.transportPrefixCount,
      payload,
    };
  });
  assert.equal(actuatorIndex, FAULT_ACTUATOR_PLAN.length);
  return drafts;
}

function transportDrafts(raw) {
  return raw.transportEvents.map((event) => ({
    atMonotonicMs: event.atMonotonicMs,
    atUnixMs: event.atUnixMs,
    client: event.client,
    type: event.type,
    payload: structuredClone(event.payload),
  }));
}

export function insertTransientPauseResume(
  raw,
  insertionIndex,
  pauseAt,
  resumeAt,
) {
  raw.transportEvents.splice(
    insertionIndex,
    0,
    transportEvent(0, 2, 'audio.pause', pauseAt, { generation: 1 }),
    transportEvent(0, 2, 'audio.resume', resumeAt, { generation: 1 }),
  );
  raw.transportEvents.forEach((event, index) => {
    event.sequence = index + 1;
  });
  for (const event of raw.scenarioEvents) {
    if (event.transportPrefixCount > insertionIndex) {
      event.transportPrefixCount += 2;
    }
  }
}

export function signedFixture({
  typed = true,
  mutateRaw = () => {},
  mutateScenarioDrafts = () => {},
  mutateTransportDrafts = () => {},
} = {}) {
  const raw = createRawFixture();
  mutateRaw(raw);
  const projection = projectPhase5FaultTransport(raw);
  const scenarioDrafts = typed
    ? typedScenarioDrafts(raw, projection)
    : raw.scenarioEvents.map((event) => ({
      scenario: event.scenario,
      phase: event.phase,
      atMonotonicMs: event.atMonotonicMs,
      atUnixMs: event.atUnixMs,
      transportPrefixCount: event.transportPrefixCount,
      payload: structuredClone(event.payload),
    }));
  mutateScenarioDrafts(scenarioDrafts);
  const transports = transportDrafts(raw);
  mutateTransportDrafts(transports);
  const keyPair = generateKeyPairSync('ed25519');
  const evidence = createSignedFaultEventEvidence({
    runId: RUN_ID,
    challenge: CHALLENGE,
    release: RELEASE,
    geometry: GEOMETRY,
    profile: PROFILE,
    window: WINDOW,
    scenarioEvents: scenarioDrafts,
    transportEvents: transports,
  }, keyPair);
  const runBinding = {
    runId: RUN_ID,
    challenge: CHALLENGE,
    release: structuredClone(RELEASE),
    geometry: structuredClone(GEOMETRY),
    profile: structuredClone(PROFILE),
    signerSpkiSha256:
      createEd25519SignerDescriptor(keyPair.publicKey).publicKeySpkiSha256,
    faultSessionEvidenceSha256: FAULT_SESSION_EVIDENCE_SHA256,
  };
  return { evidence, runBinding, keyPair };
}
