import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';

import { createConnectionEgress } from '../src/api/connection-egress.js';
import { createRuntimeWsGateway } from '../src/api/runtime-ws.js';
import { createTokenStore } from '../src/protocol/token-store.js';
import { createCandidateServer } from '../src/server.js';
import { createJournal } from '../src/world-session/journal.js';
import { WorldSession } from '../src/world-session/world-session.js';

const ALLOWED_ORIGIN = 'http://127.0.0.1:4193';

function createTokenStoreForTest() {
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

function createFakeKernel() {
  let value = 1;
  let nextSnapshotError = null;
  return {
    commandCalls: [],
    getSnapshot() {
      if (nextSnapshotError) {
        const error = nextSnapshotError;
        nextSnapshotError = null;
        throw error;
      }
      return { value };
    },
    failNextSnapshot(error) {
      nextSnapshotError = error;
    },
    applyCommand(command, context) {
      this.commandCalls.push(structuredClone(command));
      this.lastCommandContext = context;
      value += 1;
      return {
        changed: true,
        snapshot: { value },
        domainEvents: [{ name: 'changed', payload: { value } }],
        audioCommands: [],
        commandResult: { accepted: true, code: 'OK' },
      };
    },
    dispose() {},
  };
}

function createSession({
  journalCapacity = 8,
  kernel = createFakeKernel(),
  mailbox,
  tokenStore = createTokenStoreForTest(),
  worldGenerationFactory = (() => {
    let generation = 0;
    return () => `generation-${String.fromCharCode(97 + generation++)}`;
  })(),
} = {}) {
  const session = new WorldSession({
    seed: 7,
    createKernel: () => kernel,
    validateRestoredSnapshot: () => true,
    clock: { now: () => 1_000 },
    worldGenerationFactory,
    releaseRevision: 'release-a',
    capabilities: { commands: ['runtime.pause', 'snapshot.request'] },
    tokenStore,
    journal: createJournal({ capacity: journalCapacity }),
    mailbox,
  });
  return { kernel, session, tokenStore };
}

function createTrackingMailbox() {
  let tail = Promise.resolve();
  let inside = false;
  return {
    isInside: () => inside,
    post(label, operation) {
      const result = tail.then(async () => {
        inside = true;
        try {
          return await operation();
        } finally {
          inside = false;
        }
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

function fakeEgress({ capacity = Infinity } = {}) {
  return {
    frames: [],
    closes: [],
    enqueue(frame) {
      if (this.frames.length >= capacity) return false;
      this.frames.push(structuredClone(frame));
      return true;
    },
    close(code, reason) {
      this.closes.push({ code, reason });
    },
  };
}

function fakeSocket() {
  const socket = new EventEmitter();
  socket.closes = [];
  socket.send = () => {
    throw new Error('fake gateway egress must not use network sends');
  };
  socket.close = (code, reason) => {
    socket.closes.push({ code, reason });
  };
  return socket;
}

function createGatewayHarness(session) {
  const webSocketServer = new EventEmitter();
  webSocketServer.handleUpgrade = (
    request,
    networkSocket,
    head,
    callback,
  ) => callback(networkSocket);
  const egressBySocket = new Map();
  const gateway = createRuntimeWsGateway({
    getSession: () => session,
    allowedOrigin: ALLOWED_ORIGIN,
    webSocketServer,
    createEgress({ socket }) {
      const target = fakeEgress();
      target.startWriter = () => undefined;
      const close = target.close.bind(target);
      target.close = (code, reason) => {
        close(code, reason);
        socket.close(code, reason);
      };
      egressBySocket.set(socket, target);
      return target;
    },
  });
  return {
    egressBySocket,
    gateway,
    upgrade(socket, options = {}) {
      const origin = Object.hasOwn(options, 'origin')
        ? options.origin
        : ALLOWED_ORIGIN;
      const url = options.url ?? '/api/v1/runtime';
      const headers = {};
      if (origin !== undefined) headers.origin = origin;
      gateway.handleUpgrade({ headers, url }, socket, Buffer.alloc(0));
    },
  };
}

function encoded(frame) {
  return Buffer.from(JSON.stringify(frame));
}

function helloFrom(frame, tokenName = 'bootstrapToken') {
  return {
    type: 'hello',
    protocolVersion: 1,
    clientId: 'client-a',
    [tokenName]: frame[tokenName],
    worldGeneration: frame.worldGeneration,
    lastRevision: frame.revision,
    lastEventSeq: frame.eventSeq,
  };
}

function runtimeCommand(session, commandId, overrides = {}) {
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

async function attachInitial(session, egress, generation = 1, clientId = 'client-a') {
  const bootstrap = await session.readBootstrap({ clientId });
  const attach = await session.attach({
    clientId,
    token: bootstrap.bootstrapToken,
    worldGeneration: bootstrap.worldGeneration,
    lastRevision: bootstrap.revision,
    lastEventSeq: bootstrap.eventSeq,
    egress,
    generation,
  });
  return { attach, bootstrap };
}

test('drains bounded egress FIFO with only one socket send in flight', async () => {
  const sends = [];
  const callbacks = [];
  const socket = {
    send(payload, callback) {
      sends.push(JSON.parse(payload));
      callbacks.push(callback);
    },
    close() {},
  };
  const egress = createConnectionEgress({ socket, capacity: 2 });
  assert.equal(egress.enqueue({ sequence: 1 }), true);
  assert.equal(egress.enqueue({ sequence: 2 }), true);
  egress.startWriter();
  assert.deepEqual(sends.map(({ sequence }) => sequence), [1]);
  callbacks.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sends.map(({ sequence }) => sequence), [1, 2]);
  callbacks.shift()();
});

test('closes overflowed egress and refuses a partial queue', () => {
  const closes = [];
  const egress = createConnectionEgress({
    socket: {
      send() {
        throw new Error('writer must not start in this test');
      },
      close(code, reason) {
        closes.push({ code, reason });
      },
    },
    capacity: 1,
  });
  assert.equal(egress.enqueue({ sequence: 1 }), true);
  assert.equal(egress.enqueue({ sequence: 2 }), false);
  assert.deepEqual(closes, [{ code: 4410, reason: 'EGRESS_OVERFLOW' }]);
});

test('counts the in-flight send against the bounded egress capacity', () => {
  const callbacks = [];
  const closes = [];
  const egress = createConnectionEgress({
    socket: {
      send(payload, callback) {
        callbacks.push(callback);
      },
      close(code, reason) {
        closes.push({ code, reason });
      },
    },
    capacity: 2,
  });
  assert.equal(egress.enqueue({ sequence: 1 }), true);
  assert.equal(egress.enqueue({ sequence: 2 }), true);
  egress.startWriter();

  assert.equal(egress.enqueue({ sequence: 3 }), false);
  assert.deepEqual(closes, [{ code: 4410, reason: 'EGRESS_OVERFLOW' }]);
  callbacks.shift()();
});

test('closes egress with 1011 when socket.send throws synchronously', () => {
  const closes = [];
  const egress = createConnectionEgress({
    socket: {
      send() {
        throw new Error('send failed');
      },
      close(code, reason) {
        closes.push({ code, reason });
      },
    },
  });

  assert.equal(egress.enqueue({ sequence: 1 }), true);
  egress.startWriter();

  assert.deepEqual(closes, [{
    code: 1011,
    reason: 'EGRESS_SEND_FAILED',
  }]);
  assert.equal(egress.enqueue({ sequence: 2 }), false);
});

test('closes egress with 1011 when the send callback reports an error', () => {
  const closes = [];
  let sendCallback;
  const egress = createConnectionEgress({
    socket: {
      send(payload, callback) {
        sendCallback = callback;
      },
      close(code, reason) {
        closes.push({ code, reason });
      },
    },
  });

  assert.equal(egress.enqueue({ sequence: 1 }), true);
  egress.startWriter();
  assert.deepEqual(closes, []);
  sendCallback(new Error('async send failed'));

  assert.deepEqual(closes, [{
    code: 1011,
    reason: 'EGRESS_SEND_FAILED',
  }]);
  assert.equal(egress.enqueue({ sequence: 2 }), false);
});

test('requires the exact origin and a hello as the first websocket frame', async () => {
  const { session } = createSession();
  const harness = createGatewayHarness(session);

  for (const origin of [undefined, 'http://localhost:4193']) {
    const rejected = fakeSocket();
    harness.upgrade(rejected, { origin });
    assert.deepEqual(rejected.closes, [{
      code: 4403,
      reason: 'ORIGIN_FORBIDDEN',
    }]);
    assert.equal(rejected.listenerCount('message'), 0);
  }

  const badOrder = fakeSocket();
  harness.upgrade(badOrder);
  const firstMessage = badOrder.listeners('message')[0];
  await firstMessage(encoded(runtimeCommand(session, 'too-early')), false);
  assert.deepEqual(badOrder.closes, [{
    code: 4400,
    reason: 'HELLO_REQUIRED',
  }]);

  const wrongPath = fakeSocket();
  harness.upgrade(wrongPath, { url: '/api/v1/not-runtime' });
  assert.deepEqual(wrongPath.closes, [{
    code: 4404,
    reason: 'RUNTIME_PATH_REQUIRED',
  }]);
  assert.equal(wrongPath.listenerCount('message'), 0);
});

test('closing detaches before a captured command can reach the kernel', async () => {
  const { kernel, session } = createSession();
  const detach = session.detach.bind(session);
  let detachCalls = 0;
  session.detach = (request) => {
    detachCalls += 1;
    return detach(request);
  };
  const harness = createGatewayHarness(session);
  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });
  const socket = fakeSocket();
  harness.upgrade(socket);
  const message = socket.listeners('message')[0];
  await message(encoded(helloFrom(bootstrap)), false);
  const target = harness.egressBySocket.get(socket);
  const framesBeforeClosing = target.frames.length;
  const before = {
    revision: session.revision,
    eventSeq: session.eventSeq,
    kernelCalls: kernel.commandCalls.length,
  };

  await message(encoded({ type: 'not-a-command' }), false);
  assert.deepEqual(socket.closes, [{
    code: 4400,
    reason: 'COMMAND_REQUIRED',
  }]);
  const closingResult = await message(encoded(runtimeCommand(
    session,
    'captured-while-closing',
  )), false);

  assert.deepEqual(closingResult, {
    type: 'command.result',
    commandId: 'captured-while-closing',
    accepted: false,
    code: 'STALE_CONNECTION_GENERATION',
  });
  assert.deepEqual({
    revision: session.revision,
    eventSeq: session.eventSeq,
    kernelCalls: kernel.commandCalls.length,
  }, before);
  assert.equal(target.frames.length, framesBeforeClosing);
  assert.equal(detachCalls, 1);

  await socket.listeners('close')[0]();
  assert.equal(detachCalls, 1);
  const closedResult = await message(encoded(runtimeCommand(
    session,
    'captured-after-close',
  )), false);
  assert.deepEqual(closedResult, {
    type: 'command.result',
    commandId: 'captured-after-close',
    accepted: false,
    code: 'STALE_CONNECTION_GENERATION',
  });
  assert.equal(detachCalls, 1);
  assert.deepEqual({
    revision: session.revision,
    eventSeq: session.eventSeq,
    kernelCalls: kernel.commandCalls.length,
  }, before);
});

test('contains a closing stale-route rejection inside the message listener', async () => {
  const { session } = createSession();
  const harness = createGatewayHarness(session);
  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });
  const socket = fakeSocket();
  harness.upgrade(socket);
  const message = socket.listeners('message')[0];
  await message(encoded(helloFrom(bootstrap)), false);
  await message(encoded({ type: 'not-a-command' }), false);
  session.executeCommand = async () => {
    throw new Error('closing stale route failed');
  };
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);

  try {
    const [outcome] = await Promise.allSettled([
      message(encoded(runtimeCommand(
        session,
        'rejecting-while-closing',
      )), false),
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(outcome.status, 'fulfilled');
    assert.deepEqual(unhandled, []);
    assert.deepEqual(socket.closes, [{
      code: 4400,
      reason: 'COMMAND_REQUIRED',
    }]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('allocates globally monotonic generations without per-client state', async () => {
  const attachments = [];
  const session = {
    async attach({ clientId, token, generation }) {
      attachments.push({ clientId, generation });
      if (token === 'bad-token') throw new Error('bad token');
    },
    async detach() {
      return true;
    },
  };
  function makeGateway() {
    const webSocketServer = new EventEmitter();
    webSocketServer.handleUpgrade = (
      request,
      networkSocket,
      head,
      callback,
    ) => callback(networkSocket);
    return createRuntimeWsGateway({
      getSession: () => session,
      allowedOrigin: ALLOWED_ORIGIN,
      webSocketServer,
      createEgress({ socket }) {
        return {
          enqueue: () => true,
          startWriter() {},
          close(code, reason) {
            socket.close(code, reason);
          },
        };
      },
    });
  }
  const gateways = [makeGateway(), makeGateway()];

  for (const [gatewayIndex, clientId, token] of [
    [0, 'bad-client-a', 'bad-token'],
    [1, 'bad-client-b', 'bad-token'],
    [0, 'good-client', 'good-token'],
    [1, 'bad-client-a', 'bad-token'],
  ]) {
    const socket = fakeSocket();
    gateways[gatewayIndex].handleUpgrade({
      headers: { origin: ALLOWED_ORIGIN },
      url: '/api/v1/runtime',
    }, socket, Buffer.alloc(0));
    const message = socket.listeners('message')[0];
    await message(encoded({
      type: 'hello',
      protocolVersion: 1,
      clientId,
      bootstrapToken: token,
      worldGeneration: 'generation-a',
      lastRevision: 0,
      lastEventSeq: 0,
    }), false);
  }

  const generations = attachments.map(({ generation }) => generation);
  assert.equal(generations.every(Number.isSafeInteger), true);
  assert.equal(generations.every((generation) => generation > 0), true);
  assert.deepEqual(
    generations,
    generations.map((generation, index) => generations[0] + index),
  );
});

test('orders attach and snapshot barriers before later live commits', async () => {
  const { session } = createSession();
  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });
  await session.commit('first', () => ({
    changed: true,
    snapshot: { value: 2 },
    domainEvents: [{ name: 'changed', payload: { value: 2 } }],
    audioCommands: [],
  }));
  const heldEgress = fakeEgress();

  const attachPromise = session.attach({
    clientId: 'client-a',
    token: bootstrap.bootstrapToken,
    worldGeneration: bootstrap.worldGeneration,
    lastRevision: bootstrap.revision,
    lastEventSeq: bootstrap.eventSeq,
    egress: heldEgress,
    generation: 2,
  });
  const concurrentCommit = session.commit('after-attach', () => ({
    changed: true,
    snapshot: { value: 3 },
    domainEvents: [{ name: 'changed', payload: { value: 3 } }],
    audioCommands: [],
  }));
  await Promise.all([attachPromise, concurrentCommit]);
  assert.deepEqual(heldEgress.frames.map(({ type }) => type), [
    'state.patch',
    'domain.event',
    'ready',
    'state.patch',
    'domain.event',
  ]);

  const snapshotPromise = session.requestSnapshot({
    clientId: 'client-a',
    generation: 2,
  });
  const commitAfterSnapshot = session.commit('after-snapshot', () => ({
    changed: true,
    snapshot: { value: 4 },
    domainEvents: [],
    audioCommands: [],
  }));
  await Promise.all([snapshotPromise, commitAfterSnapshot]);
  assert.deepEqual(heldEgress.frames.slice(-3).map(({ type }) => type), [
    'snapshot',
    'ready',
    'state.patch',
  ]);
});

test('attach preparation failure leaves the previous generation live', async () => {
  const kernel = createFakeKernel();
  const { session } = createSession({
    journalCapacity: 1,
    kernel,
  });
  const previous = fakeEgress();
  await attachInitial(session, previous, 1);
  const resume = previous.frames.at(-1);

  for (const value of [2, 3]) {
    await session.commit(`attach-gap-${value}`, () => ({
      changed: true,
      snapshot: { value },
      domainEvents: [],
      audioCommands: [],
    }));
  }
  previous.frames.length = 0;
  kernel.failNextSnapshot(new Error('attach snapshot unavailable'));
  const replacement = fakeEgress();

  await assert.rejects(session.attach({
    clientId: 'client-a',
    token: resume.resumeToken,
    worldGeneration: resume.worldGeneration,
    lastRevision: resume.revision,
    lastEventSeq: resume.eventSeq,
    egress: replacement,
    generation: 2,
  }), /attach snapshot unavailable/);
  assert.deepEqual(previous.closes, []);
  assert.deepEqual(replacement.frames, []);

  await session.commit('after-failed-attach', () => ({
    changed: true,
    snapshot: { value: 4 },
    domainEvents: [{ name: 'previous-still-live', payload: {} }],
    audioCommands: [],
  }));
  assert.deepEqual(previous.frames.map(({ type }) => type), [
    'state.patch',
    'domain.event',
  ]);

  const stale = await session.executeCommand({
    clientId: 'client-a',
    generation: 2,
    command: runtimeCommand(session, 'failed-attach-generation'),
  });
  assert.equal(stale.code, 'STALE_CONNECTION_GENERATION');
});

test('emits one root patch followed by ordered domain event frames', async () => {
  const { session } = createSession();
  const target = fakeEgress();
  await attachInitial(session, target, 1);
  target.frames.length = 0;

  await session.commit('ordered-record', () => ({
    changed: true,
    snapshot: { value: 2 },
    domainEvents: [
      { name: 'first', payload: { order: 1 } },
      { name: 'second', payload: { order: 2 } },
    ],
    audioCommands: [],
  }));

  assert.deepEqual(target.frames.map(({ type }) => type), [
    'state.patch',
    'domain.event',
    'domain.event',
  ]);
  assert.deepEqual({
    eventSeq: target.frames[0].eventSeq,
    baseRevision: target.frames[0].baseRevision,
    resultRevision: target.frames[0].resultRevision,
    domainEventCount: target.frames[0].domainEventCount,
    op: target.frames[0].patch[0].op,
    path: target.frames[0].patch[0].path,
    snapshotRevision: target.frames[0].patch[0].value.revision,
  }, {
    eventSeq: 1,
    baseRevision: 0,
    resultRevision: 1,
    domainEventCount: 2,
    op: 'replace',
    path: '',
    snapshotRevision: 1,
  });
  assert.deepEqual(
    target.frames.slice(1).map(({ eventSeq, eventIndex, name }) => ({
      eventSeq,
      eventIndex,
      name,
    })),
    [
      { eventSeq: 1, eventIndex: 0, name: 'first' },
      { eventSeq: 1, eventIndex: 1, name: 'second' },
    ],
  );
});

test('a no-change commit advances no cursor and emits no frame', async () => {
  const { session } = createSession();
  const target = fakeEgress();
  await attachInitial(session, target, 1);
  target.frames.length = 0;
  const before = [session.revision, session.eventSeq];

  const result = await session.commit('no-change', () => ({
    changed: false,
    snapshot: { value: 999 },
    domainEvents: [{ name: 'must-not-send', payload: {} }],
    audioCommands: [],
  }));

  assert.equal(result.changed, false);
  assert.deepEqual([session.revision, session.eventSeq], before);
  assert.deepEqual(target.frames, []);
});

test('queues command result in its mailbox transaction before a later commit', async () => {
  const { session } = createSession();
  const harness = createGatewayHarness(session);
  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });
  const socket = fakeSocket();
  harness.upgrade(socket);
  const message = socket.listeners('message')[0];
  await message(encoded(helloFrom(bootstrap)), false);
  const target = harness.egressBySocket.get(socket);
  target.frames.length = 0;

  const commandPromise = message(encoded(runtimeCommand(
    session,
    'ordered-command-result',
  )), false);
  const laterCommit = session.commit('after-command-result', () => ({
    changed: true,
    snapshot: { value: 3 },
    domainEvents: [{ name: 'later', payload: {} }],
    audioCommands: [],
  }));
  await Promise.all([commandPromise, laterCommit]);

  assert.deepEqual(target.frames.map(({ type }) => type), [
    'state.patch',
    'domain.event',
    'command.result',
    'state.patch',
    'domain.event',
  ]);
});

test('enqueues an active command result inside the session mailbox', async () => {
  const mailbox = createTrackingMailbox();
  const { session } = createSession({ mailbox });
  const target = fakeEgress();
  const enqueueInsideMailbox = [];
  const enqueue = target.enqueue.bind(target);
  target.enqueue = (frame) => {
    enqueueInsideMailbox.push(mailbox.isInside());
    return enqueue(frame);
  };
  await attachInitial(session, target, 1);
  target.frames.length = 0;
  enqueueInsideMailbox.length = 0;

  const result = await session.executeCommand({
    clientId: 'client-a',
    generation: 1,
    command: runtimeCommand(session, 'mailbox-command-result'),
  });

  assert.deepEqual(target.frames.map(({ type }) => type), [
    'state.patch',
    'domain.event',
    'command.result',
  ]);
  assert.deepEqual(enqueueInsideMailbox, [true, true, true]);
  assert.deepEqual(target.frames.at(-1), result);
});

test('does not mistake an active kernel result code for transport staleness', async () => {
  const kernel = createFakeKernel();
  kernel.applyCommand = function applyCommand(command, context) {
    this.commandCalls.push(structuredClone(command));
    this.lastCommandContext = context;
    return {
      changed: false,
      domainEvents: [],
      audioCommands: [],
      commandResult: {
        accepted: false,
        code: 'STALE_CONNECTION_GENERATION',
      },
    };
  };
  const { session } = createSession({ kernel });
  const harness = createGatewayHarness(session);
  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });
  const socket = fakeSocket();
  harness.upgrade(socket);
  const message = socket.listeners('message')[0];
  await message(encoded(helloFrom(bootstrap)), false);
  const target = harness.egressBySocket.get(socket);
  target.frames.length = 0;

  const result = await message(encoded(runtimeCommand(
    session,
    'reserved-code-from-kernel',
  )), false);

  assert.equal(result.code, 'STALE_CONNECTION_GENERATION');
  assert.deepEqual(target.frames, [result]);
});

test('validates a routed snapshot command after the exact generation check', async () => {
  const { kernel, session } = createSession();
  const target = fakeEgress();
  await attachInitial(session, target, 1);
  target.frames.length = 0;
  const gateway = createRuntimeWsGateway({
    getSession: () => session,
    allowedOrigin: ALLOWED_ORIGIN,
  });

  const stale = await gateway.routeCommand({
    session,
    clientId: 'client-a',
    generation: 0,
    command: {
      name: 'snapshot.request',
      commandId: 'stale-snapshot',
      protocolVersion: 999,
      worldGeneration: 'stale-generation',
      baseRevision: -1,
    },
  });
  assert.deepEqual(stale, {
    type: 'command.result',
    commandId: 'stale-snapshot',
    accepted: false,
    code: 'STALE_CONNECTION_GENERATION',
  });
  assert.deepEqual(target.frames, []);

  for (const [commandId, overrides, code] of [
    ['bad-protocol', { protocolVersion: 999 }, 'INVALID_COMMAND'],
    ['bad-id', { commandId: '' }, 'INVALID_COMMAND'],
    ['bad-cursor', { baseRevision: -1 }, 'INVALID_COMMAND'],
    [
      'old-world',
      { worldGeneration: 'generation-old' },
      'WORLD_GENERATION_MISMATCH',
    ],
  ]) {
    const result = await gateway.routeCommand({
      session,
      clientId: 'client-a',
      generation: 1,
      command: {
        type: 'command',
        protocolVersion: 1,
        commandId,
        worldGeneration: session.worldGeneration,
        baseRevision: session.revision,
        name: 'snapshot.request',
        payload: {},
        ...overrides,
      },
    });
    assert.equal(result.type, 'command.result');
    assert.equal(result.code, code);
    assert.equal(target.frames.at(-1).type, 'command.result');
    assert.equal(target.frames.at(-1).code, code);
  }
  assert.equal(kernel.commandCalls.length, 0);
  assert.equal(target.frames.some(({ type }) => type === 'snapshot'), false);
});

test('snapshot preparation failure leaves the exact subscription live', async () => {
  const kernel = createFakeKernel();
  const { session } = createSession({ kernel });
  const target = fakeEgress();
  await attachInitial(session, target, 1);
  target.frames.length = 0;
  kernel.failNextSnapshot(new Error('snapshot unavailable'));

  await assert.rejects(session.requestSnapshot({
    clientId: 'client-a',
    generation: 1,
  }), /snapshot unavailable/);
  await session.commit('after-snapshot-failure', () => ({
    changed: true,
    snapshot: { value: 2 },
    domainEvents: [{ name: 'still-live', payload: {} }],
    audioCommands: [],
  }));

  assert.deepEqual(target.frames.map(({ type }) => type), [
    'state.patch',
    'domain.event',
  ]);
});

test('routes command-shaped snapshot requests through the mailbox without the kernel', async () => {
  const { kernel, session } = createSession();
  const egress = fakeEgress();
  await attachInitial(session, egress, 1);
  const gateway = createRuntimeWsGateway({
    getSession: () => session,
    allowedOrigin: ALLOWED_ORIGIN,
  });
  const callsBefore = kernel.commandCalls.length;

  await gateway.routeCommand({
    session,
    clientId: 'client-a',
    generation: 1,
    command: {
      type: 'command',
      protocolVersion: 1,
      commandId: 'snapshot-command-a',
      worldGeneration: session.worldGeneration,
      baseRevision: session.revision,
      name: 'snapshot.request',
      payload: {},
    },
  });

  assert.equal(kernel.commandCalls.length, callsBefore);
  assert.deepEqual(egress.frames.slice(-2).map(({ type }) => type), [
    'snapshot',
    'ready',
  ]);
});

test('checks every barrier enqueue and removes only the overflowing generation', async () => {
  const { session } = createSession();
  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });
  await session.commit('overflow-replay', () => ({
    changed: true,
    snapshot: { value: 2 },
    domainEvents: [],
    audioCommands: [],
  }));
  const overflow = fakeEgress({ capacity: 1 });

  await assert.rejects(session.attach({
    clientId: 'client-a',
    token: bootstrap.bootstrapToken,
    worldGeneration: bootstrap.worldGeneration,
    lastRevision: bootstrap.revision,
    lastEventSeq: bootstrap.eventSeq,
    egress: overflow,
    generation: 1,
  }), /EGRESS_OVERFLOW/);
  assert.deepEqual(overflow.frames.map(({ type }) => type), ['state.patch']);
  assert.deepEqual(overflow.closes, [{ code: 4410, reason: 'EGRESS_OVERFLOW' }]);

  const stale = await session.executeCommand({
    clientId: 'client-a',
    generation: 1,
    command: {
      type: 'command',
      protocolVersion: 1,
      commandId: 'after-overflow',
      worldGeneration: session.worldGeneration,
      baseRevision: session.revision,
      name: 'runtime.pause',
      payload: {},
    },
  });
  assert.equal(stale.code, 'STALE_CONNECTION_GENERATION');
});

