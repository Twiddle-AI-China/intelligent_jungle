import assert from 'node:assert/strict';
import test from 'node:test';

import { providerFailure, providerOk } from '../../src/agents/contracts.js';
import { createProviderRunner } from '../../src/agents/provider-runner.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(callback, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + Math.max(0, delay), callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
  };
}

const flushPromises = () => new Promise((resolve) => { setImmediate(resolve); });

function runnerConfig(clock, overrides = {}) {
  return {
    channel: 'species',
    attemptTimeoutMs: 12_000,
    deadlineMs: 15_000,
    maxAttempts: 2,
    failureThreshold: 3,
    cooldownMs: 60_000,
    clock: { now: clock.now },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  };
}

test('Abort ignored by fetch never opens a second physical species call', async () => {
  const clock = createFakeClock();
  const hanging = deferred();
  const settled = deferred();
  let invocationCount = 0;
  const runner = createProviderRunner(runnerConfig(clock));
  assert.equal(runner.tryStart({
    requestId: 'a',
    invoke: () => { invocationCount += 1; return hanging.promise; },
    onSettled: settled.resolve,
  }).accepted, true);
  clock.advance(12_001);
  assert.equal((await settled.promise).status, 'timeout');
  assert.deepEqual(runner.tryStart({
    requestId: 'b', invoke: async () => providerOk({}), onSettled() {},
  }), { accepted: false, reason: 'busy', requestId: 'b' });
  assert.equal(invocationCount, 1);
  hanging.resolve(providerOk({ plan: [] }));
  await flushPromises();
  assert.equal(runner.getStatus().physicalInFlight, 0);
});

async function settleInvocation(invocationResult) {
  const settled = deferred();
  const clock = createFakeClock();
  const runner = createProviderRunner(runnerConfig(clock));
  let attempts = 0;
  assert.equal(runner.tryStart({
    requestId: 'typed',
    invoke: async () => { attempts += 1; return invocationResult; },
    onSettled: settled.resolve,
  }).accepted, true);
  await flushPromises();
  return { attempts, outcome: await settled.promise };
}

test('only typed retryable failures consume the second attempt', async () => {
  for (const failure of [
    providerFailure({ status: 'http_error', code: 'HTTP_429', retryable: true, httpStatus: 429 }),
    providerFailure({ status: 'http_error', code: 'HTTP_500', retryable: true, httpStatus: 500 }),
    providerFailure({ status: 'network_error', code: 'ECONNRESET', retryable: true }),
  ]) assert.equal((await settleInvocation(failure)).attempts, 2);

  for (const failure of [
    providerFailure({ status: 'http_error', code: 'HTTP_400', retryable: false, httpStatus: 400 }),
    providerFailure({ status: 'invalid_output', code: 'INVALID_OUTPUT', retryable: false }),
  ]) assert.equal((await settleInvocation(failure)).attempts, 1);

  const malformed = await settleInvocation({
    ok: false, value: null, status: 'http_error', code: 'HTTP_500',
  });
  assert.equal(malformed.attempts, 1);
  assert.equal(malformed.outcome.status, 'provider_error');
  assert.equal(malformed.outcome.reason, 'PROVIDER_INVOCATION_RESULT_INVALID');
});

test('retries share one absolute deadline', async () => {
  const clock = createFakeClock();
  const first = deferred();
  const second = deferred();
  const settled = deferred();
  let attempts = 0;
  const runner = createProviderRunner(runnerConfig(clock, { attemptTimeoutMs: 20_000 }));
  runner.tryStart({
    requestId: 'deadline',
    invoke: () => { attempts += 1; return attempts === 1 ? first.promise : second.promise; },
    onSettled: settled.resolve,
  });
  clock.advance(14_000);
  first.resolve(providerFailure({
    status: 'network_error', code: 'ECONNRESET', retryable: true,
  }));
  await flushPromises();
  assert.equal(attempts, 2);
  clock.advance(1_001);
  assert.equal((await settled.promise).status, 'timeout');
  second.resolve(providerOk({ late: true }));
  await flushPromises();
  assert.equal(runner.getStatus().physicalInFlight, 0);
});

test('three failed jobs open the circuit and cooldown admits one half-open probe', async () => {
  const clock = createFakeClock();
  const runner = createProviderRunner(runnerConfig(clock, { maxAttempts: 1 }));
  for (let index = 0; index < 3; index += 1) {
    const settled = deferred();
    assert.equal(runner.tryStart({
      requestId: `f${index}`,
      invoke: async () => providerFailure({
        status: 'http_error', code: 'HTTP_400', retryable: false, httpStatus: 400,
      }),
      onSettled: settled.resolve,
    }).accepted, true);
    await flushPromises();
    await settled.promise;
  }
  assert.deepEqual(runner.tryStart({
    requestId: 'blocked', invoke: async () => providerOk({}), onSettled() {},
  }), { accepted: false, reason: 'circuit_open', requestId: 'blocked' });

  clock.advance(60_000);
  const probe = deferred();
  assert.equal(runner.tryStart({
    requestId: 'probe', invoke: () => probe.promise, onSettled() {},
  }).accepted, true);
  assert.equal(runner.getStatus().circuitState, 'half_open');
  assert.equal(runner.tryStart({
    requestId: 'other', invoke: async () => providerOk({}), onSettled() {},
  }).reason, 'busy');
  probe.resolve(providerOk({ recovered: true }));
  await flushPromises();
  assert.equal(runner.getStatus().circuitState, 'closed');
  assert.equal(runner.getStatus().consecutiveFailures, 0);
});

test('master and species runner circuits do not affect each other', async () => {
  const clock = createFakeClock();
  const species = createProviderRunner(runnerConfig(clock, { maxAttempts: 1, failureThreshold: 1 }));
  const master = createProviderRunner(runnerConfig(clock, {
    channel: 'master', maxAttempts: 1, failureThreshold: 1, cooldownMs: 120_000,
  }));
  const done = deferred();
  species.tryStart({
    requestId: 'species-fail',
    invoke: async () => providerFailure({ status: 'invalid_output', code: 'BAD', retryable: false }),
    onSettled: done.resolve,
  });
  await done.promise;
  assert.equal(species.getStatus().circuitState, 'open');
  assert.equal(master.tryStart({
    requestId: 'master-ok', invoke: async () => providerOk({}), onSettled() {},
  }).accepted, true);
  await flushPromises();
  assert.equal(master.getStatus().circuitState, 'closed');
});

test('close aborts and logically settles an active job exactly once', async () => {
  const clock = createFakeClock();
  const hanging = deferred();
  const outcomes = [];
  const runner = createProviderRunner(runnerConfig(clock));
  runner.tryStart({ requestId: 'closing', invoke: () => hanging.promise, onSettled: (v) => outcomes.push(v) });
  runner.close();
  runner.close();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, 'disabled');
  assert.equal(outcomes[0].reason, 'RUNNER_CLOSED');
  hanging.resolve(providerOk({ late: true }));
  await flushPromises();
  assert.equal(outcomes.length, 1);
  assert.equal(runner.getStatus().physicalInFlight, 0);
  assert.deepEqual(runner.tryStart({
    requestId: 'after', invoke: async () => providerOk({}), onSettled() {},
  }), { accepted: false, reason: 'closed', requestId: 'after' });
});
