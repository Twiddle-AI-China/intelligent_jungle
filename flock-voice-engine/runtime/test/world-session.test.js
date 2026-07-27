import assert from 'node:assert/strict';
import test from 'node:test';

import { WorldSession } from '../src/world-session/world-session.js';

const clock = Object.freeze({
  now: () => 1_234,
});

const restoredSnapshot = Object.freeze({
  worldId: 'default',
  worldGeneration: 'generation-restored',
  seed: 7,
  protocolVersion: 1,
  snapshotSchemaVersion: 1,
  revision: 41,
  eventSeq: 87,
  day: 3,
  phase: 0.25,
  trees: Object.freeze([]),
});

function validateRestoredSnapshot(snapshot) {
  return snapshot.snapshotSchemaVersion === 1
    && Number.isInteger(snapshot.day)
    && Number.isFinite(snapshot.phase)
    && Array.isArray(snapshot.trees);
}

function createKernelFactory(calls) {
  return ({ seed, restoredSnapshot: acceptedSnapshot }) => {
    calls.push({ seed, restoredSnapshot: acceptedSnapshot });
    return {
      restoredFrom: acceptedSnapshot,
      dispose() {},
    };
  };
}

test('restores a compatible snapshot and preserves its generation and cursors', () => {
  const firstCalls = [];
  const secondCalls = [];
  const restoredA = new WorldSession({
    seed: 7,
    createKernel: createKernelFactory(firstCalls),
    validateRestoredSnapshot,
    clock,
    restoredSnapshot,
    worldGenerationFactory: () => 'generation-after-reset',
  });
  const restoredB = new WorldSession({
    seed: 7,
    createKernel: createKernelFactory(secondCalls),
    validateRestoredSnapshot,
    clock,
    restoredSnapshot,
    worldGenerationFactory: () => {
      throw new Error('compatible restore must not generate a new identity');
    },
  });

  for (const restored of [restoredA, restoredB]) {
    assert.equal(restored.worldGeneration, 'generation-restored');
    assert.equal(restored.revision, 41);
    assert.equal(restored.eventSeq, 87);
    assert.equal(restored.restoreDisposition, 'restored');
    assert.deepEqual(restored.kernel.restoredFrom, restoredSnapshot);
    assert.notEqual(restored.kernel.restoredFrom, restoredSnapshot);
    assert.equal(restored.clock, clock);
  }
  assert.deepEqual(firstCalls, [{
    seed: 7,
    restoredSnapshot: structuredClone(restoredSnapshot),
  }]);
  assert.deepEqual(secondCalls, [{
    seed: 7,
    restoredSnapshot: structuredClone(restoredSnapshot),
  }]);
});

test('rebuilds cleanly when envelope, schema, generation, or cursors are incompatible', () => {
  const incompatibleCases = [
    ['world id', { ...restoredSnapshot, worldId: 'other' }],
    ['seed', { ...restoredSnapshot, seed: 8 }],
    ['protocol', { ...restoredSnapshot, protocolVersion: 2 }],
    ['schema version', { ...restoredSnapshot, snapshotSchemaVersion: 2 }],
    ['domain schema', { ...restoredSnapshot, trees: undefined }],
    ['generation missing', { ...restoredSnapshot, worldGeneration: undefined }],
    ['generation empty', { ...restoredSnapshot, worldGeneration: '' }],
    ['revision missing', { ...restoredSnapshot, revision: undefined }],
    ['revision negative', { ...restoredSnapshot, revision: -1 }],
    ['revision non-integer', { ...restoredSnapshot, revision: 1.5 }],
    ['revision unsafe', {
      ...restoredSnapshot,
      revision: Number.MAX_SAFE_INTEGER + 1,
    }],
    ['event sequence missing', { ...restoredSnapshot, eventSeq: undefined }],
    ['event sequence negative', { ...restoredSnapshot, eventSeq: -1 }],
    ['event sequence non-integer', { ...restoredSnapshot, eventSeq: 1.5 }],
    ['event sequence unsafe', {
      ...restoredSnapshot,
      eventSeq: Number.MAX_SAFE_INTEGER + 1,
    }],
  ];

  for (const [name, candidate] of incompatibleCases) {
    const calls = [];
    const generation = `generation-after-${name.replaceAll(' ', '-')}`;
    const session = new WorldSession({
      seed: 7,
      createKernel: createKernelFactory(calls),
      validateRestoredSnapshot,
      clock,
      restoredSnapshot: candidate,
      worldGenerationFactory: () => generation,
    });

    assert.deepEqual(
      [session.worldGeneration, session.revision, session.eventSeq],
      [generation, 0, 0],
      name,
    );
    assert.equal(session.restoreDisposition, 'rebuilt-incompatible', name);
    assert.equal(session.kernel.restoredFrom, null, name);
    assert.deepEqual(calls, [{ seed: 7, restoredSnapshot: null }], name);
  }
});