test('checks snapshot barrier ready enqueue and removes its exact generation', async () => {
  const { session } = createSession();
  const overflow = fakeEgress({ capacity: 2 });
  await attachInitial(session, overflow, 1);

  await assert.rejects(session.requestSnapshot({
    clientId: 'client-a',
    generation: 1,
  }), /EGRESS_OVERFLOW/);
  assert.deepEqual(overflow.frames.map(({ type }) => type), [
    'ready',
    'snapshot',
  ]);
  assert.deepEqual(overflow.closes, [{
    code: 4410,
    reason: 'EGRESS_OVERFLOW',
  }]);
  const stale = await session.executeCommand({
    clientId: 'client-a',
    generation: 1,
    command: runtimeCommand(session, 'snapshot-overflow-command'),
  });
  assert.equal(stale.code, 'STALE_CONNECTION_GENERATION');
});

test('removes a slow live generation and replays from its last ready token', async () => {
  const { session } = createSession();
  const slow = fakeEgress({ capacity: 2 });
  await attachInitial(session, slow, 1);
  const resume = slow.frames.findLast(({ type }) => type === 'ready');

  await session.commit('overflow-live', () => ({
    changed: true,
    snapshot: { value: 2 },
    domainEvents: [{ name: 'changed', payload: { value: 2 } }],
    audioCommands: [],
  }));
  assert.deepEqual(slow.closes, [{
    code: 4410,
    reason: 'EGRESS_OVERFLOW',
  }]);

  const replacement = fakeEgress();
  const attach = await session.attach({
    clientId: 'client-a',
    token: resume.resumeToken,
    worldGeneration: resume.worldGeneration,
    lastRevision: resume.revision,
    lastEventSeq: resume.eventSeq,
    egress: replacement,
    generation: 2,
  });
  assert.equal(attach.kind, 'replay');
  assert.deepEqual(attach.records.map(({ eventSeq }) => eventSeq), [1]);
  assert.deepEqual(replacement.frames.map(({ type }) => type), [
    'state.patch',
    'domain.event',
    'ready',
  ]);
});

