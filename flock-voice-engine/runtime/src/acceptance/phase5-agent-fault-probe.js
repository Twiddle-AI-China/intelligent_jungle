import { randomUUID } from 'node:crypto';

import { createProviderRunner } from '../agents/provider-runner.js';
import { createSpeciesProvider } from '../agents/species-provider.js';

export const PHASE5_TIMEOUT_FIXTURE = Object.freeze({
  id: 'phase5-timeout-hold-open-v1',
  sha256: '12baea86a4fdc350efbfaea53fde6f60b330db5292e860c84a9bef4606eac598',
  attemptTimeoutMs: 12_000,
  deadlineMs: 15_000,
});

const FIXED_FLOCK_INPUT = Object.freeze({
  day: 1,
  flocks: Object.freeze([Object.freeze({
    species: 'melody',
    homeBranches: Object.freeze([0, 1]),
    menu: Object.freeze({
      dwellBeats: Object.freeze([0.5, 2]),
      activeBars: Object.freeze([0, 4]),
      holdLoops: Object.freeze([2, 8]),
      maxMutations: 2,
    }),
  })]),
});

function fail(code) {
  throw new Error(code);
}

function timeoutFetch(_url, { signal } = {}) {
  return new Promise((_resolve, reject) => {
    if (!signal || typeof signal.addEventListener !== 'function') {
      reject(new Error('PHASE5_TIMEOUT_SIGNAL_REQUIRED'));
      return;
    }
    signal.addEventListener('abort', () => {
      const error = new Error('phase5 fixed timeout');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

async function malformedFetch() {
  return Object.freeze({
    ok: true,
    status: 200,
    async json() {
      return Object.freeze({
        choices: Object.freeze([Object.freeze({
          message: Object.freeze({
            content: '{"phase5":"malformed-fixed-response"}',
          }),
        })]),
      });
    },
  });
}

export function _createPhase5AgentFaultProbe({
  authority,
  recorder,
  runnerFactory,
  realFetch,
  createRequestId,
  clock,
  setTimer,
  clearTimer,
} = {}) {
  if (typeof authority?.getAdmission !== 'function'
      || !['agentStart', 'agentSettle'].every(
        (name) => typeof recorder?.[name] === 'function')
      || typeof runnerFactory !== 'function'
      || typeof realFetch !== 'function'
      || typeof createRequestId !== 'function'
      || typeof clock?.now !== 'function'
      || typeof setTimer !== 'function'
      || typeof clearTimer !== 'function') {
    fail('PHASE5_AGENT_FAULT_PROBE_INPUT_INVALID');
  }
  const admission = authority.getAdmission();
  if (admission?.kind !== 'phase5-candidate-capture-admission') {
    fail('PHASE5_AGENT_FAULT_PROBE_ADMISSION_REQUIRED');
  }
  let phase = 0;
  let lastResult = null;
  const requestIds = Object.freeze([
    `phase5-${createRequestId()}`,
    `phase5-${createRequestId()}`,
    `phase5-${createRequestId()}`,
    `phase5-${createRequestId()}`,
  ]);

  async function execute(expectedPhase, source, fetchImpl) {
    if (phase !== expectedPhase) {
      fail('PHASE5_AGENT_FAULT_PROBE_SEQUENCE_INVALID');
    }
    phase += 1;
    const requestId = requestIds[expectedPhase];
    const provider = createSpeciesProvider({ fetchImpl });
    const runner = runnerFactory({
      channel: 'species',
      attemptTimeoutMs: PHASE5_TIMEOUT_FIXTURE.attemptTimeoutMs,
      deadlineMs: PHASE5_TIMEOUT_FIXTURE.deadlineMs,
      maxAttempts: 1,
      failureThreshold: 3,
      cooldownMs: 60_000,
      clock,
      setTimer,
      clearTimer,
    });
    if (runner?.getStatus?.().physicalInFlight !== 0) {
      fail('PHASE5_AGENT_FAULT_PROBE_NOT_IDLE');
    }
    const start = recorder.agentStart({
      requestId,
      source,
      model: 'bird_agent',
      attempts: 1,
    });
    let invocation = null;
    const result = await new Promise((resolve, reject) => {
      const accepted = runner.tryStart({
        requestId,
        invoke: async (options) => {
          invocation = await provider.request(FIXED_FLOCK_INPUT, options);
          return invocation;
        },
        onSettled: resolve,
      });
      if (accepted?.accepted !== true) {
        reject(new Error('PHASE5_AGENT_FAULT_PROBE_NOT_IDLE'));
      }
    });
    const httpStatus = result.status === 'timeout'
      ? null : invocation?.httpStatus ?? null;
    const settled = recorder.agentSettle({
      requestId,
      source,
      model: 'bird_agent',
      status: result.status,
      reason: result.reason,
      attempts: result.attempts,
      httpStatus,
    });
    lastResult = Object.freeze({ ...settled.payload });
    await runner.close();
    return lastResult;
  }

  return Object.freeze({
    injectTimeout() {
      return execute(0, 'injected', timeoutFetch);
    },
    recoverTimeout() {
      return execute(1, 'real', realFetch);
    },
    injectMalformedResponse() {
      return execute(2, 'injected', malformedFetch);
    },
    recoverMalformedResponse() {
      return execute(3, 'real', realFetch);
    },
    getLastResult() {
      return lastResult === null ? null : Object.freeze({ ...lastResult });
    },
    getPlan() {
      return Object.freeze({
        timeoutInjectedRequestId: requestIds[0],
        timeoutRealRequestId: requestIds[1],
        malformedInjectedRequestId: requestIds[2],
        malformedRealRequestId: requestIds[3],
        timeoutFixture: PHASE5_TIMEOUT_FIXTURE,
      });
    },
  });
}

export function createPhase5AgentFaultProbe({ authority, recorder } = {}) {
  return _createPhase5AgentFaultProbe({
    authority,
    recorder,
    runnerFactory: createProviderRunner,
    realFetch: globalThis.fetch,
    createRequestId: randomUUID,
    clock: { now: () => performance.now() },
    setTimer: globalThis.setTimeout,
    clearTimer: globalThis.clearTimeout,
  });
}
