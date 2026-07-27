import assert from 'node:assert/strict';
import test from 'node:test';

import {
  providerFailure,
  providerOk,
  validateAgentReview,
  validateProviderInvocationResult,
} from '../../src/agents/contracts.js';

const review = {
  requestId: 'review-1',
  scheduleSeq: 1,
  worldId: 'default',
  worldGeneration: 'generation-a',
  scheduledWorldRevision: 7,
  reviewedDay: 2,
  applyBoundary: { kind: 'dawn', day: 3 },
  flockInput: { day: 2, flocks: [] },
  masterInput: { menu: {}, state: {}, observations: {} },
  createdAtMs: 100,
};

test('agent review requires the complete self-describing schedule identity', () => {
  const actual = validateAgentReview(review);
  assert.deepEqual(actual, review);
  assert.notEqual(actual, review);
  assert.equal(Object.isFrozen(actual), true);
  assert.equal(Object.isFrozen(actual.applyBoundary), true);
  for (const key of Object.keys(review)) {
    const invalid = structuredClone(review);
    delete invalid[key];
    assert.throws(() => validateAgentReview(invalid), /AGENT_REVIEW_INVALID/, key);
  }
  assert.throws(() => validateAgentReview({ ...review, extra: true }), /AGENT_REVIEW_INVALID/);
  assert.throws(() => validateAgentReview({ ...review, scheduleSeq: 0 }), /AGENT_REVIEW_INVALID/);
  assert.throws(() => validateAgentReview({
    ...review, applyBoundary: { kind: 'dawn', day: 2 },
  }), /AGENT_REVIEW_INVALID/);
});

test('provider invocation results are typed, strict, cloned, and frozen', () => {
  const value = { plan: [1, 2] };
  assert.deepEqual(providerOk(value), {
    ok: true, value, status: 'ok', code: 'OK', retryable: false, httpStatus: 200,
  });
  const failure = providerFailure({
    status: 'http_error', code: 'HTTP_429', retryable: true, httpStatus: 429,
  });
  assert.deepEqual(failure, {
    ok: false, value: null, status: 'http_error', code: 'HTTP_429',
    retryable: true, httpStatus: 429,
  });
  assert.equal(Object.isFrozen(failure), true);
  assert.deepEqual(validateProviderInvocationResult(failure), failure);
  assert.throws(() => providerFailure({
    status: 'unknown', code: 'X', retryable: false,
  }), /PROVIDER_INVOCATION_RESULT_INVALID/);
  assert.throws(() => validateProviderInvocationResult({
    ...failure, extra: true,
  }), /PROVIDER_INVOCATION_RESULT_INVALID/);
  assert.throws(() => validateProviderInvocationResult({
    ...failure, retryable: undefined,
  }), /PROVIDER_INVOCATION_RESULT_INVALID/);
});
