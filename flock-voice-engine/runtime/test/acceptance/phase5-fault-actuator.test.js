import assert from 'node:assert/strict';
import test from 'node:test';

import { createPhase5FaultActuator } from '../../src/acceptance/phase5-fault-actuator.js';

function state() {
  return {
    world: { worldGeneration: 'world-a', revision: 1, eventSeq: 1 },
    runtimeClients: Array.from({ length: 4 }, (_, index) => ({
      clientId: index + 1, connected: true, generation: 1,
      snapshotWorldGeneration: 'world-a',
    })),
    audioClients: Array.from({ length: 4 }, (_, index) => ({
      clientId: index + 1, connected: true, generation: 1,
      audioEpoch: 'epoch-a', pcmCursorFrames: 4096,
      discontinuityCount: 0, paused: false,
    })),
    worker: { pid: 500, ready: true, recovering: false,
      restartCount: 0, audioEpoch: 'epoch-a', supervisorGeneration: 1,
      lastExitedPid: null, lastExitSignal: null },
    egress: Array.from({ length: 4 }, (_, index) => ({
      clientId: index + 1, generation: 1, queuedEntries: 0,
      capacityEntries: 256, closed: false, closeCode: null,
      closeReason: null,
    })),
    provider: { lastResult: null },
  };
}

function plan(sequence, operation = 'fixed', target = 'fixed') {
  return { scenario: 'worker-crash-restart', phase: 'fault-action',
    actionSequence: sequence, operation, target };
}

test('actuator owns all fourteen instructions and provider fixtures', async () => {
  const dispatched = [];
  const providerCalls = [];
  const probe = {
    injectTimeout: async () => providerCalls.push('inject-timeout'),
    recoverTimeout: async () => providerCalls.push('recover-timeout'),
    injectMalformedResponse: async () => providerCalls.push('inject-malformed'),
    recoverMalformedResponse: async () => providerCalls.push('recover-malformed'),
    getPlan: () => ({
      timeoutInjectedRequestId: 'phase5-timeout-injected',
      timeoutRealRequestId: 'phase5-timeout-real',
      malformedInjectedRequestId: 'phase5-malformed-injected',
      malformedRealRequestId: 'phase5-malformed-real',
      timeoutFixture: { id: 'phase5-timeout-hold-open-v1',
        sha256: '1'.repeat(64), attemptTimeoutMs: 12_000, deadlineMs: 15_000 },
    }),
  };
  let now = 0;
  let pendingRecovery = null;
  const workerRecovery = {
    peekPendingWorkerRecovery: () => pendingRecovery,
    releasePendingWorkerRecovery: () => {
      assert.notEqual(pendingRecovery, null);
      pendingRecovery = null;
    },
  };
  const actuator = createPhase5FaultActuator({
    identity: { challenge: 'a'.repeat(64) },
    agentProbe: probe,
    instructionSink: { dispatch(value) { dispatched.push(value); } },
    monotonicNow: () => now,
    setTimer: (callback) => { now += 10; queueMicrotask(callback); return 1; },
    clearTimer() {},
    workerRecovery,
  });
  const current = state();
  const receipts = [];
  for (let sequence = 1; sequence <= 14; sequence += 1) {
    if (sequence === 2) {
      current.worker = { pid: 501, ready: true, recovering: false,
        restartCount: 1, audioEpoch: 'epoch-b', supervisorGeneration: 2,
        lastExitedPid: 500, lastExitSignal: 'SIGKILL' };
      pendingRecovery = structuredClone(current.worker);
    } else if (sequence === 4 || sequence === 8) {
      current.runtimeClients[3].connected = false;
      current.runtimeClients[3].snapshotWorldGeneration = null;
      if (sequence === 8) current.egress[3].closed = true;
    } else if (sequence === 6) current.audioClients[3].paused = true;
    else if (sequence === 10) current.provider.lastResult = { status: 'timeout' };
    else if (sequence === 12) current.provider.lastResult = { status: 'invalid_output' };
    else if (sequence === 14) {
      const epoch = receipts[12].afterAudioEpoch;
      current.worker.audioEpoch = epoch;
      current.audioClients.forEach((value) => { value.audioEpoch = epoch; });
    }
    const receipt = await actuator.prepareAction(plan(sequence), current);
    receipts.push(receipt);
    await actuator.dispatchInstruction(sequence, Buffer.from(`signed-${sequence}`));
    if (sequence === 4 || sequence === 8) {
      current.runtimeClients[3].generation += 1;
      current.runtimeClients[3].connected = true;
      current.runtimeClients[3].snapshotWorldGeneration = 'world-a';
      current.egress[3].generation += 1;
      current.egress[3].closed = false;
    }
    if (sequence === 5) current.audioClients[3].paused = true;
    if (sequence === 6) current.audioClients[3].paused = false;
  }
  assert.deepEqual(receipts.map((value) => value.actuatorSequence),
    Array.from({ length: 14 }, (_, index) => index + 1));
  assert.equal(receipts[8].fixtureId, 'phase5-timeout-hold-open-v1');
  assert.equal(receipts[12].beforeAudioEpoch, 'epoch-b');
  assert.match(receipts[12].afterAudioEpoch, /^phase5-[0-9a-f]{32}$/u);
  assert.deepEqual(providerCalls, [
    'inject-timeout', 'recover-timeout', 'inject-malformed', 'recover-malformed',
  ]);
  assert.deepEqual(dispatched.map((value) => value.sequence),
    [1, 3, 4, 5, 6, 7, 8, 13, 14]);
});

test('state wait uses a fixed deadline and rejects missing recovery', async () => {
  let now = 0;
  const actuator = createPhase5FaultActuator({
    identity: { challenge: 'b'.repeat(64) },
    agentProbe: {
      injectTimeout() {}, recoverTimeout() {}, injectMalformedResponse() {},
      recoverMalformedResponse() {}, getPlan: () => ({ timeoutFixture: {} }),
    },
    instructionSink: { dispatch() {} },
    monotonicNow: () => now,
    setTimer: (callback, delay) => { now += delay; queueMicrotask(callback); return 1; },
    clearTimer() {},
    workerRecovery: {
      peekPendingWorkerRecovery: () => null,
      releasePendingWorkerRecovery() {},
    },
  });
  const current = state();
  current.runtimeClients[3].connected = false;
  await assert.rejects(actuator.waitForState({
    scenario: 'runtime-reconnect', phase: 'recovery-observed',
  }, () => structuredClone(current)),
  /PHASE5_FAULT_ACTUATOR_PREDICATE_TIMEOUT/u);
});
