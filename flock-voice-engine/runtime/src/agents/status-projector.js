const STATUSES = new Set([
  'ok', 'disabled', 'gated', 'busy', 'timeout', 'circuit_open',
  'provider_error', 'invalid_output', 'stale_discarded', 'missing', 'already_consumed',
]);
const STABLE_REASONS = new Set([
  'admitted', 'telemetry_unknown', 'worker_not_ready', 'worker_recovering',
  'pcm_headroom_low', 'audio_queue_depth_high', 'render_p95_high',
  'render_p99_high', 'recent_underrun', 'unified_memory_low',
  'disabled', 'closed', 'busy', 'circuit_open', 'initialization_pending',
  'deepseek_capability_unavailable', 'result_missing', 'current_domain_rejected',
  'already_consumed', 'stale_discarded', 'not_scheduled',
  'OK', 'ABORTED', 'NETWORK_ERROR', 'ECONNRESET', 'ECONNREFUSED',
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'DEADLINE_EXCEEDED',
  'ATTEMPT_TIMEOUT', 'INVALID_HTTP_RESPONSE', 'INVALID_INPUT',
  'INVALID_OUTPUT', 'PROVIDER_INVOCATION_RESULT_INVALID',
  'PROVIDER_INVOKE_REJECTED', 'RUNNER_CLOSED',
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function reason(value) {
  if (value === null || value === undefined) return null;
  if (STABLE_REASONS.has(value)) return value;
  if (typeof value === 'string' && /^HTTP_[1-5][0-9]{2}$/.test(value)) return value;
  return 'status_unavailable';
}

function requestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9:._-]{1,160}$/.test(value)
    ? value : null;
}

function projectChannel(value = {}) {
  return deepFreeze({
    enabled: value.enabled === true,
    status: STATUSES.has(value.status) ? value.status : 'disabled',
    source: value.source === 'llm' ? 'llm' : 'policy',
    reason: reason(value.reason),
    requestId: requestId(value.requestId),
    latencyMs: Number.isFinite(value.latencyMs) && value.latencyMs >= 0
      ? value.latencyMs : null,
    circuitState: ['closed', 'open', 'half_open'].includes(value.circuitState)
      ? value.circuitState : 'closed',
  });
}

function projectDecisionChannel(value = {}) {
  return deepFreeze({
    source: value.source === 'llm' ? 'llm' : 'policy',
    status: STATUSES.has(value.status) ? value.status : 'disabled',
    reason: reason(value.reason),
  });
}

function projectDecision(value) {
  if (!value || typeof value !== 'object') return null;
  const reviewedDay = Number.isSafeInteger(value.reviewedDay) && value.reviewedDay >= 0
    ? value.reviewedDay : null;
  const boundaryDay = Number.isSafeInteger(value.applyBoundary?.day)
    && value.applyBoundary.day >= 0 ? value.applyBoundary.day : null;
  return deepFreeze({
    requestId: requestId(value.requestId),
    scheduleSeq: Number.isSafeInteger(value.scheduleSeq) && value.scheduleSeq >= 0
      ? value.scheduleSeq : 0,
    reviewedDay,
    applyBoundary: boundaryDay === null ? null : { kind: 'dawn', day: boundaryDay },
    species: projectDecisionChannel(value.species),
    master: projectDecisionChannel(value.master),
  });
}

export function projectAgentStatus(internal = {}) {
  return deepFreeze({
    species: projectChannel(internal?.species),
    master: projectChannel(internal?.master),
    lastDecision: projectDecision(internal?.lastDecision),
  });
}
