import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createBootstrapHandler } from '../src/api/bootstrap.js';
import { createTokenStore } from '../src/protocol/token-store.js';
import { createCandidateServer } from '../src/server.js';
import { createJournal } from '../src/world-session/journal.js';
import { WorldSession } from '../src/world-session/world-session.js';

const ALLOWED_ORIGIN = 'http://127.0.0.1:4193';

function createDeterministicTokenStore({ now = 1_000, ttlMs = 5_000 } = {}) {
  let tokenByte = 0;
  const clock = {
    now() {
      return now;
    },
    set(value) {
      now = value;
    },
  };
  return {
    clock,
    tokenStore: createTokenStore({
      clock,
      ttlMs,
      randomBytes(size) {
        tokenByte += 1;
        return Buffer.alloc(size, tokenByte);
      },
    }),
  };
}

function createKernel(initialValue = 1) {
  let snapshot = { value: initialValue };
  return {
    commandCalls: [],
    getSnapshot() {
      return structuredClone(snapshot);
    },
    applyCommand(command, context) {
      this.commandCalls.push({ command: structuredClone(command), context });
      snapshot = { value: snapshot.value + 1 };
      return {
        changed: true,
        snapshot,
        domainEvents: [{ name: 'changed', payload: snapshot }],
        audioCommands: [],
        commandResult: { accepted: true, code: 'OK' },
      };
    },
    dispose() {},
  };
}

function createSession({
  capacity = 8,
  tokenStore,
  kernel = createKernel(),
  capabilities = { commands: ['runtime.pause', 'snapshot.request'] },
  journal = createJournal({ capacity }),
} = {}) {
  return new WorldSession({
    seed: 7,
    createKernel: () => kernel,
    validateRestoredSnapshot: () => true,
    clock: { now: () => 1_000 },
    worldGenerationFactory: () => 'generation-a',
    releaseRevision: 'release-a',
    capabilities,
    journal,
    tokenStore,
  });
}

function fakeEgress() {
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

async function issueResumeAnchor(
  session,
  clientId = 'client-a',
  generation = 1,
) {
  const bootstrap = await session.readBootstrap({ clientId });
  const target = fakeEgress();
  await session.attach({
    clientId,
    token: bootstrap.bootstrapToken,
    worldGeneration: bootstrap.worldGeneration,
    lastRevision: bootstrap.revision,
    lastEventSeq: bootstrap.eventSeq,
    egress: target,
    generation,
  });
  return {
    bootstrap,
    target,
    ready: target.frames.findLast(({ type }) => type === 'ready'),
  };
}

test('issues opaque single-use tokens bound to generation, client, cursor and expiry', () => {
  const { clock, tokenStore } = createDeterministicTokenStore();
  const claims = {
    worldId: 'default',
    worldGeneration: 'generation-a',
    clientId: 'client-a',
    revision: 3,
    eventSeq: 4,
    kind: 'bootstrap',
  };
  const issued = tokenStore.issue(claims);

  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresAt, 6_000);
  assert.equal(tokenStore.consume(`${issued.token}x`, claims), null);
  assert.equal(tokenStore.consume(issued.token, {
    ...claims,
    clientId: 'client-b',
  }), null);
  assert.equal(tokenStore.consume(issued.token, claims), null);

  const crossGeneration = tokenStore.issue(claims);
  assert.equal(tokenStore.consume(crossGeneration.token, {
    ...claims,
    worldGeneration: 'generation-b',
  }), null);
  assert.equal(tokenStore.consume(crossGeneration.token, claims), null);

  const cursorMismatch = tokenStore.issue(claims);
  assert.equal(tokenStore.consume(cursorMismatch.token, {
    ...claims,
    revision: claims.revision + 1,
  }), null);
  assert.equal(tokenStore.consume(cursorMismatch.token, claims), null);

  const oneUse = tokenStore.issue(claims);
  assert.deepEqual(tokenStore.consume(oneUse.token, claims), {
    ...claims,
    expiresAt: 6_000,
  });
  assert.equal(tokenStore.consume(oneUse.token, claims), null);

  const expired = tokenStore.issue(claims);
  clock.set(6_000);
  assert.equal(tokenStore.consume(expired.token, claims), null);
});