test('routes a captured replaced-socket command through the mailbox stale check', async () => {
  const { kernel, session } = createSession();
  const harness = createGatewayHarness(session);
  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });

  const oldSocket = fakeSocket();
  harness.upgrade(oldSocket);
  const oldMessage = oldSocket.listeners('message')[0];
  await oldMessage(encoded(helloFrom(bootstrap)), false);
  const oldReady = harness.egressBySocket.get(oldSocket).frames.at(-1);

  const activeSocket = fakeSocket();
  harness.upgrade(activeSocket);
  const activeMessage = activeSocket.listeners('message')[0];
  await activeMessage(
    encoded(helloFrom(oldReady, 'resumeToken')),
    false,
  );
  assert.deepEqual(oldSocket.closes, [{
    code: 4409,
    reason: 'CONNECTION_REPLACED',
  }]);

  const before = {
    revision: session.revision,
    eventSeq: session.eventSeq,
    kernelCalls: kernel.commandCalls.length,
  };
  const stale = await oldMessage(encoded(runtimeCommand(
    session,
    'replacement-race-command',
    {
      protocolVersion: 999,
      worldGeneration: 'stale-generation',
      baseRevision: -1,
    },
  )), false);
  assert.deepEqual(stale, {
    type: 'command.result',
    commandId: 'replacement-race-command',
    accepted: false,
    code: 'STALE_CONNECTION_GENERATION',
  });
  assert.deepEqual({
    revision: session.revision,
    eventSeq: session.eventSeq,
    kernelCalls: kernel.commandCalls.length,
  }, before);

  const active = await activeMessage(encoded(runtimeCommand(
    session,
    'replacement-race-command',
  )), false);
  assert.equal(active.accepted, true);
  assert.equal(kernel.commandCalls.length, before.kernelCalls + 1);
});

