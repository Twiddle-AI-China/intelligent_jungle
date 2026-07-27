import { validateProviderInvocationResult } from './contracts.js';

const CHANNELS = new Set(['species', 'master']);

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`PROVIDER_RUNNER_INVALID_${name}`);
  return value;
}

function immutable(value) {
  return Object.freeze(value);
}

export function createProviderRunner({
  channel,
  attemptTimeoutMs,
  deadlineMs,
  maxAttempts,
  failureThreshold,
  cooldownMs,
  clock = { now: () => Date.now() },
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  if (!CHANNELS.has(channel)) throw new TypeError('PROVIDER_RUNNER_INVALID_CHANNEL');
  const attemptTimeout = positiveInteger(attemptTimeoutMs, 'ATTEMPT_TIMEOUT');
  const deadline = positiveInteger(deadlineMs, 'DEADLINE');
  const attemptsLimit = positiveInteger(maxAttempts, 'MAX_ATTEMPTS');
  const failuresLimit = positiveInteger(failureThreshold, 'FAILURE_THRESHOLD');
  const cooldown = positiveInteger(cooldownMs, 'COOLDOWN');
  if (!clock || typeof clock.now !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('PROVIDER_RUNNER_INVALID_CLOCK');
  }

  let closed = false;
  let active = null;
  let physicalInFlight = 0;
  let consecutiveFailures = 0;
  let circuitState = 'closed';
  let circuitOpenedUntilMs = null;

  function now() {
    const value = Number(clock.now());
    if (!Number.isFinite(value)) throw new TypeError('PROVIDER_RUNNER_INVALID_NOW');
    return value;
  }

  function updateCircuit(success) {
    if (success) {
      consecutiveFailures = 0;
      circuitState = 'closed';
      circuitOpenedUntilMs = null;
      return;
    }
    consecutiveFailures += 1;
    if (circuitState === 'half_open' || consecutiveFailures >= failuresLimit) {
      circuitState = 'open';
      circuitOpenedUntilMs = now() + cooldown;
    }
  }

  function deliver(job, result, { countForCircuit = true } = {}) {
    if (job.logicalSettled) return;
    job.logicalSettled = true;
    if (job.timer !== null) {
      clearTimer(job.timer);
      job.timer = null;
    }
    if (countForCircuit) updateCircuit(result.status === 'ok');
    const frozen = immutable({
      requestId: job.requestId,
      channel,
      status: result.status,
      value: result.value ?? null,
      attempts: job.attempts,
      startedAtMs: job.startedAtMs,
      settledAtMs: now(),
      reason: result.reason ?? null,
    });
    try { job.onSettled(frozen); } catch { /* consumer callbacks cannot corrupt runner state */ }
  }

  function finishPhysical(job) {
    if (job.timer !== null) {
      clearTimer(job.timer);
      job.timer = null;
    }
    physicalInFlight = 0;
    if (active === job && job.logicalSettled) active = null;
  }

  function settleFailure(job, invocation) {
    const status = invocation.status === 'invalid_output' ? 'invalid_output' : 'provider_error';
    deliver(job, { status, value: null, reason: invocation.code });
  }

  function startAttempt(job) {
    if (job.logicalSettled || closed) return;
    const remaining = job.deadlineAtMs - now();
    if (remaining <= 0) {
      deliver(job, { status: 'timeout', value: null, reason: 'DEADLINE_EXCEEDED' });
      if (physicalInFlight === 0 && active === job) active = null;
      return;
    }

    job.attempts += 1;
    const controller = new AbortController();
    job.controller = controller;
    physicalInFlight = 1;
    const timeoutMs = Math.min(attemptTimeout, remaining);
    job.timer = setTimer(() => {
      job.timer = null;
      controller.abort();
      deliver(job, {
        status: 'timeout',
        value: null,
        reason: timeoutMs === remaining ? 'DEADLINE_EXCEEDED' : 'ATTEMPT_TIMEOUT',
      });
    }, timeoutMs);

    let invocationPromise;
    try {
      invocationPromise = Promise.resolve(job.invoke({
        signal: controller.signal,
        attempt: job.attempts,
        deadlineAtMs: job.deadlineAtMs,
      }));
    } catch {
      invocationPromise = Promise.reject(new Error('PROVIDER_INVOKE_THROWN'));
    }

    invocationPromise.then((raw) => {
      finishPhysical(job);
      if (job.logicalSettled) return;
      let invocation;
      try {
        invocation = validateProviderInvocationResult(raw);
      } catch {
        deliver(job, {
          status: 'provider_error', value: null, reason: 'PROVIDER_INVOCATION_RESULT_INVALID',
        });
        active = null;
        return;
      }
      if (invocation.ok) {
        deliver(job, { status: 'ok', value: invocation.value, reason: null });
        active = null;
        return;
      }
      if (invocation.retryable && job.attempts < attemptsLimit && now() < job.deadlineAtMs) {
        startAttempt(job);
        return;
      }
      settleFailure(job, invocation);
      active = null;
    }, () => {
      finishPhysical(job);
      if (job.logicalSettled) return;
      deliver(job, { status: 'provider_error', value: null, reason: 'PROVIDER_INVOKE_REJECTED' });
      active = null;
    });
  }

  function tryStart({ requestId, invoke, onSettled } = {}) {
    const id = typeof requestId === 'string' ? requestId : '';
    if (closed) return immutable({ accepted: false, reason: 'closed', requestId: id });
    if (physicalInFlight > 0 || active !== null) {
      return immutable({ accepted: false, reason: 'busy', requestId: id });
    }
    const currentTime = now();
    if (circuitState === 'open') {
      if (currentTime < circuitOpenedUntilMs) {
        return immutable({ accepted: false, reason: 'circuit_open', requestId: id });
      }
      circuitState = 'half_open';
    } else if (circuitState === 'half_open') {
      return immutable({ accepted: false, reason: 'circuit_open', requestId: id });
    }
    if (!id || typeof invoke !== 'function' || typeof onSettled !== 'function') {
      if (circuitState === 'half_open') circuitState = 'open';
      return immutable({ accepted: false, reason: 'invalid_job', requestId: id });
    }

    active = {
      requestId: id,
      invoke,
      onSettled,
      attempts: 0,
      startedAtMs: currentTime,
      deadlineAtMs: currentTime + deadline,
      controller: null,
      timer: null,
      logicalSettled: false,
    };
    startAttempt(active);
    return immutable({ accepted: true, reason: null, requestId: id });
  }

  function getStatus() {
    return immutable({
      channel,
      closed,
      physicalInFlight,
      circuitState,
      consecutiveFailures,
      circuitOpenedUntilMs,
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    if (!active) return;
    active.controller?.abort();
    deliver(active, {
      status: 'disabled', value: null, reason: 'RUNNER_CLOSED',
    }, { countForCircuit: false });
    if (physicalInFlight === 0) active = null;
  }

  return immutable({ tryStart, getStatus, close });
}