test('freezes bootstrap snapshot, cursor and token in one mailbox operation', async () => {
  const { tokenStore } = createDeterministicTokenStore();
  const session = createSession({ tokenStore });

  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });
  assert.deepEqual(Object.keys(bootstrap).sort(), [
    'bootstrapExpiresAt',
    'bootstrapToken',
    'capabilities',
    'clientId',
    'eventSeq',
    'protocolVersion',
    'releaseRevision',
    'revision',
    'snapshot',
    'worldGeneration',
    'worldId',
  ]);
  assert.equal(bootstrap.protocolVersion, 1);
  assert.equal(bootstrap.worldGeneration, 'generation-a');
  assert.equal(bootstrap.snapshot.worldGeneration, 'generation-a');
  assert.deepEqual(bootstrap.capabilities.commands, [
    'runtime.pause',
    'snapshot.request',
  ]);

  await session.commit('bootstrap-window', () => ({
    changed: true,
    snapshot: { value: 2 },
    domainEvents: [{ name: 'changed', payload: { value: 2 } }],
    audioCommands: [],
  }));

  const egress = fakeEgress();
  const attach = await session.attach({
    clientId: 'client-a',
    token: bootstrap.bootstrapToken,
    worldGeneration: bootstrap.worldGeneration,
    lastRevision: bootstrap.revision,
    lastEventSeq: bootstrap.eventSeq,
    egress,
    generation: 1,
  });
  assert.equal(attach.kind, 'replay');
  assert.deepEqual(attach.records.map(({ eventSeq }) => eventSeq), [1]);
  assert.deepEqual(egress.frames.map(({ type }) => type), [
    'state.patch',
    'domain.event',
    'ready',
  ]);
});

test('advertises only Phase 2 kernel commands plus gateway snapshot request', async () => {
  const { tokenStore } = createDeterministicTokenStore();
  const session = createSession({
    tokenStore,
    capabilities: {
      commands: [
        'runtime.resume',
        'mix.setParam',
        'snapshot.request',
        'runtime.resume',
      ],
    },
  });
  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });

  assert.deepEqual(bootstrap.capabilities.commands, [
    'runtime.resume',
    'snapshot.request',
  ]);
});

test('falls back to one full snapshot when the journal no longer covers bootstrap', async () => {
  const { tokenStore } = createDeterministicTokenStore();
  const session = createSession({ capacity: 1, tokenStore });
  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });

  for (const value of [2, 3]) {
    await session.commit(`value-${value}`, () => ({
      changed: true,
      snapshot: { value },
      domainEvents: [],
      audioCommands: [],
    }));
  }

  const egress = fakeEgress();
  const attach = await session.attach({
    clientId: 'client-a',
    token: bootstrap.bootstrapToken,
    worldGeneration: bootstrap.worldGeneration,
    lastRevision: bootstrap.revision,
    lastEventSeq: bootstrap.eventSeq,
    egress,
    generation: 1,
  });
  assert.equal(attach.kind, 'snapshot');
  assert.equal(attach.snapshot.revision, session.revision);
  assert.deepEqual(egress.frames.map(({ type }) => type), ['snapshot', 'ready']);
});