test('routes a captured closed-socket command only after exact cleanup commits', async () => {
  const { kernel, session } = createSession();
  const oldHarness = createGatewayHarness(session);
  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });

  const oldSocket = fakeSocket();
  oldHarness.upgrade(oldSocket);
  const oldMessage = oldSocket.listeners('message')[0];
  await oldMessage(encoded(helloFrom(bootstrap)), false);
  const oldReady = oldHarness.egressBySocket.get(oldSocket).frames.at(-1);

  const activeHarness = createGatewayHarness(session);
  const activeSocket = fakeSocket();
  activeHarness.upgrade(activeSocket);
  const activeMessage = activeSocket.listeners('message')[0];
  await activeMessage(
    encoded(helloFrom(oldReady, 'resumeToken')),
    false,
  );
  const closeCleanup = oldSocket.listeners('close')[0]();
  assert.equal(typeof closeCleanup?.then, 'function');
  await closeCleanup;

  const before = {
    revision: session.revision,
    eventSeq: session.eventSeq,
    kernelCalls: kernel.commandCalls.length,
  };
  const stale = await oldMessage(encoded(runtimeCommand(
    session,
    'close-race-command',
    {
      protocolVersion: 999,
      worldGeneration: 'stale-generation',
      baseRevision: -1,
    },
  )), false);
  assert.deepEqual(stale, {
    type: 'command.result',
    commandId: 'close-race-command',
    accepted: false,
    code: 'STALE_CONNECTION_GENERATION',
  });
  assert.deepEqual({
    revision: session.revision,
    eventSeq: session.eventSeq,
    kernelCalls: kernel.commandCalls.length,
  }, before);

  const active = await activeMessage(encoded(runtimeCommand(
    session,
    'close-race-command',
  )), false);
  assert.equal(active.accepted, true);
  assert.equal(kernel.commandCalls.length, before.kernelCalls + 1);
});