test('treats a throwing domain validator as an incompatible snapshot', () => {
  const calls = [];
  const session = new WorldSession({
    seed: 7,
    createKernel: createKernelFactory(calls),
    validateRestoredSnapshot() {
      throw new Error('invalid checkpoint shape');
    },
    clock,
    restoredSnapshot,
    worldGenerationFactory: () => 'generation-after-validator-error',
  });

  assert.equal(session.worldGeneration, 'generation-after-validator-error');
  assert.equal(session.restoreDisposition, 'rebuilt-incompatible');
  assert.deepEqual(calls, [{ seed: 7, restoredSnapshot: null }]);
});

test('validator 接受后 clone/accessor 失败仍整世重建且不重读 caller', () => {
  let getterCalls = 0;
  const accessor = { ...restoredSnapshot };
  Object.defineProperty(accessor, 'worldGeneration', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('poisoned accessor');
    },
  });
  const calls = [];
  const session = new WorldSession({
    seed: 7,
    createKernel: createKernelFactory(calls),
    validateRestoredSnapshot: () => true,
    clock,
    restoredSnapshot: accessor,
    worldGenerationFactory: () => 'generation-after-clone-failure',
  });

  assert.equal(getterCalls, 1);
  assert.equal(session.restoreDisposition, 'rebuilt-incompatible');
  assert.equal(session.worldGeneration, 'generation-after-clone-failure');
  assert.deepEqual(calls, [{ seed: 7, restoredSnapshot: null }]);
});

test('validator 接受但 structuredClone 拒绝的值不得进入 kernel', () => {
  const calls = [];
  const session = new WorldSession({
    seed: 7,
    createKernel: createKernelFactory(calls),
    validateRestoredSnapshot: () => true,
    clock,
    restoredSnapshot: { ...restoredSnapshot, poison: () => {} },
    worldGenerationFactory: () => 'generation-after-uncloneable',
  });
  assert.equal(session.restoreDisposition, 'rebuilt-incompatible');
  assert.deepEqual(calls, [{ seed: 7, restoredSnapshot: null }]);
});

test('creates a fresh kernel with a generated identity and zero cursors', () => {
  const calls = [];
  const session = new WorldSession({
    seed: 7,
    createKernel: createKernelFactory(calls),
    validateRestoredSnapshot,
    clock,
    worldGenerationFactory: () => 'generation-fresh',
  });

  assert.equal(session.worldGeneration, 'generation-fresh');
  assert.equal(session.revision, 0);
  assert.equal(session.eventSeq, 0);
  assert.equal(session.restoreDisposition, 'fresh');
  assert.deepEqual(calls, [{ seed: 7, restoredSnapshot: null }]);
});

test('projects allowlisted agent provenance into every public snapshot', async () => {
  const session = new WorldSession({
    seed: 7,
    createKernel: () => ({
      getSnapshot: () => ({ day: 1, phase: 0, trees: [] }),
      dispose() {},
    }),
    validateRestoredSnapshot,
    clock,
    worldGenerationFactory: () => 'generation-agents',
    getAgentState: () => ({
      species: {
        enabled: true,
        status: 'ok',
        source: 'llm',
        requestId: 'species:1',
        latencyMs: 12,
        circuitState: 'closed',
        rawResponse: 'private-model-output',
      },
      master: { enabled: false, status: 'disabled', source: 'policy' },
      lastDecision: {
        requestId: 'decision:1', scheduleSeq: 1, reviewedDay: 1,
        applyBoundary: { kind: 'dawn', day: 2 },
        species: { source: 'policy', status: 'provider_error', reason: 'SK_ABC123_SUPER_SECRET_TOKEN' },
        master: { source: 'policy', status: 'disabled', reason: 'disabled' },
      },
      apiKey: 'server-only',
    }),
  });

  const bootstrap = await session.readBootstrap({ clientId: 'client-agent-status' });
  assert.equal(bootstrap.snapshot.agentStatus.species.source, 'llm');
  assert.equal(bootstrap.snapshot.agentStatus.species.latencyMs, 12);
  assert.equal(Object.isFrozen(bootstrap.snapshot.agentStatus), true);
  assert.equal(JSON.stringify(bootstrap).includes('private-model-output'), false);
  assert.equal(JSON.stringify(bootstrap).includes('server-only'), false);
  assert.equal(JSON.stringify(bootstrap).includes('SK_ABC123'), false);
});