test('accepts a last-applied resume cursor after its token anchor and replays only the tail', async () => {
  const { tokenStore } = createDeterministicTokenStore();
  const session = createSession({ tokenStore });
  const { ready } = await issueResumeAnchor(session);

  for (const value of [2, 3]) {
    await session.commit(`resume-tail-${value}`, () => ({
      changed: true,
      snapshot: { value },
      domainEvents: [{ name: 'changed', payload: { value } }],
      audioCommands: [],
    }));
  }

  const replacement = fakeEgress();
  const attach = await session.attach({
    clientId: 'client-a',
    token: ready.resumeToken,
    worldGeneration: ready.worldGeneration,
    lastRevision: 1,
    lastEventSeq: 1,
    egress: replacement,
    generation: 2,
  });

  assert.equal(attach.kind, 'replay');
  assert.deepEqual(attach.records.map(({ eventSeq }) => eventSeq), [2]);
  assert.deepEqual(replacement.frames.map(({ type }) => type), [
    'state.patch',
    'domain.event',
    'ready',
  ]);
  assert.equal(replacement.frames[0].eventSeq, 2);
});

test('falls back to a snapshot when an advanced resume cursor crosses a retention gap', async () => {
  const { tokenStore } = createDeterministicTokenStore();
  const session = createSession({ capacity: 1, tokenStore });
  const { ready } = await issueResumeAnchor(session);

  for (const value of [2, 3, 4]) {
    await session.commit(`resume-gap-${value}`, () => ({
      changed: true,
      snapshot: { value },
      domainEvents: [],
      audioCommands: [],
    }));
  }

  const replacement = fakeEgress();
  const attach = await session.attach({
    clientId: 'client-a',
    token: ready.resumeToken,
    worldGeneration: ready.worldGeneration,
    lastRevision: 1,
    lastEventSeq: 1,
    egress: replacement,
    generation: 2,
  });

  assert.equal(attach.kind, 'snapshot');
  assert.equal(attach.snapshot.revision, 3);
  assert.equal(attach.snapshot.eventSeq, 3);
  assert.deepEqual(replacement.frames.map(({ type }) => type), [
    'snapshot',
    'ready',
  ]);
});

test('falls back to a snapshot for an in-range cursor pair that cannot reach the frozen head', async () => {
  const { tokenStore } = createDeterministicTokenStore();
  const session = createSession({ tokenStore });
  const { ready } = await issueResumeAnchor(session);

  for (const value of [2, 3]) {
    await session.commit(`inconsistent-cursor-${value}`, () => ({
      changed: true,
      snapshot: { value },
      domainEvents: [],
      audioCommands: [],
    }));
  }

  const replacement = fakeEgress();
  const attach = await session.attach({
    clientId: 'client-a',
    token: ready.resumeToken,
    worldGeneration: ready.worldGeneration,
    lastRevision: 1,
    lastEventSeq: 2,
    egress: replacement,
    generation: 2,
  });

  assert.equal(attach.kind, 'snapshot');
  assert.equal(attach.snapshot.revision, 2);
  assert.equal(attach.snapshot.eventSeq, 2);
  assert.deepEqual(replacement.frames.map(({ type }) => type), [
    'snapshot',
    'ready',
  ]);
});

test('falls back to a snapshot when a replay dependency returns only partial head coverage', async () => {
  const records = [];
  const partialJournal = {
    append(record) {
      records.push(structuredClone(record));
    },
    replayAfter() {
      return records.length === 0
        ? []
        : [structuredClone(records[0])];
    },
    clear() {
      records.length = 0;
    },
  };
  const { tokenStore } = createDeterministicTokenStore();
  const session = createSession({
    journal: partialJournal,
    tokenStore,
  });
  const { ready } = await issueResumeAnchor(session);

  for (const value of [2, 3]) {
    await session.commit(`partial-coverage-${value}`, () => ({
      changed: true,
      snapshot: { value },
      domainEvents: [],
      audioCommands: [],
    }));
  }

  const replacement = fakeEgress();
  const attach = await session.attach({
    clientId: 'client-a',
    token: ready.resumeToken,
    worldGeneration: ready.worldGeneration,
    lastRevision: 0,
    lastEventSeq: 0,
    egress: replacement,
    generation: 2,
  });

  assert.equal(attach.kind, 'snapshot');
  assert.deepEqual(replacement.frames.map(({ type }) => type), [
    'snapshot',
    'ready',
  ]);
});

