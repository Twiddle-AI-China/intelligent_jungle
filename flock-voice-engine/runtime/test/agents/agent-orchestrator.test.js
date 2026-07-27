import assert from 'node:assert/strict';
import test from 'node:test';

import { providerOk } from '../../src/agents/contracts.js';
import { createAgentOrchestrator } from '../../src/agents/agent-orchestrator.js';

function review(overrides = {}) {
  return {
    requestId: 'r1', scheduleSeq: 1, worldId: 'default',
    worldGeneration: 'generation-a', scheduledWorldRevision: 10,
    reviewedDay: 4, applyBoundary: { kind: 'dawn', day: 5 },
    flockInput: { flocks: [] }, masterInput: { state: {} }, createdAtMs: 100,
    ...overrides,
  };
}

function providerResult(channel, value) {
  return Object.freeze({
    requestId: 'r1', channel, status: 'ok', value, attempts: 1,
    startedAtMs: 100, settledAtMs: 110, reason: null,
  });
}

function envelope(request, channel, provider = providerResult(channel, { channel })) {
  return {
    requestId: request.requestId,
    scheduleSeq: request.scheduleSeq,
    worldId: request.worldId,
    worldGeneration: request.worldGeneration,
    scheduledWorldRevision: request.scheduledWorldRevision,
    reviewedDay: request.reviewedDay,
    applyBoundary: request.applyBoundary,
    channel,
    provider: { ...provider, requestId: request.requestId, channel },
  };
}

function createHarness() {
  const orchestrator = createAgentOrchestrator({
    speciesRunner: { tryStart: () => ({ accepted: false, reason: 'disabled' }), getStatus: () => ({ circuitState: 'closed' }), close() {} },
    masterRunner: { tryStart: () => ({ accepted: false, reason: 'disabled' }), getStatus: () => ({ circuitState: 'closed' }), close() {} },
    admission: () => ({ admitted: false, reason: 'telemetry_unknown', sampledAtMs: null }),
    policies: {
      species: (_request, domain) => domain.speciesFallback,
      master: (_request, domain) => domain.masterFallback,
      validateSpecies: (value, domain) => domain.allowSpecies ? value : null,
      validateMaster: (value, domain) => domain.allowMaster ? value : null,
    },
    publishEnvelope() {},
    clock: { now: () => 1_000 },
  });
  return orchestrator;
}

const boundary = (overrides = {}) => ({
  worldGeneration: 'generation-a', currentWorldRevision: 15,
  kind: 'dawn', day: 5,
  currentDomain: {
    allowSpecies: true, allowMaster: true,
    speciesFallback: { fallback: 'species' }, masterFallback: { fallback: 'master' },
  },
  ...overrides,
});

test('same-boundary latest schedule wins independently of completion order', () => {
  const orchestrator = createHarness();
  const older = review({ requestId: 'older', scheduleSeq: 10, scheduledWorldRevision: 100 });
  const newer = review({ requestId: 'newer', scheduleSeq: 11, scheduledWorldRevision: 101 });
  orchestrator.scheduleReview(older);
  orchestrator.scheduleReview(newer);
  orchestrator.acceptEnvelope(envelope(newer, 'species', providerResult('species', { selected: 'new' })), {
    worldGeneration: 'generation-a', currentWorldRevision: 105, currentDay: 4,
  });
  orchestrator.acceptEnvelope(envelope(older, 'species', providerResult('species', { selected: 'old' })), {
    worldGeneration: 'generation-a', currentWorldRevision: 106, currentDay: 4,
  });
  const outcome = orchestrator.takeForBoundary(boundary({ currentWorldRevision: 110 }));
  assert.equal(outcome.requestId, 'newer');
  assert.deepEqual(outcome.species.value, { selected: 'new' });
  assert.equal(outcome.species.source, 'llm');
});

test('current revision may advance but future schedule revision is stale', () => {
  const orchestrator = createHarness();
  const request = review();
  orchestrator.scheduleReview(request);
  assert.equal(orchestrator.acceptEnvelope(envelope(request, 'species'), {
    worldGeneration: 'generation-a', currentWorldRevision: 11, currentDay: 4,
  }), true);
  assert.equal(orchestrator.takeForBoundary(boundary()).species.source, 'llm');

  const future = review({ requestId: 'future', scheduleSeq: 2, reviewedDay: 5, applyBoundary: { kind: 'dawn', day: 6 }, scheduledWorldRevision: 30 });
  orchestrator.scheduleReview(future);
  assert.equal(orchestrator.acceptEnvelope(envelope(future, 'species'), {
    worldGeneration: 'generation-a', currentWorldRevision: 29, currentDay: 5,
  }), false);
  assert.equal(orchestrator.getPublicState().lastSpeciesStatus, 'stale_discarded');
});

