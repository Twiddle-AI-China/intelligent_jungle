import assert from 'node:assert/strict';
import test from 'node:test';

import { WorldSession } from '../src/world-session/world-session.js';

function createEgress() {
  return {
    frames: [],
    closes: [],
    enqueue(frame) {
      this.frames.push(structuredClone(frame));
      return true;
    },
    close(code, reason) {
      this.closes.push({ code, reason });
    },
  };
}

function createKernel({
  restoredSnapshot = null,
  disconnectChanged = false,
} = {}) {
  let value = restoredSnapshot?.value ?? 0;
  const kernel = {
    applyCalls: [],
    disconnectCalls: [],
    disposed: false,
    getSnapshot() {
      return { value };
    },
    applyCommand(command, context) {
      this.applyCalls.push({
        command: structuredClone(command),
        context: structuredClone(context),
      });
      value += 1;
      return {
        changed: true,
        snapshot: { value },
        domainEvents: [],
        audioCommands: [],
        commandResult: { accepted: true, code: 'OK', value },
      };
    },
    disconnect(identity) {
      this.disconnectCalls.push(structuredClone(identity));
      if (!disconnectChanged) return { changed: false };
      value += 1;
      return {
        changed: true,
        snapshot: { value },
        domainEvents: [{
          name: 'control.lease',
          payload: { held: false },
        }],
        audioCommands: [],
      };
    },
    mergeSafeTick() {
      value += 1;
      return {
        changed: true,
        snapshot: { value },
        domainEvents: [],
        audioCommands: [],
      };
    },
    dispose() {
      this.disposed = true;
    },
  };
  return kernel;
}

function generationFactory(...values) {
  let index = 0;
  return () => values[index++] ?? `generation-extra-${index}`;
}

function createSession({
  restoredSnapshot = null,
  disconnectChanged = false,
  generations = ['generation-a'],
} = {}) {
  let kernel;
  const session = new WorldSession({
    seed: 7,
    createKernel: ({ restoredSnapshot: acceptedSnapshot }) => {
      kernel = createKernel({
        restoredSnapshot: acceptedSnapshot,
        disconnectChanged,
      });
      return kernel;
    },
    validateRestoredSnapshot: () => true,
    restoredSnapshot,
    worldGenerationFactory: generationFactory(...generations),
    clock: { now: () => 1_000 },
    releaseRevision: 'release-test',
    capabilities: {
      commands: ['sequence.toggle', 'snapshot.request'],
    },
  });
  return { kernel, session };
}

async function attach(session, clientId, generation) {
  const bootstrap = await session.readBootstrap({ clientId });
  const egress = createEgress();
  await session.attach({
    clientId,
    token: bootstrap.bootstrapToken,
    worldGeneration: bootstrap.worldGeneration,
    lastRevision: bootstrap.revision,
    lastEventSeq: bootstrap.eventSeq,
    egress,
    generation,
  });
  return { bootstrap, egress };
}

function causalCommand(session, commandId, {
  baseRevision = session.revision,
  worldGeneration = session.worldGeneration,
} = {}) {
  return {
    type: 'command',
    protocolVersion: 1,
    commandId,
    worldGeneration,
    baseRevision,
    name: 'sequence.toggle',
    payload: {
      treeId: 'bass',
      pitchBranchId: 0,
      stepIndex: 0,
    },
  };
}

async function execute(session, clientId, generation, commandId, overrides = {}) {
  return session.executeCommand({
    clientId,
    generation,
    command: causalCommand(session, commandId, overrides),
  });
}

test('restore establishes the causal barrier while merge-safe fixed ticks do not advance it',
  async () => {
    const restoredRevision = 41;
    const restoredSnapshot = {
      worldId: 'default',
      worldGeneration: 'generation-restored',
      seed: 7,
      revision: restoredRevision,
      eventSeq: restoredRevision,
      protocolVersion: 1,
      snapshotSchemaVersion: 1,
      value: restoredRevision,
    };
    const { kernel, session } = createSession({ restoredSnapshot });
    await attach(session, 'client-a', 1);

    const beforeBarrier = await execute(
      session,
      'client-a',
      1,
      'before-restored-barrier',
      { baseRevision: restoredRevision - 1 },
    );
    assert.deepEqual({
      accepted: beforeBarrier.accepted,
      code: beforeBarrier.code,
      currentRevision: beforeBarrier.currentRevision,
      requiredRevision: beforeBarrier.requiredRevision,
    }, {
      accepted: false,
      code: 'REVISION_MISMATCH',
      currentRevision: restoredRevision,
      requiredRevision: restoredRevision,
    });

    // This tick seam is intentionally limited to evolution that cannot cause a
    // lost update for sequence/control.take. If fixed.tick starts mutating such
    // causal state, that mutation must advance the command barrier instead.
    await session.commit('fixed.tick', (owner) => owner.kernel.mergeSafeTick());
    assert.equal(session.revision, restoredRevision + 1);

    const afterTick = await execute(
      session,
      'client-a',
      1,
      'after-merge-safe-tick',
      { baseRevision: restoredRevision },
    );
    assert.equal(afterTick.accepted, true);
    assert.equal(kernel.applyCalls.length, 1);
  });