test('keeps attach token and cursor rejection boundaries fail closed', async (context) => {
  await context.test('bootstrap cursor cannot advance past its anchor', async () => {
    const { tokenStore } = createDeterministicTokenStore();
    const session = createSession({ tokenStore });
    const bootstrap = await session.readBootstrap({ clientId: 'client-a' });
    await session.commit('bootstrap-advanced', () => ({
      changed: true,
      snapshot: { value: 2 },
      domainEvents: [],
      audioCommands: [],
    }));

    await assert.rejects(session.attach({
      clientId: 'client-a',
      token: bootstrap.bootstrapToken,
      worldGeneration: bootstrap.worldGeneration,
      lastRevision: 1,
      lastEventSeq: 1,
      egress: fakeEgress(),
      generation: 1,
    }), /ATTACH_TOKEN_INVALID/);
  });

  await context.test('resume cursor cannot fall below its anchor', async () => {
    const { tokenStore } = createDeterministicTokenStore();
    const session = createSession({ tokenStore });
    const { target } = await issueResumeAnchor(session);
    await session.commit('resume-anchor-advance', () => ({
      changed: true,
      snapshot: { value: 2 },
      domainEvents: [],
      audioCommands: [],
    }));
    await session.requestSnapshot({
      clientId: 'client-a',
      generation: 1,
    });
    const anchoredAtOne = target.frames.findLast(({ type }) => type === 'ready');

    await assert.rejects(session.attach({
      clientId: 'client-a',
      token: anchoredAtOne.resumeToken,
      worldGeneration: anchoredAtOne.worldGeneration,
      lastRevision: 0,
      lastEventSeq: 0,
      egress: fakeEgress(),
      generation: 2,
    }), /ATTACH_TOKEN_INVALID/);
  });

  await context.test('resume cursor cannot advance beyond the server head', async () => {
    const { tokenStore } = createDeterministicTokenStore();
    const session = createSession({ tokenStore });
    const { ready } = await issueResumeAnchor(session);

    await assert.rejects(session.attach({
      clientId: 'client-a',
      token: ready.resumeToken,
      worldGeneration: ready.worldGeneration,
      lastRevision: 1,
      lastEventSeq: 1,
      egress: fakeEgress(),
      generation: 2,
    }), /ATTACH_TOKEN_INVALID/);
  });

  await context.test('wrong client remains rejected', async () => {
    const { tokenStore } = createDeterministicTokenStore();
    const session = createSession({ tokenStore });
    const { ready } = await issueResumeAnchor(session);

    await assert.rejects(session.attach({
      clientId: 'client-b',
      token: ready.resumeToken,
      worldGeneration: ready.worldGeneration,
      lastRevision: ready.revision,
      lastEventSeq: ready.eventSeq,
      egress: fakeEgress(),
      generation: 2,
    }), /ATTACH_TOKEN_INVALID/);
  });

  await context.test('wrong generation remains rejected', async () => {
    const { tokenStore } = createDeterministicTokenStore();
    const session = createSession({ tokenStore });
    const { ready } = await issueResumeAnchor(session);

    await assert.rejects(session.attach({
      clientId: 'client-a',
      token: ready.resumeToken,
      worldGeneration: 'generation-old',
      lastRevision: ready.revision,
      lastEventSeq: ready.eventSeq,
      egress: fakeEgress(),
      generation: 2,
    }), /WORLD_GENERATION_MISMATCH/);
  });

  await context.test('tampered token remains rejected', async () => {
    const { tokenStore } = createDeterministicTokenStore();
    const session = createSession({ tokenStore });
    const { ready } = await issueResumeAnchor(session);

    await assert.rejects(session.attach({
      clientId: 'client-a',
      token: `${ready.resumeToken}x`,
      worldGeneration: ready.worldGeneration,
      lastRevision: ready.revision,
      lastEventSeq: ready.eventSeq,
      egress: fakeEgress(),
      generation: 2,
    }), /ATTACH_TOKEN_INVALID/);
  });

  await context.test('expired token remains rejected', async () => {
    const deterministic = createDeterministicTokenStore();
    const session = createSession({ tokenStore: deterministic.tokenStore });
    const { ready } = await issueResumeAnchor(session);
    deterministic.clock.set(ready.resumeExpiresAt);

    await assert.rejects(session.attach({
      clientId: 'client-a',
      token: ready.resumeToken,
      worldGeneration: ready.worldGeneration,
      lastRevision: ready.revision,
      lastEventSeq: ready.eventSeq,
      egress: fakeEgress(),
      generation: 2,
    }), /ATTACH_TOKEN_INVALID/);
  });

  await context.test('consumed token cannot be reused', async () => {
    const { tokenStore } = createDeterministicTokenStore();
    const session = createSession({ tokenStore });
    const { ready } = await issueResumeAnchor(session);
    await session.attach({
      clientId: 'client-a',
      token: ready.resumeToken,
      worldGeneration: ready.worldGeneration,
      lastRevision: ready.revision,
      lastEventSeq: ready.eventSeq,
      egress: fakeEgress(),
      generation: 2,
    });

    await assert.rejects(session.attach({
      clientId: 'client-a',
      token: ready.resumeToken,
      worldGeneration: ready.worldGeneration,
      lastRevision: ready.revision,
      lastEventSeq: ready.eventSeq,
      egress: fakeEgress(),
      generation: 3,
    }), /ATTACH_TOKEN_INVALID/);
  });

  await context.test('unknown token kind remains rejected', async () => {
    const { tokenStore } = createDeterministicTokenStore();
    const session = createSession({ tokenStore });
    const issued = tokenStore.issue({
      worldId: 'default',
      worldGeneration: session.worldGeneration,
      clientId: 'client-a',
      revision: 0,
      eventSeq: 0,
      kind: 'unknown',
    });

    await assert.rejects(session.attach({
      clientId: 'client-a',
      token: issued.token,
      worldGeneration: session.worldGeneration,
      lastRevision: 0,
      lastEventSeq: 0,
      egress: fakeEgress(),
      generation: 1,
    }), /ATTACH_TOKEN_INVALID/);
  });

  await context.test('malformed supplied cursor remains rejected', async () => {
    const { tokenStore } = createDeterministicTokenStore();
    const session = createSession({ tokenStore });
    const { ready } = await issueResumeAnchor(session);

    await assert.rejects(session.attach({
      clientId: 'client-a',
      token: ready.resumeToken,
      worldGeneration: ready.worldGeneration,
      lastRevision: -1,
      lastEventSeq: ready.eventSeq,
      egress: fakeEgress(),
      generation: 2,
    }), /ATTACH_CURSOR_INVALID/);
  });
});

test('serves bootstrap with exact CORS headers and rejects a different origin', async (context) => {
  const { tokenStore } = createDeterministicTokenStore();
  const session = createSession({ tokenStore });
  const bootstrapHandler = createBootstrapHandler({
    getSession: () => session,
    allowedOrigin: ALLOWED_ORIGIN,
    clientIdFactory: () => 'client-http',
  });
  const server = createCandidateServer({
    releaseInfo: {
      releaseRevision: 'release-a',
      runtimeOwner: 'browser',
      audioOwner: 'legacy',
    },
    apiHandler: bootstrapHandler,
  });
  context.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  const accepted = await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(accepted.headers.get('vary'), 'Origin');
  assert.equal((await accepted.json()).clientId, 'client-http');

  const rejected = await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
    headers: { Origin: 'http://localhost:4193' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(rejected.headers.get('vary'), 'Origin');

  const missing = await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`);
  assert.equal(missing.status, 403);
  assert.equal(missing.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(missing.headers.get('vary'), 'Origin');
});