test('reset clears old windows and barriers every surviving egress on a new generation', async () => {
  const { session, tokenStore } = createSession();
  const egress = fakeEgress();
  await attachInitial(session, egress, 1);
  await session.executeCommand({
    clientId: 'client-a',
    generation: 1,
    command: runtimeCommand(session, 'reset-window-command'),
  });
  const oldBootstrap = await session.readBootstrap({ clientId: 'client-b' });
  egress.frames.length = 0;
  const replacementKernel = createFakeKernel();

  const result = await session.resetWorld({
    kernel: replacementKernel,
    reason: 'test-reset',
  });

  assert.deepEqual(result, {
    reason: 'test-reset',
    worldGeneration: 'generation-b',
    revision: 0,
    eventSeq: 0,
  });
  assert.deepEqual(egress.frames.map(({ type }) => type), [
    'snapshot',
    'domain.event',
    'ready',
  ]);
  assert.equal(egress.frames[1].name, 'world.reset');
  assert.equal(egress.frames[2].worldGeneration, 'generation-b');

  assert.equal(tokenStore.consume(oldBootstrap.bootstrapToken, {
    worldId: 'default',
    worldGeneration: oldBootstrap.worldGeneration,
    clientId: 'client-b',
    revision: oldBootstrap.revision,
    eventSeq: oldBootstrap.eventSeq,
    kind: 'bootstrap',
  }), null);

  const resetReady = egress.frames[2];
  const replacementEgress = fakeEgress();
  const attach = await session.attach({
    clientId: 'client-a',
    token: resetReady.resumeToken,
    worldGeneration: resetReady.worldGeneration,
    lastRevision: resetReady.revision,
    lastEventSeq: resetReady.eventSeq,
    egress: replacementEgress,
    generation: 2,
  });
  assert.equal(attach.kind, 'replay');
  assert.deepEqual(attach.records, []);
  assert.deepEqual(replacementEgress.frames.map(({ type }) => type), ['ready']);

  const repeatedAfterReset = await session.executeCommand({
    clientId: 'client-a',
    generation: 2,
    command: runtimeCommand(session, 'reset-window-command'),
  });
  assert.equal(repeatedAfterReset.accepted, true);
  assert.equal(replacementKernel.commandCalls.length, 1);
});

