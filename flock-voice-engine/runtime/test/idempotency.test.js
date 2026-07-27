import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeWsGateway } from '../src/api/runtime-ws.js';
import { createTokenStore } from '../src/protocol/token-store.js';
import { WorldSession } from '../src/world-session/world-session.js';

function tokenStore() {
  let fill = 0;
  return createTokenStore({
    clock: { now: () => 1_000 },
    ttlMs: 5_000,
    randomBytes(size) {
      fill += 1;
      return Buffer.alloc(size, fill);
    },
  });
}

function kernel() {
  let value = 0;
  return {
    commandCalls: [],
    getSnapshot: () => ({ value }),
    applyCommand(command, context) {
      this.commandCalls.push(structuredClone(command));
      this.lastCommandContext = context;
      value += 1;
      return {
        changed: true,
        snapshot: { value },
        domainEvents: [],
        audioCommands: [],
        commandResult: { accepted: true, code: 'OK', value },
      };
    },
    dispose() {},
  };
}

function egress() {
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

function createFixture() {
  const fakeKernel = kernel();
  const session = new WorldSession({
    seed: 7,
    createKernel: () => fakeKernel,
    validateRestoredSnapshot: () => true,
    clock: { now: () => 1_000 },
    worldGenerationFactory: () => 'generation-a',
    releaseRevision: 'release-a',
    capabilities: { commands: ['runtime.pause', 'snapshot.request'] },
    tokenStore: tokenStore(),
  });
  const gateway = createRuntimeWsGateway({
    getSession: () => session,
    allowedOrigin: 'http://127.0.0.1:4193',
  });
  return { fakeKernel, gateway, session };
}

async function attach(session, clientId, generation, resume = null) {
  const target = egress();
  let token;
  let lastRevision;
  let lastEventSeq;
  if (resume) {
    token = resume.resumeToken;
    lastRevision = resume.revision;
    lastEventSeq = resume.eventSeq;
  } else {
    const bootstrap = await session.readBootstrap({ clientId });
    token = bootstrap.bootstrapToken;
    lastRevision = bootstrap.revision;
    lastEventSeq = bootstrap.eventSeq;
  }
  await session.attach({
    clientId,
    token,
    worldGeneration: session.worldGeneration,
    lastRevision,
    lastEventSeq,
    egress: target,
    generation,
  });
  return target;
}

function command(session, commandId, overrides = {}) {
  return {
    type: 'command',
    protocolVersion: 1,
    commandId,
    worldGeneration: session.worldGeneration,
    baseRevision: session.revision,
    name: 'runtime.pause',
    payload: {},
    ...overrides,
  };
}

test('deduplicates by client and command id across an active reconnect', async () => {
  const { fakeKernel, session } = createFixture();
  const first = await attach(session, 'client-a', 1);
  const firstCommand = command(session, 'command-a');
  const firstResult = await session.executeCommand({
    clientId: 'client-a',
    generation: 1,
    command: firstCommand,
  });
  const resume = first.frames.findLast(({ type }) => type === 'ready');
  const replacement = await attach(session, 'client-a', 2, resume);
  const framesBeforeDuplicate = replacement.frames.length;

  const duplicate = await session.executeCommand({
    clientId: 'client-a',
    generation: 2,
    command: firstCommand,
  });
  assert.deepEqual(duplicate, firstResult);
  assert.equal(fakeKernel.commandCalls.length, 1);
  assert.deepEqual(
    replacement.frames.slice(framesBeforeDuplicate),
    [firstResult],
  );
});

test('retries a lost command result after reconnecting at the last-applied cursor', async () => {
  const { fakeKernel, session } = createFixture();
  const first = await attach(session, 'client-a', 1);
  const earlierReady = first.frames.findLast(({ type }) => type === 'ready');
  const original = command(session, 'lost-result-command');
  const firstResult = await session.executeCommand({
    clientId: 'client-a',
    generation: 1,
    command: original,
  });
  assert.deepEqual([session.revision, session.eventSeq], [1, 1]);
  first.frames.length = 0;

  const replacement = egress();
  const reconnect = await session.attach({
    clientId: 'client-a',
    token: earlierReady.resumeToken,
    worldGeneration: earlierReady.worldGeneration,
    lastRevision: 1,
    lastEventSeq: 1,
    egress: replacement,
    generation: 2,
  });
  assert.equal(reconnect.kind, 'replay');
  assert.deepEqual(reconnect.records, []);
  assert.deepEqual(replacement.frames.map(({ type }) => type), ['ready']);

  const retried = await session.executeCommand({
    clientId: 'client-a',
    generation: 2,
    command: original,
  });
  assert.deepEqual(retried, firstResult);
  assert.equal(fakeKernel.commandCalls.length, 1);
  assert.deepEqual(replacement.frames.slice(1), [firstResult]);
});

test('rejects a replaced generation before validation, dedupe, kernel or cursors', async () => {
  const { fakeKernel, gateway, session } = createFixture();
  const first = await attach(session, 'client-a', 1);
  const resume = first.frames.findLast(({ type }) => type === 'ready');
  const replacement = await attach(session, 'client-a', 2, resume);
  assert.deepEqual(first.closes, [{ code: 4409, reason: 'CONNECTION_REPLACED' }]);

  const staleCommand = command(session, 'stale-command-a', {
    protocolVersion: 999,
    worldGeneration: 'stale-generation',
    baseRevision: -10,
  });
  const before = {
    revision: session.revision,
    eventSeq: session.eventSeq,
    kernelCalls: fakeKernel.commandCalls.length,
  };
  const stale = await gateway.routeCommand({
    session,
    clientId: 'client-a',
    generation: 1,
    command: staleCommand,
  });
  assert.deepEqual(stale, {
    type: 'command.result',
    commandId: 'stale-command-a',
    accepted: false,
    code: 'STALE_CONNECTION_GENERATION',
  });
  assert.deepEqual({
    revision: session.revision,
    eventSeq: session.eventSeq,
    kernelCalls: fakeKernel.commandCalls.length,
  }, before);

  const active = await gateway.routeCommand({
    session,
    clientId: 'client-a',
    generation: 2,
    command: command(session, 'stale-command-a'),
  });
  assert.equal(active.accepted, true);
  assert.equal(fakeKernel.commandCalls.length, before.kernelCalls + 1);
  assert.equal(replacement.closes.length, 0);
});

test('rejects every latent command from a replaced socket before validation and dedupe', async () => {
  const { fakeKernel, session } = createFixture();
  const first = await attach(session, 'client-a', 1);
  const resume = first.frames.findLast(({ type }) => type === 'ready');
  await attach(session, 'client-a', 2, resume);
  const before = {
    revision: session.revision,
    eventSeq: session.eventSeq,
    dedupe: session.idempotency.size,
  };
  const commands = [
    ['control.take', { voice: 'pad' }],
    ['control.heartbeat', { voice: 'pad', leaseToken: 'lease-1' }],
    ['control.release', { voice: 'pad', leaseToken: 'lease-1' }],
    ['latent.setCursor', {
      voice: 'pad', leaseToken: 'lease-1', eventSeq: 1,
      cursor: { x: 0, y: 0, pca: [] },
    }],
    ['latent.setMode', { voice: 'pad', leaseToken: 'lease-1', mode: 'xy' }],
    ['preview.start', { voice: 'pad', leaseToken: 'lease-1' }],
    ['preview.stop', { voice: 'pad', leaseToken: 'lease-1' }],
  ];
  for (const [index, [name, payload]] of commands.entries()) {
    const result = await session.executeCommand({
      clientId: 'client-a',
      generation: 1,
      command: command(session, `stale-latent-${index}`, { name, payload }),
    });
    assert.equal(result.code, 'STALE_CONNECTION_GENERATION', name);
  }
  assert.equal(fakeKernel.commandCalls.length, 0);
  assert.deepEqual({
    revision: session.revision,
    eventSeq: session.eventSeq,
    dedupe: session.idempotency.size,
  }, before);

  const accepted = await session.executeCommand({
    clientId: 'client-a',
    generation: 2,
    command: command(session, 'stale-latent-6', {
      name: 'preview.stop', payload: { voice: 'pad', leaseToken: 'lease-1' },
    }),
  });
  assert.equal(accepted.accepted, true);
  assert.equal(fakeKernel.commandCalls.length, 1);
  assert.equal(fakeKernel.lastCommandContext.connectionGeneration, 2);
});

test('exact-generation close cleanup cannot remove a replacement or consume its command id', async () => {
  const { fakeKernel, session } = createFixture();
  const first = await attach(session, 'client-a', 1);
  const resume = first.frames.findLast(({ type }) => type === 'ready');
  await attach(session, 'client-a', 2, resume);
  await session.detach({ clientId: 'client-a', generation: 1 });

  const staleBefore = fakeKernel.commandCalls.length;
  const stale = await session.executeCommand({
    clientId: 'client-a',
    generation: 1,
    command: command(session, 'close-race-command'),
  });
  assert.equal(stale.code, 'STALE_CONNECTION_GENERATION');
  assert.equal(fakeKernel.commandCalls.length, staleBefore);

  const active = await session.executeCommand({
    clientId: 'client-a',
    generation: 2,
    command: command(session, 'close-race-command'),
  });
  assert.equal(active.accepted, true);
  assert.equal(fakeKernel.commandCalls.length, staleBefore + 1);
});

test('rejects generation and revision mismatches without cursor mutation', async () => {
  const { fakeKernel, session } = createFixture();
  await attach(session, 'client-a', 1);
  const before = [session.revision, session.eventSeq];

  const oldWorld = await session.executeCommand({
    clientId: 'client-a',
    generation: 1,
    command: command(session, 'old-world', {
      worldGeneration: 'generation-old',
    }),
  });
  assert.equal(oldWorld.code, 'WORLD_GENERATION_MISMATCH');

  const staleRevision = await session.executeCommand({
    clientId: 'client-a',
    generation: 1,
    command: command(session, 'old-revision', { baseRevision: 99 }),
  });
  assert.equal(staleRevision.code, 'REVISION_MISMATCH');
  assert.deepEqual([session.revision, session.eventSeq], before);
  assert.equal(fakeKernel.commandCalls.length, 0);
});

test('passes an immutable authoritative command context and preserves cursors on throw', async () => {
  const { fakeKernel, session } = createFixture();
  await attach(session, 'client-a', 3);
  const baseRevision = session.revision;
  await session.executeCommand({
    clientId: 'client-a',
    generation: 3,
    command: command(session, 'context-command'),
  });
  assert.deepEqual(fakeKernel.lastCommandContext, {
    worldId: 'default',
    worldGeneration: 'generation-a',
    clientId: 'client-a',
    commandId: 'context-command',
    baseRevision,
    connectionGeneration: 3,
  });
  assert.equal(Object.isFrozen(fakeKernel.lastCommandContext), true);

  const cursors = [session.revision, session.eventSeq];
  await assert.rejects(session.commit('throwing-mutation', () => {
    throw new Error('mutation failed');
  }), /mutation failed/);
  assert.deepEqual([session.revision, session.eventSeq], cursors);
});

test('prepares every changed command artifact before mutating session windows', async (context) => {
  for (const [name, invalidFields] of [
    ['extra-field', { diagnostic: () => undefined }],
    ['audio-command', { audioCommands: [{ play: () => undefined }] }],
    ['command-result-detail', {
      commandResult: {
        accepted: true,
        code: 'OK',
        diagnostic: () => undefined,
      },
    }],
  ]) {
    await context.test(name, async () => {
      const { fakeKernel, session } = createFixture();
      const target = await attach(session, 'client-a', 1);
      target.frames.length = 0;
      fakeKernel.applyCommand = function applyCommand() {
        this.commandCalls.push(name);
        return {
          changed: true,
          snapshot: { value: 1 },
          domainEvents: [{ name: 'must-not-commit', payload: {} }],
          audioCommands: [],
          commandResult: { accepted: true, code: 'OK' },
          ...invalidFields,
        };
      };

      await assert.rejects(session.executeCommand({
        clientId: 'client-a',
        generation: 1,
        command: command(session, `non-cloneable-${name}`),
      }));

      assert.deepEqual([session.revision, session.eventSeq], [0, 0]);
      assert.deepEqual(session.journal.replayAfter(0, 0), []);
      assert.deepEqual(target.frames, []);
      assert.deepEqual(target.closes, []);
      assert.equal(session.idempotency.size, 0);
    });
  }
});

test('keeps protocol command-result fields authoritative over kernel details', async () => {
  const { fakeKernel, session } = createFixture();
  const target = await attach(session, 'client-a', 1);
  target.frames.length = 0;
  fakeKernel.applyCommand = () => ({
    changed: false,
    domainEvents: [],
    audioCommands: [],
    commandResult: {
      type: 'kernel.result',
      commandId: 'kernel-command-id',
      accepted: true,
      code: 'OK',
      value: 7,
    },
  });

  const result = await session.executeCommand({
    clientId: 'client-a',
    generation: 1,
    command: command(session, 'authoritative-result'),
  });

  assert.deepEqual(result, {
    type: 'command.result',
    commandId: 'authoritative-result',
    accepted: true,
    code: 'OK',
    value: 7,
  });
  assert.deepEqual(target.frames, [result]);
});
