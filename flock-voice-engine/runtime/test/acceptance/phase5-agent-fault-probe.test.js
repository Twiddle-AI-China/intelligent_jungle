import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _createPhase5AgentFaultProbe,
  PHASE5_TIMEOUT_FIXTURE,
} from '../../src/acceptance/phase5-agent-fault-probe.js';
import {
  _createPhase5TransportRecorder,
} from '../../src/acceptance/phase5-transport-recorder.js';

function response(content) {
  return { ok: true, status: 200, async json() {
    return { choices: [{ message: { content } }] };
  } };
}

const validContent = JSON.stringify({
  flocks: [{
    reason: 'fixed recovery', dwellBeats: 1, activeBars: 2,
    holdLoops: 4, mutations: [], cellMutations: [],
  }],
  master: { ops: [] },
});

test('admitted probe owns fixed sequence, provider config and transport records', async () => {
  let monotonic = 1_000;
  const recorder = _createPhase5TransportRecorder({
    monotonicNow: () => (monotonic += 12_000),
    unixNow: () => 1_000_000 + monotonic,
    maxEvents: 20,
    maxBytes: 100_000,
  });
  const configs = [];
  const outcomes = ['timeout', 'ok', 'invalid_output', 'ok'];
  const runnerFactory = (config) => {
    configs.push(config);
    return {
      getStatus: () => ({ physicalInFlight: 0 }),
      tryStart(job) {
        const status = outcomes.shift();
        queueMicrotask(async () => {
          let invocation = null;
          if (status !== 'timeout') invocation = await job.invoke({});
          job.onSettled({
            requestId: job.requestId,
            status,
            reason: status === 'timeout' ? 'ATTEMPT_TIMEOUT'
              : status === 'invalid_output' ? 'INVALID_OUTPUT' : null,
            attempts: 1,
          });
          void invocation;
        });
        return { accepted: true };
      },
      close: async () => true,
    };
  };
  let ids = 0;
  const probe = _createPhase5AgentFaultProbe({
    authority: { getAdmission: () => ({
      kind: 'phase5-candidate-capture-admission',
    }) },
    recorder,
    runnerFactory,
    realFetch: async () => response(validContent),
    createRequestId: () => `request-${ids += 1}`,
    clock: { now: () => monotonic },
    setTimer: globalThis.setTimeout,
    clearTimer: globalThis.clearTimeout,
  });
  assert.equal((await probe.injectTimeout()).status, 'timeout');
  assert.equal((await probe.recoverTimeout()).status, 'ok');
  assert.equal((await probe.injectMalformedResponse()).status,
    'invalid_output');
  assert.equal((await probe.recoverMalformedResponse()).status, 'ok');
  assert.equal(probe.getLastResult().source, 'real');
  assert.equal(configs.every((value) => (
    value.attemptTimeoutMs === PHASE5_TIMEOUT_FIXTURE.attemptTimeoutMs
      && value.deadlineMs === PHASE5_TIMEOUT_FIXTURE.deadlineMs
      && value.maxAttempts === 1
  )), true);
  const events = recorder.flush();
  assert.deepEqual(events.map(({ type }) => type), [
    'agent.start', 'agent.settle', 'agent.start', 'agent.settle',
    'agent.start', 'agent.settle', 'agent.start', 'agent.settle',
  ]);
  assert.equal(events.every((event) => event.client === 0), true);
  await assert.rejects(probe.injectTimeout(),
    /PHASE5_AGENT_FAULT_PROBE_SEQUENCE_INVALID/u);
});

test('probe cannot be constructed without candidate admission authority', () => {
  assert.throws(() => _createPhase5AgentFaultProbe({
    authority: { getAdmission: () => ({ kind: 'forged' }) },
    recorder: { agentStart() {}, agentSettle() {} },
    runnerFactory() {}, realFetch() {}, createRequestId() {},
    clock: { now() { return 0; } }, setTimer() {}, clearTimer() {},
  }), /PHASE5_AGENT_FAULT_PROBE_ADMISSION_REQUIRED/u);
});