test('reset token preparation failure preserves the old world and live windows', async () => {
  let failTokenIssue = false;
  let fill = 0;
  const tokenStore = createTokenStore({
    clock: { now: () => 1_000 },
    ttlMs: 5_000,
    randomBytes(size) {
      if (failTokenIssue) throw new Error('token source unavailable');
      fill += 1;
      return Buffer.alloc(size, fill);
    },
  });
  let disposeCalls = 0;
  const kernel = createFakeKernel();
  kernel.dispose = () => {
    disposeCalls += 1;
  };
  const { session } = createSession({ kernel, tokenStore });
  const target = fakeEgress();
  await attachInitial(session, target, 1);
  const oldReady = target.frames.at(-1);
  const tuple = [
    session.worldGeneration,
    session.revision,
    session.eventSeq,
  ];
  target.frames.length = 0;
  failTokenIssue = true;

  await assert.rejects(session.resetWorld({
    kernel: createFakeKernel(),
    reason: 'token-failure',
  }), /token source unavailable/);
  assert.equal(disposeCalls, 0);
  assert.equal(session.kernel, kernel);
  assert.deepEqual([
    session.worldGeneration,
    session.revision,
    session.eventSeq,
  ], tuple);

  failTokenIssue = false;
  await session.commit('after-failed-reset', () => ({
    changed: true,
    snapshot: { value: 2 },
    domainEvents: [{ name: 'old-world-live', payload: {} }],
    audioCommands: [],
  }));
  assert.deepEqual(target.frames.map(({ type }) => type), [
    'state.patch',
    'domain.event',
  ]);

  const replacement = fakeEgress();
  const attach = await session.attach({
    clientId: 'client-a',
    token: oldReady.resumeToken,
    worldGeneration: oldReady.worldGeneration,
    lastRevision: oldReady.revision,
    lastEventSeq: oldReady.eventSeq,
    egress: replacement,
    generation: 2,
  });
  assert.equal(attach.kind, 'replay');
  assert.deepEqual(attach.records.map(({ eventSeq }) => eventSeq), [1]);
});