test('reset rotates generation and starts a new causal barrier at revision zero', async () => {
  const { session } = createSession({
    generations: ['generation-before-reset', 'generation-after-reset'],
  });
  await attach(session, 'client-old', 1);
  const oldGeneration = session.worldGeneration;
  assert.equal((await execute(session, 'client-old', 1, 'before-reset')).accepted, true);
  assert.equal(session.revision, 1);

  const replacementKernel = createKernel();
  const reset = await session.resetWorld({
    kernel: replacementKernel,
    reason: 'command-barrier-test',
  });
  assert.deepEqual({
    worldGeneration: reset.worldGeneration,
    revision: reset.revision,
    eventSeq: reset.eventSeq,
  }, {
    worldGeneration: 'generation-after-reset',
    revision: 0,
    eventSeq: 0,
  });

  const oldWorld = await execute(
    session,
    'client-old',
    1,
    'old-generation-after-reset',
    { baseRevision: 0, worldGeneration: oldGeneration },
  );
  assert.equal(oldWorld.code, 'WORLD_GENERATION_MISMATCH');

  const { bootstrap } = await attach(session, 'client-new', 2);
  assert.deepEqual({
    worldGeneration: bootstrap.worldGeneration,
    revision: bootstrap.revision,
    eventSeq: bootstrap.eventSeq,
  }, {
    worldGeneration: 'generation-after-reset',
    revision: 0,
    eventSeq: 0,
  });
  await session.commit('fixed.tick', (owner) => owner.kernel.mergeSafeTick());
  assert.equal(session.revision, 1);
  const newWorld = await execute(
    session,
    'client-new',
    2,
    'new-generation-after-reset',
    { baseRevision: 0 },
  );
  assert.equal(newWorld.accepted, true);
  assert.equal(replacementKernel.applyCalls.length, 1);
});

test('stale and unchanged detach do not advance the causal barrier', async () => {
  const { kernel, session } = createSession({ disconnectChanged: false });
  await attach(session, 'client-a', 1);
  await attach(session, 'client-b', 1);

  assert.equal(await session.detach({ clientId: 'client-a', generation: 2 }), false);
  assert.equal(kernel.disconnectCalls.length, 0);
  assert.equal(await session.detach({ clientId: 'client-a', generation: 1 }), true);
  assert.equal(kernel.disconnectCalls.length, 1);
  assert.deepEqual([session.revision, session.eventSeq], [0, 0]);

  await session.commit('fixed.tick', (owner) => owner.kernel.mergeSafeTick());
  assert.equal(session.revision, 1);
  const unchanged = await execute(session, 'client-b', 1, 'after-unchanged-detach', {
    baseRevision: 0,
  });
  assert.equal(unchanged.accepted, true);
});

test('an active detach with changed causal state advances the barrier', async () => {
  const { kernel, session } = createSession({ disconnectChanged: true });
  await attach(session, 'client-a', 1);
  await attach(session, 'client-b', 1);

  assert.equal(await session.detach({ clientId: 'client-a', generation: 1 }), true);
  assert.equal(kernel.disconnectCalls.length, 1);
  assert.deepEqual([session.revision, session.eventSeq], [1, 1]);

  await session.commit('fixed.tick', (owner) => owner.kernel.mergeSafeTick());
  assert.deepEqual([session.revision, session.eventSeq], [2, 2]);
  const stale = await execute(session, 'client-b', 1, 'after-changed-detach-stale', {
    baseRevision: 0,
  });
  assert.deepEqual({
    accepted: stale.accepted,
    code: stale.code,
    currentRevision: stale.currentRevision,
    requiredRevision: stale.requiredRevision,
  }, {
    accepted: false,
    code: 'REVISION_MISMATCH',
    currentRevision: 2,
    requiredRevision: 1,
  });
  assert.equal(kernel.applyCalls.length, 0);

  const current = await execute(session, 'client-b', 1, 'after-changed-detach-current', {
    baseRevision: 1,
  });
  assert.equal(current.accepted, true);
  assert.equal(kernel.applyCalls.length, 1);
});
