const REVIEW_KEYS = Object.freeze([
  'requestId',
  'scheduleSeq',
  'worldId',
  'worldGeneration',
  'scheduledWorldRevision',
  'reviewedDay',
  'applyBoundary',
  'flockInput',
  'masterInput',
  'createdAtMs',
]);

const INVOCATION_KEYS = Object.freeze([
  'ok', 'value', 'status', 'code', 'retryable', 'httpStatus',
]);

const PROVIDER_STATUSES = new Set([
  'ok', 'http_error', 'network_error', 'invalid_output',
]);

function invalid(code) {
  const error = new TypeError(code);
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function cloneJsonData(value, code) {
  const seen = new WeakSet();

  function visit(current) {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) throw invalid(code);
      return current;
    }
    if (typeof current !== 'object' || seen.has(current)) throw invalid(code);
    seen.add(current);

    const descriptors = Object.getOwnPropertyDescriptors(current);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key === 'symbol')) throw invalid(code);

    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype
        || ownKeys.length !== current.length + 1) throw invalid(code);
      const result = new Array(current.length);
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid(code);
        result[index] = visit(descriptor.value);
      }
      return result;
    }

    if (Object.getPrototypeOf(current) !== Object.prototype) throw invalid(code);
    const result = {};
    for (const key of ownKeys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor)) throw invalid(code);
      result[key] = visit(descriptor.value);
    }
    return result;
  }

  return visit(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validHttpStatus(value, { nullable = false } = {}) {
  return (nullable && value === null)
    || (Number.isInteger(value) && value >= 100 && value <= 599);
}

export function validateAgentReview(value) {
  const code = 'AGENT_REVIEW_INVALID';
  let review;
  try {
    review = cloneJsonData(value, code);
  } catch {
    throw invalid(code);
  }
  if (!hasExactKeys(review, REVIEW_KEYS)
    || !nonEmptyString(review.requestId)
    || !Number.isSafeInteger(review.scheduleSeq) || review.scheduleSeq < 1
    || review.worldId !== 'default'
    || !nonEmptyString(review.worldGeneration)
    || !nonNegativeSafeInteger(review.scheduledWorldRevision)
    || !nonNegativeSafeInteger(review.reviewedDay)
    || !nonNegativeSafeInteger(review.createdAtMs)
    || !hasExactKeys(review.applyBoundary, ['kind', 'day'])
    || review.applyBoundary.kind !== 'dawn'
    || review.applyBoundary.day !== review.reviewedDay + 1
    || !isPlainRecord(review.flockInput)
    || !isPlainRecord(review.masterInput)) {
    throw invalid(code);
  }
  return deepFreeze(review);
}

export function validateProviderInvocationResult(value) {
  const code = 'PROVIDER_INVOCATION_RESULT_INVALID';
  let result;
  try {
    result = cloneJsonData(value, code);
  } catch {
    throw invalid(code);
  }
  if (!hasExactKeys(result, INVOCATION_KEYS)
    || typeof result.ok !== 'boolean'
    || !PROVIDER_STATUSES.has(result.status)
    || !nonEmptyString(result.code)
    || typeof result.retryable !== 'boolean') throw invalid(code);

  if (result.ok) {
    if (result.status !== 'ok' || result.code !== 'OK' || result.retryable
      || result.value === null || !validHttpStatus(result.httpStatus)) throw invalid(code);
  } else if (result.status === 'ok' || result.value !== null
    || !validHttpStatus(result.httpStatus, { nullable: true })) {
    throw invalid(code);
  }
  return deepFreeze(result);
}

export function providerOk(value, httpStatus = 200) {
  return validateProviderInvocationResult({
    ok: true,
    value,
    status: 'ok',
    code: 'OK',
    retryable: false,
    httpStatus,
  });
}

export function providerFailure({ status, code, retryable, httpStatus = null } = {}) {
  return validateProviderInvocationResult({
    ok: false,
    value: null,
    status,
    code,
    retryable,
    httpStatus,
  });
}