test('serializes world work and resets identity and cursors at runtime', async () => {
  const lifecycle = [];
  const oldKernel = {
    dispose() {
      lifecycle.push('disposed');
    },
  };
  const replacementKernel = { name: 'replacement' };
  const session = new WorldSession({
    seed: 7,
    createKernel: () => oldKernel,
    validateRestoredSnapshot,
    clock,
    restoredSnapshot,
    worldGenerationFactory: () => 'generation-after-reset',
  });

  const observedSession = await session.runExclusive('inspect', (activeSession) => (
    activeSession
  ));
  assert.equal(observedSession, session);

  const result = await session.resetWorld({
    kernel: replacementKernel,
    reason: 'explicit-test-reset',
  });

  assert.deepEqual(lifecycle, ['disposed']);
  assert.equal(session.kernel, replacementKernel);
  assert.equal(session.worldGeneration, 'generation-after-reset');
  assert.equal(session.revision, 0);
  assert.equal(session.eventSeq, 0);
  assert.deepEqual(result, {
    reason: 'explicit-test-reset',
    worldGeneration: 'generation-after-reset',
    revision: 0,
    eventSeq: 0,
  });
  assert.equal(Object.isFrozen(result), true);
});

test('detach releases only the exact socket generation inside the session mailbox', async () => {
  const disconnects = [];
  const kernel = {
    getSnapshot: () => ({ day: 1, phase: 0, trees: [] }),
    disconnect(identity) {
      disconnects.push(identity);
      return {
        changed: false,
        snapshot: this.getSnapshot(),
        domainEvents: [],
        audioCommands: [],
      };
    },
    dispose() {},
  };
  const session = new WorldSession({
    seed: 7,
    createKernel: () => kernel,
    validateRestoredSnapshot,
    clock,
    worldGenerationFactory: () => 'generation-detach',
  });
  session.subscriptions.set('c1', {
    clientId: 'c1', generation: 'socket-2', egress: { enqueue: () => true }, state: 'live',
  });

  assert.equal(await session.detach({ clientId: 'c1', generation: 'socket-1' }), false);
  assert.deepEqual(disconnects, []);
  assert.equal(await session.detach({ clientId: 'c1', generation: 'socket-2' }), true);
  assert.deepEqual(disconnects, [{ clientId: 'c1', connectionGeneration: 'socket-2' }]);
});

test('preserves a restored nonzero tuple when reset generation preparation fails', async () => {
  let generationCalls = 0;
  let disposeCalls = 0;
  const oldKernel = {
    dispose() {
      disposeCalls += 1;
    },
  };
  const replacementKernel = { name: 'replacement' };
  const session = new WorldSession({
    seed: 7,
    createKernel: () => oldKernel,
    validateRestoredSnapshot,
    clock,
    restoredSnapshot,
    worldGenerationFactory() {
      generationCalls += 1;
      throw new Error('generation unavailable');
    },
  });
  const tupleBeforeReset = [
    session.worldGeneration,
    session.revision,
    session.eventSeq,
  ];
  assert.deepEqual(tupleBeforeReset, ['generation-restored', 41, 87]);

  await assert.rejects(
    session.resetWorld({
      kernel: replacementKernel,
      reason: 'generation-failure-test',
    }),
    /generation unavailable/,
  );
  const mailboxResult = await session.runExclusive(
    'after-failed-reset',
    (activeSession) => activeSession.kernel,
  );

  assert.equal(generationCalls, 1);
  assert.equal(mailboxResult, oldKernel);
  assert.equal(disposeCalls, 0);
  assert.equal(session.kernel, oldKernel);
  assert.notEqual(session.kernel, replacementKernel);
  assert.deepEqual(
    [session.worldGeneration, session.revision, session.eventSeq],
    tupleBeforeReset,
  );
});

test('rejects unsupported worlds and missing kernel boundaries', () => {
  const common = {
    seed: 7,
    createKernel: createKernelFactory([]),
    validateRestoredSnapshot,
    clock,
  };

  assert.throws(
    () => new WorldSession({ ...common, worldId: 'other' }),
    /WORLD_NOT_SUPPORTED/,
  );
  assert.throws(
    () => new WorldSession({ ...common, createKernel: undefined }),
    /WORLD_KERNEL_FACTORY_REQUIRED/,
  );
  assert.throws(
    () => new WorldSession({
      ...common,
      validateRestoredSnapshot: undefined,
    }),
    /WORLD_KERNEL_FACTORY_REQUIRED/,
  );
  assert.throws(
    () => new WorldSession({ ...common, getAgentState: {} }),
    /AGENT_STATE_PROVIDER_INVALID/,
  );
});