test('old generation, mismatched identity, and consumed-boundary results are discarded', () => {
  const orchestrator = createHarness();
  const request = review();
  orchestrator.scheduleReview(request);
  assert.equal(orchestrator.acceptEnvelope(envelope(request, 'species'), {
    worldGeneration: 'generation-b', currentWorldRevision: 10, currentDay: 4,
  }), false);
  assert.equal(orchestrator.acceptEnvelope({
    ...envelope(request, 'species'), scheduleSeq: 2,
  }, { worldGeneration: 'generation-a', currentWorldRevision: 10, currentDay: 4 }), false);
  orchestrator.takeForBoundary(boundary());
  assert.equal(orchestrator.acceptEnvelope(envelope(request, 'master'), {
    worldGeneration: 'generation-a', currentWorldRevision: 16, currentDay: 5,
  }), false);
  assert.equal(orchestrator.getPublicState().lastMasterStatus, 'stale_discarded');
});

test('boundary is consumed once and missing or invalid channel values use current policy', () => {
  const orchestrator = createHarness();
  const request = review();
  orchestrator.scheduleReview(request);
  orchestrator.acceptEnvelope(envelope(request, 'species'), {
    worldGeneration: 'generation-a', currentWorldRevision: 12, currentDay: 4,
  });
  const denied = orchestrator.takeForBoundary(boundary({
    currentDomain: {
      allowSpecies: false, allowMaster: false,
      speciesFallback: { safe: 'species' }, masterFallback: { safe: 'master' },
    },
  }));
  assert.equal(denied.species.source, 'policy');
  assert.equal(denied.species.status, 'invalid_output');
  assert.deepEqual(denied.species.value, { safe: 'species' });
  const repeated = orchestrator.takeForBoundary(boundary());
  assert.equal(repeated.species.status, 'already_consumed');
  assert.equal(repeated.master.status, 'already_consumed');
});

test('late provider completion never moves to the next dawn', () => {
  const published = [];
  let settleSpecies;
  const speciesRunner = {
    tryStart(job) { settleSpecies = job.onSettled; return { accepted: true, reason: null }; },
    getStatus: () => ({ circuitState: 'closed' }), close() {},
  };
  const orchestrator = createAgentOrchestrator({
    speciesRunner,
    masterRunner: { tryStart: () => ({ accepted: false, reason: 'disabled' }), getStatus: () => ({ circuitState: 'closed' }), close() {} },
    admission: () => ({ admitted: true, reason: 'admitted' }),
    policies: {
      species: () => ({ fallback: true }), master: () => ({ fallback: true }),
      validateSpecies: (value) => value, validateMaster: (value) => value,
    },
    publishEnvelope: (value) => published.push(value), clock: { now: () => 1_000 },
  });
  const request = review();
  orchestrator.scheduleReview(request);
  assert.equal(orchestrator.takeForBoundary(boundary()).species.source, 'policy');
  settleSpecies(providerResult('species', { late: true }));
  assert.equal(published.length, 1);
  assert.equal(orchestrator.acceptEnvelope(published[0], {
    worldGeneration: 'generation-a', currentWorldRevision: 20, currentDay: 5,
  }), false);
  const next = orchestrator.takeForBoundary(boundary({ day: 6 }));
  assert.equal(next.species.source, 'policy');
  assert.notDeepEqual(next.species.value, { late: true });
});

test('malformed envelope is rejected without identity repair', () => {
  const orchestrator = createHarness();
  const request = review();
  orchestrator.scheduleReview(request);
  const malformed = envelope(request, 'species');
  delete malformed.worldGeneration;
  assert.equal(orchestrator.acceptEnvelope(malformed, {
    worldGeneration: 'generation-a', currentWorldRevision: 10, currentDay: 4,
  }), false);
});

test('world generation reset clears prior public decision and rejects old envelopes', () => {
  const orchestrator = createHarness();
  const request = review();
  orchestrator.scheduleReview(request);
  orchestrator.takeForBoundary(boundary());
  assert.notEqual(orchestrator.getPublicState().lastDecision, null);
  assert.equal(orchestrator.resetGeneration('generation-b'), true);
  assert.equal(orchestrator.getPublicState().lastDecision, null);
  assert.equal(orchestrator.acceptEnvelope(envelope(request, 'species'), {
    worldGeneration: 'generation-a', currentWorldRevision: 20, currentDay: 4,
  }), false);
});
