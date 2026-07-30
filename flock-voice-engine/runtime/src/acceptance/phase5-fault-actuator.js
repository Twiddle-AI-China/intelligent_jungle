import { createHash } from 'node:crypto';

const RECOVERY_SLO_MS = Object.freeze({
  'worker-crash-restart': 15_000,
  'runtime-reconnect': 5_000,
  'slow-client': 7_000,
  'queue-pressure': 5_000,
  'agent-timeout': 15_000,
  'agent-malformed-response': 15_000,
  'audio-epoch-discontinuity': 10_000,
});

function fail(code) {
  throw new Error(code);
}

function client4(state, kind) {
  return state[kind][3];
}

function completeBaseline(state) {
  return state?.world && state?.worker?.ready === true
    && state.runtimeClients?.length === 4
    && state.audioClients?.length === 4
    && state.egress?.length === 4
    && state.runtimeClients.every((value) => value.connected)
    && state.audioClients.every((value) => value.connected);
}

function observed(plan, state, plannedEpoch) {
  if (!completeBaseline(state) && plan.phase === 'before') return false;
  if (plan.phase === 'before') return true;
  const runtime = client4(state, 'runtimeClients');
  const audio = client4(state, 'audioClients');
  const egress = client4(state, 'egress');
  const recovery = plan.phase === 'recovery-observed';
  if (plan.scenario === 'worker-crash-restart') {
    return recovery
      ? state.worker.ready && !state.worker.recovering
      : !state.worker.ready && state.worker.recovering
        && state.worker.lastExitSignal === 'SIGKILL';
  }
  if (plan.scenario === 'runtime-reconnect') {
    return recovery ? runtime.connected && runtime.snapshotWorldGeneration
      === state.world.worldGeneration : !runtime.connected;
  }
  if (plan.scenario === 'slow-client') {
    return recovery ? !audio.paused : audio.paused;
  }
  if (plan.scenario === 'queue-pressure') {
    return recovery ? runtime.connected && !egress.closed
      : !runtime.connected && egress.closed
        && egress.closeCode === 4410
        && egress.closeReason === 'EGRESS_OVERFLOW';
  }
  if (plan.scenario === 'agent-timeout') {
    return state.provider.lastResult?.status === (recovery ? 'ok' : 'timeout')
      && state.provider.lastResult?.source === (recovery ? 'real' : 'injected');
  }
  if (plan.scenario === 'agent-malformed-response') {
    return state.provider.lastResult?.status
      === (recovery ? 'ok' : 'invalid_output')
      && state.provider.lastResult?.source === (recovery ? 'real' : 'injected');
  }
  return state.worker.audioEpoch === plannedEpoch
    && state.audioClients.every((value) => value.audioEpoch === plannedEpoch)
    && (!recovery || state.audioClients.every((value) => value.pcmCursorFrames > 0));
}