test('commits a staged reset even when old-kernel disposal throws', async () => {
  let disposeCalls = 0;
  const kernel = createFakeKernel();
  const replacement = createFakeKernel();
  let session;
  let tupleObservedDuringDispose;
  kernel.dispose = () => {
    disposeCalls += 1;
    tupleObservedDuringDispose = [
      session.kernel === replacement,
      session.worldGeneration,
      session.revision,
      session.eventSeq,
    ];
    throw new Error('old kernel dispose failed');
  };
  ({ session } = createSession({ kernel }));
  const target = fakeEgress();
  await attachInitial(session, target, 1);
  target.frames.length = 0;

  const result = await session.resetWorld({
    kernel: replacement,
    reason: 'dispose-failure',
  });

  assert.equal(disposeCalls, 1);
  assert.deepEqual(tupleObservedDuringDispose, [
    true,
    'generation-b',
    0,
    0,
  ]);
  assert.equal(session.kernel, replacement);
  assert.deepEqual(result, {
    reason: 'dispose-failure',
    worldGeneration: 'generation-b',
    revision: 0,
    eventSeq: 0,
  });
  assert.deepEqual(target.frames.map(({ type }) => type), [
    'snapshot',
    'domain.event',
    'ready',
  ]);
});

test('rejects an invalid or reused reset generation before mutation', async (context) => {
  for (const candidate of ['', null, 'generation-a']) {
    await context.test(String(candidate), async () => {
      const generated = ['generation-a', candidate];
      let disposeCalls = 0;
      const kernel = createFakeKernel();
      kernel.dispose = () => {
        disposeCalls += 1;
      };
      const { session } = createSession({
        kernel,
        worldGenerationFactory: () => generated.shift(),
      });
      const target = fakeEgress();
      await attachInitial(session, target, 1);
      const oldReady = target.frames.at(-1);
      const preservedCommand = runtimeCommand(
        session,
        'preserved-reset-window',
      );
      const firstResult = await session.executeCommand({
        clientId: 'client-a',
        generation: 1,
        command: preservedCommand,
      });
      target.frames.length = 0;
      let snapshotCalls = 0;
      const replacement = createFakeKernel();
      const getSnapshot = replacement.getSnapshot.bind(replacement);
      replacement.getSnapshot = () => {
        snapshotCalls += 1;
        return getSnapshot();
      };

      await assert.rejects(session.resetWorld({
        kernel: replacement,
        reason: 'invalid-generation',
      }), /WORLD_GENERATION_INVALID/);

      assert.equal(session.kernel, kernel);
      assert.deepEqual(
        [session.worldGeneration, session.revision, session.eventSeq],
        ['generation-a', 1, 1],
      );
      assert.equal(disposeCalls, 0);
      assert.equal(snapshotCalls, 0);
      assert.deepEqual(target.frames, []);
      assert.deepEqual(
        session.journal.replayAfter(0, 0).map(({ eventSeq }) => eventSeq),
        [1],
      );
      assert.equal(session.idempotency.size, 1);

      const duplicate = await session.executeCommand({
        clientId: 'client-a',
        generation: 1,
        command: preservedCommand,
      });
      assert.deepEqual(duplicate, firstResult);
      assert.equal(kernel.commandCalls.length, 1);
      assert.deepEqual(target.frames, [firstResult]);

      const replacementEgress = fakeEgress();
      const attach = await session.attach({
        clientId: 'client-a',
        token: oldReady.resumeToken,
        worldGeneration: oldReady.worldGeneration,
        lastRevision: oldReady.revision,
        lastEventSeq: oldReady.eventSeq,
        egress: replacementEgress,
        generation: 2,
      });
      assert.equal(attach.kind, 'replay');
      assert.deepEqual(
        attach.records.map(({ eventSeq }) => eventSeq),
        [1],
      );
    });
  }
});

