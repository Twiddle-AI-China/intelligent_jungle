import { validateAgentReview } from './contracts.js';

const CHANNELS = Object.freeze(['species', 'master']);
const PROVIDER_STATUSES = new Set([
  'ok', 'disabled', 'gated', 'busy', 'timeout', 'circuit_open',
  'provider_error', 'invalid_output',
]);
const ENVELOPE_KEYS = Object.freeze([
  'requestId', 'scheduleSeq', 'worldId', 'worldGeneration',
  'scheduledWorldRevision', 'reviewedDay', 'applyBoundary', 'channel', 'provider',
]);
const PROVIDER_KEYS = Object.freeze([
  'requestId', 'channel', 'status', 'value', 'attempts',
  'startedAtMs', 'settledAtMs', 'reason',
]);

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected) {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length
    && actual.every((key, index) => key === keys[index]);
}

function safeInteger(value, positive = false) {
  return Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function safeClone(value) {
  try {
    const cloned = structuredClone(value);
    JSON.stringify(cloned);
    return deepFreeze(cloned);
  } catch {
    return null;
  }
}

function boundaryKey(value) {
  return `${value.worldGeneration}:${value.kind ?? value.applyBoundary?.kind}:${value.day ?? value.applyBoundary?.day}`;
}

function validateProviderResult(value, requestId, channel) {
  if (!exactKeys(value, PROVIDER_KEYS)
    || value.requestId !== requestId
    || value.channel !== channel
    || !PROVIDER_STATUSES.has(value.status)
    || !safeInteger(value.attempts)
    || !safeInteger(value.startedAtMs)
    || !safeInteger(value.settledAtMs)
    || value.settledAtMs < value.startedAtMs
    || !(value.reason === null || typeof value.reason === 'string')
    || (value.status === 'ok' ? value.value === null : value.value !== null)) return null;
  return safeClone(value);
}

function validateEnvelope(value) {
  if (!exactKeys(value, ENVELOPE_KEYS)
    || typeof value.requestId !== 'string' || !value.requestId
    || !safeInteger(value.scheduleSeq, true)
    || value.worldId !== 'default'
    || typeof value.worldGeneration !== 'string' || !value.worldGeneration
    || !safeInteger(value.scheduledWorldRevision)
    || !safeInteger(value.reviewedDay)
    || !exactKeys(value.applyBoundary, ['kind', 'day'])
    || value.applyBoundary.kind !== 'dawn'
    || value.applyBoundary.day !== value.reviewedDay + 1
    || !CHANNELS.includes(value.channel)) return null;
  const provider = validateProviderResult(value.provider, value.requestId, value.channel);
  if (!provider) return null;
  return deepFreeze({
    requestId: value.requestId,
    scheduleSeq: value.scheduleSeq,
    worldId: value.worldId,
    worldGeneration: value.worldGeneration,
    scheduledWorldRevision: value.scheduledWorldRevision,
    reviewedDay: value.reviewedDay,
    applyBoundary: safeClone(value.applyBoundary),
    channel: value.channel,
    provider,
  });
}

function syntheticProvider(requestId, channel, status, reason, nowMs) {
  return deepFreeze({
    requestId,
    channel,
    status,
    value: null,
    attempts: 0,
    startedAtMs: nowMs,
    settledAtMs: nowMs,
    reason,
  });
}

export function createAgentOrchestrator({
  speciesRunner,
  masterRunner,
  admission,
  policies,
  publishEnvelope,
  clock = { now: () => Date.now() },
} = {}) {
  if (!speciesRunner || !masterRunner
    || typeof admission !== 'function'
    || !policies || CHANNELS.some((channel) => typeof policies[channel] !== 'function')
    || typeof policies.validateSpecies !== 'function'
    || typeof policies.validateMaster !== 'function'
    || typeof publishEnvelope !== 'function'
    || typeof clock?.now !== 'function') throw new TypeError('AGENT_ORCHESTRATOR_INVALID');

  const latestByBoundary = new Map();
  const byRequestId = new Map();
  const consumedBoundaries = new Map();
  const MAX_TOMBSTONES = 64;
  let activeGeneration = null;
  let closed = false;
  const publicState = {
    lastSpeciesStatus: 'disabled',
    lastMasterStatus: 'disabled',
    species: { enabled: false, status: 'disabled', source: 'policy', reason: 'not_scheduled' },
    master: { enabled: false, status: 'disabled', source: 'policy', reason: 'not_scheduled' },
    lastDecision: null,
  };

  const currentTime = () => {
    const value = Number(clock.now());
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };

  function mark(channel, status, details = {}) {
    publicState[`last${channel[0].toUpperCase()}${channel.slice(1)}Status`] = status;
    publicState[channel] = { ...publicState[channel], status, ...details };
  }

  function publish(request, channel, provider) {
    if (closed) return;
    const result = validateProviderResult(provider, request.requestId, channel);
    if (!result) return;
    const value = deepFreeze({
      requestId: request.requestId,
      scheduleSeq: request.scheduleSeq,
      worldId: request.worldId,
      worldGeneration: request.worldGeneration,
      scheduledWorldRevision: request.scheduledWorldRevision,
      reviewedDay: request.reviewedDay,
      applyBoundary: safeClone(request.applyBoundary),
      channel,
      provider: result,
    });
    try { publishEnvelope(value); } catch { /* mailbox publisher owns delivery errors */ }
  }

  function startChannel(record, channel) {
    const request = record.request;
    const runner = channel === 'species' ? speciesRunner : masterRunner;
    if (channel === 'species') {
      let gate;
      try { gate = admission(request); } catch { gate = null; }
      if (!gate?.admitted) {
        const reason = typeof gate?.reason === 'string' ? gate.reason : 'telemetry_unknown';
        record.results.species = syntheticProvider(
          request.requestId, channel, 'gated', reason, currentTime(),
        );
        mark(channel, 'gated', { enabled: false, source: 'policy', reason });
        return;
      }
    }

    const input = channel === 'species' ? request.flockInput : request.masterInput;
    const started = runner.tryStart({
      requestId: request.requestId,
      invoke: ({ signal, attempt, deadlineAtMs }) => runner.providerRequest
        ? runner.providerRequest(input, { signal, attempt, deadlineAtMs })
        : Promise.resolve(null),
      onSettled: (provider) => publish(request, channel, provider),
    });
    if (!started?.accepted) {
      const reason = typeof started?.reason === 'string' ? started.reason : 'disabled';
      const status = PROVIDER_STATUSES.has(reason) ? reason : 'disabled';
      record.results[channel] = syntheticProvider(
        request.requestId, channel, status, reason, currentTime(),
      );
      mark(channel, status, { enabled: false, source: 'policy', reason });
    } else {
      mark(channel, 'busy', { enabled: true, source: 'policy', reason: null, requestId: request.requestId });
    }
  }

  function scheduleReview(value) {
    if (closed) return false;
    let request;
    try { request = validateAgentReview(value); } catch { return false; }
    resetGeneration(request.worldGeneration);
    const key = boundaryKey(request.applyBoundary.kind === 'dawn' ? {
      worldGeneration: request.worldGeneration,
      kind: request.applyBoundary.kind,
      day: request.applyBoundary.day,
    } : request);
    if (consumedBoundaries.has(key)) return false;
    const previous = latestByBoundary.get(key);
    if (previous) {
      if (request.scheduleSeq < previous.request.scheduleSeq
        || (request.scheduleSeq === previous.request.scheduleSeq
          && request.requestId !== previous.request.requestId)) return false;
      if (request.scheduleSeq === previous.request.scheduleSeq
        && request.requestId === previous.request.requestId) return true;
    }
    const record = { request, key, results: { species: null, master: null }, consumed: false };
    latestByBoundary.set(key, record);
    byRequestId.set(request.requestId, record);
    startChannel(record, 'species');
    startChannel(record, 'master');
    return true;
  }

  function stale(channel) {
    mark(channel, 'stale_discarded', { source: 'policy', reason: 'stale_discarded' });
    return false;
  }

  function acceptEnvelope(raw, context = {}) {
    if (closed) return false;
    const value = validateEnvelope(raw);
    if (!value) return false;
    if (activeGeneration !== null && value.worldGeneration !== activeGeneration) {
      return stale(value.channel);
    }
    const record = byRequestId.get(value.requestId);
    if (!record) return stale(value.channel);
    const request = record.request;
    const latest = latestByBoundary.get(record.key);
    const identityMatches = request.scheduleSeq === value.scheduleSeq
      && request.worldId === value.worldId
      && request.worldGeneration === value.worldGeneration
      && request.scheduledWorldRevision === value.scheduledWorldRevision
      && request.reviewedDay === value.reviewedDay
      && request.applyBoundary.kind === value.applyBoundary.kind
      && request.applyBoundary.day === value.applyBoundary.day;
    if (!identityMatches
      || latest !== record
      || record.consumed
      || consumedBoundaries.has(record.key)
      || context.worldGeneration !== value.worldGeneration
      || !safeInteger(context.currentWorldRevision)
      || value.scheduledWorldRevision > context.currentWorldRevision
      || !safeInteger(context.currentDay)
      || context.currentDay >= value.applyBoundary.day) return stale(value.channel);
    if (record.results[value.channel]?.attempts > 0) return true;
    record.results[value.channel] = value.provider;
    mark(value.channel, value.provider.status, {
      enabled: true,
      source: value.provider.status === 'ok' ? 'llm' : 'policy',
      reason: value.provider.reason,
      requestId: value.requestId,
      latencyMs: value.provider.settledAtMs - value.provider.startedAtMs,
    });
    return true;
  }

  function policyDecision(channel, request, currentDomain, status, reason) {
    let value = null;
    try { value = policies[channel](request, currentDomain); } catch { value = null; }
    return deepFreeze({ source: 'policy', status, value: safeClone(value), reason });
  }

  function decideChannel(channel, record, currentDomain) {
    const provider = record?.results[channel] ?? null;
    if (!provider) return policyDecision(channel, record?.request ?? null, currentDomain, 'missing', 'result_missing');
    if (provider.status !== 'ok') {
      return policyDecision(channel, record.request, currentDomain, provider.status, provider.reason ?? provider.status);
    }
    const validator = channel === 'species' ? policies.validateSpecies : policies.validateMaster;
    let value = null;
    try { value = validator(provider.value, currentDomain, record.request); } catch { value = null; }
    const cloned = safeClone(value);
    if (cloned === null) {
      return policyDecision(channel, record.request, currentDomain, 'invalid_output', 'current_domain_rejected');
    }
    return deepFreeze({ source: 'llm', status: 'ok', value: cloned, reason: provider.reason ?? 'OK' });
  }

  function takeForBoundary(boundary = {}) {
    resetGeneration(boundary.worldGeneration);
    const key = boundaryKey(boundary);
    const currentDomain = boundary.currentDomain ?? {};
    const record = latestByBoundary.get(key) ?? null;
    if (consumedBoundaries.has(key)) {
      const species = policyDecision('species', record?.request ?? null, currentDomain, 'already_consumed', 'already_consumed');
      const master = policyDecision('master', record?.request ?? null, currentDomain, 'already_consumed', 'already_consumed');
      return deepFreeze({
        requestId: record?.request.requestId ?? `policy:${key}`,
        scheduleSeq: record?.request.scheduleSeq ?? 0,
        worldGeneration: boundary.worldGeneration,
        scheduledWorldRevision: record?.request.scheduledWorldRevision ?? boundary.currentWorldRevision ?? 0,
        reviewedDay: record?.request.reviewedDay ?? Math.max(0, Number(boundary.day) - 1),
        applyBoundary: { kind: boundary.kind, day: boundary.day },
        species,
        master,
      });
    }
    consumedBoundaries.set(key, record?.request.requestId ?? null);
    if (record) record.consumed = true;
    const validRecord = record
      && boundary.worldGeneration === record.request.worldGeneration
      && boundary.kind === record.request.applyBoundary.kind
      && boundary.day === record.request.applyBoundary.day
      && safeInteger(boundary.currentWorldRevision)
      && record.request.scheduledWorldRevision <= boundary.currentWorldRevision;
    const selected = validRecord ? record : null;
    const species = decideChannel('species', selected, currentDomain);
    const master = decideChannel('master', selected, currentDomain);
    const identity = selected?.request;
    const outcome = deepFreeze({
      requestId: identity?.requestId ?? `policy:${key}`,
      scheduleSeq: identity?.scheduleSeq ?? 0,
      worldGeneration: boundary.worldGeneration,
      scheduledWorldRevision: identity?.scheduledWorldRevision ?? boundary.currentWorldRevision ?? 0,
      reviewedDay: identity?.reviewedDay ?? Math.max(0, Number(boundary.day) - 1),
      applyBoundary: { kind: boundary.kind, day: boundary.day },
      species,
      master,
    });
    mark('species', species.status, { source: species.source, reason: species.reason, requestId: outcome.requestId });
    mark('master', master.status, { source: master.source, reason: master.reason, requestId: outcome.requestId });
    publicState.lastDecision = outcome;
    if (record) {
      const identity = {
        requestId: record.request.requestId,
        scheduleSeq: record.request.scheduleSeq,
        worldId: record.request.worldId,
        worldGeneration: record.request.worldGeneration,
        scheduledWorldRevision: record.request.scheduledWorldRevision,
        reviewedDay: record.request.reviewedDay,
        applyBoundary: record.request.applyBoundary,
      };
      record.request = deepFreeze(identity);
      record.results = { species: null, master: null };
    }
    while (consumedBoundaries.size > MAX_TOMBSTONES) {
      const [oldestKey, requestId] = consumedBoundaries.entries().next().value;
      consumedBoundaries.delete(oldestKey);
      const oldest = latestByBoundary.get(oldestKey);
      latestByBoundary.delete(oldestKey);
      if (requestId && byRequestId.get(requestId) === oldest) byRequestId.delete(requestId);
    }
    return outcome;
  }

  function resetGeneration(worldGeneration) {
    if (typeof worldGeneration !== 'string' || !worldGeneration) return false;
    if (activeGeneration === worldGeneration) return false;
    activeGeneration = worldGeneration;
    latestByBoundary.clear();
    byRequestId.clear();
    consumedBoundaries.clear();
    publicState.lastDecision = null;
    return true;
  }

  function getPublicState() {
    return deepFreeze(safeClone({
      ...publicState,
      species: { ...publicState.species, circuitState: speciesRunner.getStatus?.().circuitState ?? 'closed' },
      master: { ...publicState.master, circuitState: masterRunner.getStatus?.().circuitState ?? 'closed' },
    }));
  }

  function close() {
    if (closed) return false;
    closed = true;
    return [speciesRunner.close?.(), masterRunner.close?.()].filter(Boolean);
  }

  return Object.freeze({
    scheduleReview, acceptEnvelope, takeForBoundary, resetGeneration, getPublicState, close,
  });
}