export function createPhase5FaultActuator({
  identity,
  agentProbe,
  instructionSink,
  monotonicNow,
  setTimer,
  clearTimer,
  workerRecovery,
} = {}) {
  if (identity === null || typeof identity !== 'object'
      || typeof identity.challenge !== 'string'
      || !/^[0-9a-f]{64}$/u.test(identity.challenge)
      || !['injectTimeout', 'recoverTimeout', 'injectMalformedResponse',
        'recoverMalformedResponse', 'getPlan'].every(
        (name) => typeof agentProbe?.[name] === 'function')
      || typeof instructionSink?.dispatch !== 'function'
      || typeof monotonicNow !== 'function'
      || typeof setTimer !== 'function'
      || typeof clearTimer !== 'function') {
    fail('PHASE5_FAULT_ACTUATOR_INPUT_INVALID');
  }
  if (!['peekPendingWorkerRecovery', 'releasePendingWorkerRecovery']
    .every((name) => typeof workerRecovery?.[name] === 'function')) {
    fail('PHASE5_FAULT_ACTUATOR_INPUT_INVALID');
  }
  const probePlan = agentProbe.getPlan();
  const plannedAudioEpoch = `phase5-${createHash('sha256')
    .update(`audio-epoch\0${identity.challenge}`)
    .digest('hex').slice(0, 32)}`;
  let lastPrepared = 0;
  let lastDispatched = 0;

  function prepareAction(plan, state, snapshot) {
    const sequence = plan.actionSequence;
    if (sequence !== lastPrepared + 1 || sequence !== lastDispatched + 1) {
      fail('PHASE5_FAULT_ACTUATOR_SEQUENCE_INVALID');
    }
    lastPrepared = sequence;
    if (sequence === 2) {
      const deadline = monotonicNow() + RECOVERY_SLO_MS['worker-crash-restart'];
      return (async () => {
        while (true) {
          const current = workerRecovery.peekPendingWorkerRecovery();
          if (current?.ready === true
              && current.recovering === false
              && current.lastExitSignal === 'SIGKILL') {
            return Object.freeze({
              actuatorSequence: sequence,
              supervisorGeneration: current.supervisorGeneration,
              observedPid: current.pid,
              observedAudioEpoch: current.audioEpoch,
              ready: true, recovering: false, accepted: true,
            });
          }
          const remaining = deadline - monotonicNow();
          if (remaining <= 0) {
            fail('PHASE5_FAULT_ACTUATOR_PREDICATE_TIMEOUT');
          }
          await new Promise((resolve) => {
            const timer = setTimer(() => {
              clearTimer(timer);
              resolve();
            }, Math.min(10, remaining));
          });
        }
      })();
    }
    const runtime = client4(state, 'runtimeClients');
    const audio = client4(state, 'audioClients');
    const edge = client4(state, 'egress');
    let receipt;
    if (sequence === 1) receipt = {
      actuatorSequence: sequence, pid: state.worker.pid, signal: 'SIGKILL',
      supervisorGeneration: state.worker.supervisorGeneration, accepted: true,
    };
    else if (sequence === 2) receipt = {
      actuatorSequence: sequence,
      supervisorGeneration: state.worker.supervisorGeneration,
      observedPid: state.worker.pid, observedAudioEpoch: state.worker.audioEpoch,
      ready: state.worker.ready, recovering: state.worker.recovering, accepted: true,
    };
    else if (sequence === 3) receipt = {
      actuatorSequence: sequence, clientId: 4,
      beforeGeneration: runtime.generation, closeCode: 1000,
      closeReason: 'PHASE5_RUNTIME_RECONNECT', accepted: true,
    };
    else if (sequence === 4 || sequence === 8) receipt = {
      actuatorSequence: sequence, clientId: 4,
      beforeGeneration: runtime.generation,
      afterGeneration: runtime.generation + 1,
      ...(sequence === 4
        ? { snapshotWorldGeneration: state.world.worldGeneration }
        : {}),
      accepted: true,
    };
    else if (sequence === 5 || sequence === 6) receipt = {
      actuatorSequence: sequence, clientId: 4,
      beforePaused: sequence === 5 ? audio.paused : true,
      afterPaused: sequence === 5, accepted: true,
    };
    else if (sequence === 7) receipt = {
      actuatorSequence: sequence, clientId: 4,
      capacityEntries: edge.capacityEntries,
      acceptedEntries: edge.capacityEntries, rejectedEntries: 1,
      closeCode: 4410, closeReason: 'EGRESS_OVERFLOW',
    };
    else if (sequence === 9) receipt = {
      actuatorSequence: sequence,
      requestId: probePlan.timeoutInjectedRequestId,
      fixture: 'timeout', fixtureId: probePlan.timeoutFixture.id,
      fixtureSha256: probePlan.timeoutFixture.sha256,
      attemptTimeoutMs: probePlan.timeoutFixture.attemptTimeoutMs,
      deadlineMs: probePlan.timeoutFixture.deadlineMs,
      idleAdmission: true, accepted: true,
    };
    else if (sequence === 10) receipt = {
      actuatorSequence: sequence, fixture: 'timeout',
      realRequestId: probePlan.timeoutRealRequestId, accepted: true,
    };
    else if (sequence === 11) receipt = {
      actuatorSequence: sequence,
      requestId: probePlan.malformedInjectedRequestId,
      fixture: 'malformed-response', accepted: true,
    };
    else if (sequence === 12) receipt = {
      actuatorSequence: sequence, fixture: 'malformed-response',
      realRequestId: probePlan.malformedRealRequestId, accepted: true,
    };
    else if (sequence === 13) receipt = {
      actuatorSequence: sequence, beforeAudioEpoch: state.worker.audioEpoch,
      afterAudioEpoch: plannedAudioEpoch, accepted: true,
    };
    else receipt = {
      actuatorSequence: sequence, audioEpoch: state.worker.audioEpoch,
      clientCount: state.audioClients.length, accepted: true,
    };
    return Object.freeze(receipt);
  }

  async function dispatchInstruction(sequence, signedEventBytes) {
    if (sequence !== lastDispatched + 1 || sequence !== lastPrepared
        || !Buffer.isBuffer(signedEventBytes)) {
      fail('PHASE5_FAULT_ACTUATOR_SEQUENCE_INVALID');
    }
    lastDispatched = sequence;
    if (sequence === 9) return agentProbe.injectTimeout();
    if (sequence === 10) return agentProbe.recoverTimeout();
    if (sequence === 11) return agentProbe.injectMalformedResponse();
    if (sequence === 12) return agentProbe.recoverMalformedResponse();
    if (sequence === 2) {
      workerRecovery.releasePendingWorkerRecovery();
      return undefined;
    }
    return instructionSink.dispatch(Object.freeze({
      schemaVersion: 1,
      kind: 'phase5-fixed-instruction',
      sequence,
      plannedAudioEpoch: sequence === 13 ? plannedAudioEpoch : null,
    }), Buffer.from(signedEventBytes));
  }

  async function waitForState(plan, snapshot) {
    const timeoutMs = plan.phase === 'before'
      ? 15_000 : RECOVERY_SLO_MS[plan.scenario];
    const deadline = monotonicNow() + timeoutMs;
    while (true) {
      let state = null;
      try { state = snapshot(); } catch { /* incomplete prefix; retry */ }
      if (state !== null && observed(plan, state, plannedAudioEpoch)) return state;
      const remaining = deadline - monotonicNow();
      if (remaining <= 0) fail('PHASE5_FAULT_ACTUATOR_PREDICATE_TIMEOUT');
      await new Promise((resolve) => {
        const timer = setTimer(() => {
          clearTimer(timer);
          resolve();
        }, Math.min(10, remaining));
      });
    }
  }

  return Object.freeze({ prepareAction, dispatchInstruction, waitForState });
}