test('real websocket overflow closes cleanly without escaping the listener', async (context) => {
  const { session } = createSession();
  const gateway = createRuntimeWsGateway({
    getSession: () => session,
    allowedOrigin: ALLOWED_ORIGIN,
    egressCapacity: 1,
  });
  const server = createCandidateServer({
    releaseInfo: {
      releaseRevision: 'release-a',
      runtimeOwner: 'browser',
      audioOwner: 'legacy',
    },
    upgradeHandler: gateway.handleUpgrade,
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/api/v1/runtime`;

  const forbidden = new WebSocket(url);
  const forbiddenClose = once(forbidden, 'close');
  await once(forbidden, 'open');
  const [forbiddenCode] = await forbiddenClose;
  assert.equal(forbiddenCode, 4403);

  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });
  const socket = new WebSocket(url, { origin: ALLOWED_ORIGIN });
  context.after(() => socket.terminate());
  await once(socket, 'open');
  const readyMessage = once(socket, 'message');
  socket.send(JSON.stringify(helloFrom(bootstrap)));
  const [readyPayload] = await readyMessage;
  assert.equal(JSON.parse(readyPayload.toString()).type, 'ready');

  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const closePromise = once(socket, 'close');
    socket.send(JSON.stringify({
      type: 'command',
      protocolVersion: 1,
      commandId: 'overflow-snapshot',
      worldGeneration: session.worldGeneration,
      baseRevision: session.revision,
      name: 'snapshot.request',
      payload: {},
    }));
    const [code, reason] = await closePromise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      { code, reason: reason.toString() },
      { code: 4410, reason: 'EGRESS_OVERFLOW' },
    );
    assert.deepEqual(unhandled, []);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('real websocket internal failure closes 1011 and detaches exactly', async (context) => {
  const { kernel, session } = createSession();
  const gateway = createRuntimeWsGateway({
    getSession: () => session,
    allowedOrigin: ALLOWED_ORIGIN,
  });
  const server = createCandidateServer({
    releaseInfo: {
      releaseRevision: 'release-a',
      runtimeOwner: 'browser',
      audioOwner: 'legacy',
    },
    upgradeHandler: gateway.handleUpgrade,
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/api/v1/runtime`;
  const bootstrap = await session.readBootstrap({ clientId: 'client-a' });
  const socket = new WebSocket(url, { origin: ALLOWED_ORIGIN });
  context.after(() => socket.terminate());
  await once(socket, 'open');
  const readyMessage = once(socket, 'message');
  socket.send(JSON.stringify(helloFrom(bootstrap)));
  const [readyPayload] = await readyMessage;
  assert.equal(JSON.parse(readyPayload.toString()).type, 'ready');

  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    kernel.failNextSnapshot(new Error('snapshot source failed'));
    const closePromise = once(socket, 'close');
    socket.send(JSON.stringify({
      type: 'command',
      protocolVersion: 1,
      commandId: 'throwing-snapshot',
      worldGeneration: session.worldGeneration,
      baseRevision: session.revision,
      name: 'snapshot.request',
      payload: {},
    }));
    const [code, reason] = await closePromise;
    await session.runExclusive('after-internal-close', () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      { code, reason: reason.toString() },
      { code: 1011, reason: 'RUNTIME_MESSAGE_FAILED' },
    );
    assert.deepEqual(unhandled, []);

    const stale = await session.executeCommand({
      clientId: 'client-a',
      generation: 1,
      command: runtimeCommand(session, 'after-internal-close'),
    });
    assert.equal(stale.code, 'STALE_CONNECTION_GENERATION');
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
