import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeClient } from '../src/runtime-client.js';

const BASE_URL = 'http://127.0.0.1:18090';

function snapshot({
  worldGeneration = 'generation-a',
  revision = 0,
  eventSeq = 0,
  day = 1,
} = {}) {
  return {
    worldId: 'default',
    worldGeneration,
    seed: 7,
    day,
    phase: 0.25,
    revision,
    eventSeq,
    protocolVersion: 1,
    snapshotSchemaVersion: 1,
    world: {
      trees: [{ id: 'tree-a', vitality: 0.8 }],
    },
  };
}

function bootstrap({
  worldGeneration = 'generation-a',
  revision = 0,
  eventSeq = 0,
  token = 'bootstrap-token',
  clientId = 'client-a',
  value = snapshot({ worldGeneration, revision, eventSeq }),
} = {}) {
  return {
    protocolVersion: 1,
    releaseRevision: 'unknown',
    worldId: 'default',
    worldGeneration,
    revision,
    eventSeq,
    snapshot: value,
    capabilities: {
      commands: ['runtime.pause', 'snapshot.request'],
    },
    clientId,
    bootstrapToken: token,
    bootstrapExpiresAt: 60_000,
  };
}

function ready({
  worldGeneration = 'generation-a',
  revision = 0,
  eventSeq = 0,
  token = 'resume-token-a',
} = {}) {
  return {
    type: 'ready',
    protocolVersion: 1,
    worldGeneration,
    revision,
    eventSeq,
    resumeToken: token,
    resumeExpiresAt: 120_000,
  };
}

function statePatch({
  worldGeneration = 'generation-a',
  eventSeq = 1,
  baseRevision = 0,
  resultRevision = 1,
  domainEventCount = 0,
  value = snapshot({
    worldGeneration,
    revision: resultRevision,
    eventSeq,
    day: resultRevision + 1,
  }),
  patch = [{
    op: 'replace',
    path: '',
    value,
  }],
} = {}) {
  return {
    type: 'state.patch',
    protocolVersion: 1,
    worldGeneration,
    eventSeq,
    baseRevision,
    resultRevision,
    domainEventCount,
    patch,
  };
}

function domainEvent({
  worldGeneration = 'generation-a',
  eventSeq = 1,
  eventIndex = 0,
  name = 'perch',
  payload = { treeId: 'tree-a' },
} = {}) {
  return {
    type: 'domain.event',
    protocolVersion: 1,
    worldGeneration,
    eventSeq,
    eventIndex,
    name,
    payload,
  };
}

function fullSnapshot({
  worldGeneration = 'generation-a',
  revision = 0,
  eventSeq = 0,
  value = snapshot({ worldGeneration, revision, eventSeq }),
} = {}) {
  return {
    type: 'snapshot',
    protocolVersion: 1,
    worldGeneration,
    revision,
    eventSeq,
    snapshot: value,
  };
}

class FakeWebSocket {
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = [];
    this.sendErrors = [];
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(payload) {
    assert.equal(this.readyState, 1, '测试 socket 只允许 open 后发送');
    if (this.sendErrors.length > 0) throw this.sendErrors.shift();
    this.sent.push(JSON.parse(payload));
  }

  failNextSend(error = new Error('socket send failed')) {
    this.sendErrors.push(error);
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.emit('open', {});
  }

  serverFrame(frame) {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  serverClose(code = 1006, reason = 'network lost') {
    this.readyState = 3;
    this.emit('close', { code, reason, wasClean: code === 1000 });
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function createHarness({
  bootstraps = [bootstrap()],
} = {}) {
  const fetchCalls = [];
  const sockets = [];
  let bootstrapIndex = 0;

  const fetchImpl = async (input, init) => {
    fetchCalls.push({ url: String(input), init });
    const body = bootstraps[Math.min(
      bootstrapIndex,
      bootstraps.length - 1,
    )];
    bootstrapIndex += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return structuredClone(body);
      },
    };
  };
  const webSocketFactory = (url) => {
    const socket = new FakeWebSocket(url);
    sockets.push(socket);
    return socket;
  };
  const client = createRuntimeClient({
    fetchImpl,
    webSocketFactory,
    baseUrl: BASE_URL,
    protocolVersion: 1,
  });
  return { client, fetchCalls, sockets };
}

async function waitFor(predicate, message = 'condition') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`等待 ${message} 超时`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function connectReady(harness, readyFrame = ready()) {
  const connecting = harness.client.connect();
  await waitFor(() => harness.sockets.length === 1, '首个 runtime socket');
  const socket = harness.sockets[0];
  socket.open();
  socket.serverFrame(readyFrame);
  await connecting;
  return socket;
}

function sentCommands(socket, name = null) {
  return socket.sent.filter((frame) => (
    frame.type === 'command' && (name === null || frame.name === name)
  ));
}

async function withGlobalIoTraps(operation) {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const socketDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'WebSocket',
  );
  let globalCalls = 0;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value() {
      globalCalls += 1;
      throw new Error('import 不得调用全局 fetch');
    },
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: class ForbiddenWebSocket {
      constructor() {
        globalCalls += 1;
        throw new Error('import 不得创建全局 WebSocket');
      }
    },
  });
  try {
    await operation(() => globalCalls);
  } finally {
    if (fetchDescriptor) {
      Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
    } else {
      delete globalThis.fetch;
    }
    if (socketDescriptor) {
      Object.defineProperty(globalThis, 'WebSocket', socketDescriptor);
    } else {
      delete globalThis.WebSocket;
    }
  }
}

test('import 与构造保持惰性，不读取全局 IO 或创建连接', async () => {
  await withGlobalIoTraps(async (getGlobalCalls) => {
    const module = await import(`../src/runtime-client.js?inert=${Date.now()}`);
    let injectedFetchCalls = 0;
    let injectedSocketCalls = 0;
    const client = module.createRuntimeClient({
      fetchImpl() {
        injectedFetchCalls += 1;
      },
      webSocketFactory() {
        injectedSocketCalls += 1;
      },
      baseUrl: BASE_URL,
      protocolVersion: 1,
    });

    assert.equal(getGlobalCalls(), 0);
    assert.equal(injectedFetchCalls, 0);
    assert.equal(injectedSocketCalls, 0);
    assert.equal(client.getStatus().phase, 'idle');
    assert.equal(client.getSnapshot(), null);
  });
});

test('connect 读取原子 bootstrap，发送精确 hello，并在 ready 后冻结快照', async () => {
  const harness = createHarness();
  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(harness.sockets.length, 0);

  const socket = await connectReady(harness);

  assert.deepEqual(harness.fetchCalls, [{
    url: `${BASE_URL}/api/v1/bootstrap`,
    init: undefined,
  }]);
  assert.equal(socket.url, 'ws://127.0.0.1:18090/api/v1/runtime');
  assert.deepEqual(socket.sent[0], {
    type: 'hello',
    protocolVersion: 1,
    clientId: 'client-a',
    bootstrapToken: 'bootstrap-token',
    worldGeneration: 'generation-a',
    lastRevision: 0,
    lastEventSeq: 0,
  });
  assert.deepEqual(harness.client.getStatus(), {
    phase: 'ready',
    clientId: 'client-a',
    worldGeneration: 'generation-a',
    revision: 0,
    eventSeq: 0,
  });
  assert.equal(Object.isFrozen(harness.client.getSnapshot()), true);
  assert.equal(Object.isFrozen(harness.client.getSnapshot().world), true);
  assert.equal(Object.isFrozen(
    harness.client.getSnapshot().world.trees[0],
  ), true);
  assert.throws(() => {
    harness.client.getSnapshot().day = 99;
  }, TypeError);
});

test('完整 eventSeq 记录到齐前不发布 patch，到齐后只原子发布一次', async () => {
  const harness = createHarness();
  const socket = await connectReady(harness);
  const published = [];
  const unsubscribe = harness.client.subscribe((value) => {
    published.push(value);
  });
  published.length = 0;

  socket.serverFrame(statePatch({ domainEventCount: 2 }));
  assert.equal(harness.client.getSnapshot().revision, 0);
  assert.equal(harness.client.getStatus().eventSeq, 0);
  assert.equal(published.length, 0);

  socket.serverFrame(domainEvent({ eventIndex: 0, name: 'perch' }));
  assert.equal(harness.client.getSnapshot().revision, 0);
  assert.equal(published.length, 0);

  socket.serverFrame(domainEvent({ eventIndex: 1, name: 'dawn' }));
  assert.equal(harness.client.getSnapshot().revision, 1);
  assert.equal(harness.client.getSnapshot().eventSeq, 1);
  assert.equal(harness.client.getSnapshot().day, 2);
  assert.equal(harness.client.getStatus().revision, 1);
  assert.equal(published.length, 1);
  assert.equal(Object.isFrozen(published[0].world.trees), true);

  unsubscribe();
  socket.serverFrame(statePatch({
    eventSeq: 2,
    baseRevision: 1,
    resultRevision: 2,
  }));
  assert.equal(published.length, 1);
});

test('游标不连续时丢弃局部记录并请求 snapshot barrier', async () => {
  const harness = createHarness();
  const socket = await connectReady(harness);

  socket.serverFrame(statePatch({
    eventSeq: 2,
    baseRevision: 1,
    resultRevision: 2,
  }));

  assert.equal(harness.client.getStatus().phase, 'resyncing');
  assert.equal(harness.client.getSnapshot().revision, 0);
  const request = sentCommands(socket, 'snapshot.request').at(-1);
  assert.deepEqual({
    type: request.type,
    protocolVersion: request.protocolVersion,
    worldGeneration: request.worldGeneration,
    baseRevision: request.baseRevision,
    name: request.name,
    payload: request.payload,
  }, {
    type: 'command',
    protocolVersion: 1,
    worldGeneration: 'generation-a',
    baseRevision: 0,
    name: 'snapshot.request',
    payload: {},
  });
  assert.match(
    request.commandId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  socket.serverFrame(fullSnapshot({
    revision: 2,
    eventSeq: 2,
  }));
  assert.equal(harness.client.getStatus().phase, 'resyncing');
  assert.equal(harness.client.getSnapshot().revision, 2);
  socket.serverFrame(ready({
    revision: 2,
    eventSeq: 2,
    token: 'resume-after-resync',
  }));
  assert.equal(harness.client.getStatus().phase, 'ready');
});

test('domain.event 索引错误时整条缓冲失效且只发一个 snapshot.request', async () => {
  const harness = createHarness();
  const socket = await connectReady(harness);

  socket.serverFrame(statePatch({ domainEventCount: 2 }));
  socket.serverFrame(domainEvent({ eventIndex: 1 }));
  socket.serverFrame(domainEvent({ eventIndex: 0 }));

  assert.equal(harness.client.getStatus().phase, 'resyncing');
  assert.equal(harness.client.getSnapshot().revision, 0);
  assert.equal(sentCommands(socket, 'snapshot.request').length, 1);
});

test('ready 轮换 token，断线后以最后游标 resume，替换 socket 的晚到帧被丢弃', async () => {
  const harness = createHarness();
  const first = await connectReady(harness);
  first.serverFrame(ready({ token: 'resume-token-rotated' }));

  first.serverClose();
  await waitFor(() => harness.sockets.length === 2, '重连 socket');
  const second = harness.sockets[1];
  second.open();
  assert.deepEqual(second.sent[0], {
    type: 'hello',
    protocolVersion: 1,
    clientId: 'client-a',
    resumeToken: 'resume-token-rotated',
    worldGeneration: 'generation-a',
    lastRevision: 0,
    lastEventSeq: 0,
  });

  first.serverFrame(statePatch());
  first.serverFrame(fullSnapshot({
    worldGeneration: 'late-generation',
    revision: 9,
    eventSeq: 9,
  }));
  assert.equal(harness.client.getSnapshot().revision, 0);
  assert.equal(harness.client.getStatus().worldGeneration, 'generation-a');

  second.serverFrame(ready({ token: 'resume-token-second' }));
  await waitFor(
    () => harness.client.getStatus().phase === 'ready',
    '重连 ready',
  );
  assert.equal(harness.fetchCalls.length, 1);
});

test('高游标 ready 未经 snapshot barrier 确认时不得提升恢复 token', async () => {
  const harness = createHarness({
    bootstraps: [
      bootstrap(),
      bootstrap({ token: 'bootstrap-token-recovery' }),
    ],
  });
  const first = await connectReady(harness);

  first.serverClose();
  await waitFor(() => harness.sockets.length === 2, '首次 resume socket');
  const second = harness.sockets[1];
  second.open();
  assert.equal(second.sent[0].resumeToken, 'resume-token-a');

  second.serverFrame(ready({
    revision: 2,
    eventSeq: 2,
    token: 'unsafe-high-cursor-token',
  }));
  assert.equal(harness.client.getStatus().phase, 'resyncing');
  assert.equal(harness.client.getSnapshot().revision, 0);

  second.serverClose();
  await waitFor(() => harness.sockets.length === 3, '安全 bootstrap socket');
  assert.equal(harness.fetchCalls.length, 2);
  const third = harness.sockets[2];
  third.open();
  assert.deepEqual(third.sent[0], {
    type: 'hello',
    protocolVersion: 1,
    clientId: 'client-a',
    bootstrapToken: 'bootstrap-token-recovery',
    worldGeneration: 'generation-a',
    lastRevision: 0,
    lastEventSeq: 0,
  });
  assert.notEqual(third.sent[0].resumeToken, 'unsafe-high-cursor-token');
});

test('live patch 后仍以同 clientId 和最后已应用游标重试待确认命令', async () => {
  const harness = createHarness();
  const first = await connectReady(harness);
  first.serverFrame(statePatch());
  assert.equal(harness.client.getStatus().revision, 1);
  const commandPromise = harness.client.command(
    'runtime.pause',
    {},
    { commandId: 'command-after-live-patch' },
  );
  const originalCommand = sentCommands(first, 'runtime.pause').at(-1);

  first.serverClose();
  await waitFor(() => harness.sockets.length === 2, 'live patch 重连 socket');
  const second = harness.sockets[1];
  second.open();

  assert.equal(harness.fetchCalls.length, 1);
  assert.deepEqual(second.sent[0], {
    type: 'hello',
    protocolVersion: 1,
    clientId: 'client-a',
    resumeToken: 'resume-token-a',
    worldGeneration: 'generation-a',
    lastRevision: 1,
    lastEventSeq: 1,
  });
  second.serverFrame(ready({
    revision: 1,
    eventSeq: 1,
    token: 'resume-token-after-replay',
  }));
  await waitFor(
    () => sentCommands(second, 'runtime.pause').length === 1,
    '同身份命令重试',
  );
  assert.deepEqual(
    sentCommands(second, 'runtime.pause')[0],
    originalCommand,
  );
  second.serverFrame({
    type: 'command.result',
    commandId: originalCommand.commandId,
    accepted: true,
    code: 'OK',
  });
  await commandPromise;
});

test('未确认命令在同一 worldGeneration 重连时复用原 commandId', async () => {
  const harness = createHarness();
  const first = await connectReady(harness);

  const resultPromise = harness.client.command(
    'runtime.pause',
    { paused: true },
  );
  const original = sentCommands(first, 'runtime.pause')[0];
  assert.match(
    original.commandId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(original.baseRevision, 0);
  assert.equal(original.worldGeneration, 'generation-a');

  first.serverClose();
  await waitFor(() => harness.sockets.length === 2, '命令重试 socket');
  const second = harness.sockets[1];
  second.open();
  second.serverFrame(ready({ token: 'resume-after-command-retry' }));
  await waitFor(
    () => sentCommands(second, 'runtime.pause').length === 1,
    '重发待确认命令',
  );
  const retried = sentCommands(second, 'runtime.pause')[0];
  assert.deepEqual(retried, original);

  second.serverFrame({
    type: 'command.result',
    commandId: original.commandId,
    accepted: true,
    code: 'OK',
  });
  assert.deepEqual(await resultPromise, {
    type: 'command.result',
    commandId: original.commandId,
    accepted: true,
    code: 'OK',
  });
});

test('duplicate command.result 不会让已完成命令在后续重连再次发送', async () => {
  const harness = createHarness();
  const first = await connectReady(harness);
  const resultPromise = harness.client.command(
    'runtime.pause',
    {},
    { commandId: 'duplicate-result-command' },
  );
  const result = {
    type: 'command.result',
    commandId: 'duplicate-result-command',
    accepted: true,
    code: 'OK',
  };
  first.serverFrame(result);
  assert.deepEqual(await resultPromise, result);
  first.serverFrame(result);

  first.serverClose();
  await waitFor(() => harness.sockets.length === 2, 'duplicate 后重连');
  const second = harness.sockets[1];
  second.open();
  second.serverFrame(ready({ token: 'resume-after-duplicate' }));
  await waitFor(
    () => harness.client.getStatus().phase === 'ready',
    'duplicate 后 ready',
  );
  assert.equal(sentCommands(second, 'runtime.pause').length, 0);
});

test('畸形 command.result 不得 settle pending，后续合法结果仍可完成', async () => {
  const harness = createHarness();
  const socket = await connectReady(harness);
  const resultPromise = harness.client.command(
    'runtime.pause',
    {},
    { commandId: 'validated-command-result' },
  );
  let settled = false;
  resultPromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  socket.serverFrame({
    type: 'command.result',
    commandId: 'validated-command-result',
    accepted: 'yes',
    code: '',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  const valid = {
    type: 'command.result',
    commandId: 'validated-command-result',
    accepted: true,
    code: 'OK',
  };
  socket.serverFrame(valid);
  assert.deepEqual(await resultPromise, valid);
});

test('hello send 抛错被收口为 connect 拒绝，不从 open 回调泄漏', async () => {
  const harness = createHarness();
  const connecting = harness.client.connect();
  await waitFor(() => harness.sockets.length === 1, 'hello send socket');
  const socket = harness.sockets[0];
  socket.failNextSend();

  assert.doesNotThrow(() => socket.open());
  await assert.rejects(connecting, /RUNTIME_SEND_FAILED/);
  assert.equal(harness.client.getStatus().phase, 'idle');
});

test('snapshot.request send 抛错会拒绝 waiter 并使坏 socket 失效', async () => {
  const harness = createHarness();
  const socket = await connectReady(harness);
  socket.failNextSend();
  let barrier;

  assert.doesNotThrow(() => {
    barrier = harness.client.requestSnapshot();
  });
  await assert.rejects(barrier, /RUNTIME_SEND_FAILED/);
  await waitFor(() => harness.sockets.length === 2, 'snapshot send 重连');
  assert.equal(socket.closeCalls.at(-1).code, 1011);
});

test('重连重发 send 抛错会拒绝 pending 且不从 ready 回调泄漏', async () => {
  const harness = createHarness();
  const first = await connectReady(harness);
  const commandPromise = harness.client.command(
    'runtime.pause',
    {},
    { commandId: 'retry-send-failure' },
  );
  first.serverClose();
  await waitFor(() => harness.sockets.length === 2, '重发失败 socket');
  const second = harness.sockets[1];
  second.open();
  second.failNextSend();

  assert.doesNotThrow(() => {
    second.serverFrame(ready({ token: 'resume-before-send-failure' }));
  });
  await assert.rejects(commandPromise, /RUNTIME_SEND_FAILED/);
  await waitFor(() => harness.sockets.length === 3, '重发失败后重连');
  assert.equal(second.closeCalls.at(-1).code, 1011);
});

test('bootstrap fetch 晚于 disconnect 完成时不得发布快照或创建 socket', async () => {
  const response = deferred();
  let fetchCalls = 0;
  let socketCalls = 0;
  const client = createRuntimeClient({
    fetchImpl() {
      fetchCalls += 1;
      return response.promise;
    },
    webSocketFactory() {
      socketCalls += 1;
      return new FakeWebSocket('ws://forbidden-after-disconnect');
    },
    baseUrl: BASE_URL,
    protocolVersion: 1,
  });
  const connecting = client.connect();
  const rejected = assert.rejects(
    connecting,
    /RUNTIME_CLIENT_DISCONNECTED/,
  );
  await waitFor(() => fetchCalls === 1, 'pending bootstrap fetch');
  client.disconnect();
  await rejected;

  response.resolve({
    ok: true,
    status: 200,
    async json() {
      return bootstrap();
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.getStatus().phase, 'closed');
  assert.equal(client.getSnapshot(), null);
  assert.equal(socketCalls, 0);
});

test('bootstrap json 晚于 disconnect 完成时不得复活连接尝试', async () => {
  const jsonBody = deferred();
  let jsonCalls = 0;
  let socketCalls = 0;
  const client = createRuntimeClient({
    async fetchImpl() {
      return {
        ok: true,
        status: 200,
        json() {
          jsonCalls += 1;
          return jsonBody.promise;
        },
      };
    },
    webSocketFactory() {
      socketCalls += 1;
      return new FakeWebSocket('ws://forbidden-after-disconnect');
    },
    baseUrl: BASE_URL,
    protocolVersion: 1,
  });
  const connecting = client.connect();
  const rejected = assert.rejects(
    connecting,
    /RUNTIME_CLIENT_DISCONNECTED/,
  );
  await waitFor(() => jsonCalls === 1, 'pending bootstrap json');
  client.disconnect();
  await rejected;
  jsonBody.resolve(bootstrap());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.getStatus().phase, 'closed');
  assert.equal(client.getSnapshot(), null);
  assert.equal(socketCalls, 0);
});

test('connecting socket 在 disconnect 后的 open/message 回调全部失效', async () => {
  const harness = createHarness();
  const connecting = harness.client.connect();
  const rejected = assert.rejects(
    connecting,
    /RUNTIME_CLIENT_DISCONNECTED/,
  );
  await waitFor(() => harness.sockets.length === 1, 'connecting socket');
  const socket = harness.sockets[0];
  const beforeDisconnect = harness.client.getSnapshot();

  harness.client.disconnect();
  await rejected;
  socket.open();
  socket.serverFrame(statePatch());
  socket.serverFrame(ready());

  assert.equal(harness.client.getStatus().phase, 'closed');
  assert.equal(harness.client.getSnapshot(), beforeDisconnect);
  assert.deepEqual(socket.sent, []);
  assert.equal(harness.sockets.length, 1);
});

test('显式 disconnect 进入终态，关闭当前 socket 且不再自动重连', async () => {
  const harness = createHarness();
  const socket = await connectReady(harness);
  harness.client.disconnect();

  assert.equal(harness.client.getStatus().phase, 'closed');
  assert.deepEqual(socket.closeCalls, [{
    code: 1000,
    reason: 'CLIENT_DISCONNECT',
  }]);
  socket.serverClose(1000, 'CLIENT_DISCONNECT');
  socket.serverFrame(statePatch());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.client.getSnapshot().revision, 0);
  await assert.rejects(
    harness.client.connect(),
    /RUNTIME_CLIENT_CLOSED/,
  );
  await assert.rejects(
    harness.client.command('runtime.pause', {}),
    /RUNTIME_CLIENT_CLOSED/,
  );
});

test('新 worldGeneration snapshot 丢弃旧缓冲与旧命令，旧 generation 帧不能复活', async () => {
  const harness = createHarness();
  const socket = await connectReady(harness);
  socket.serverFrame(statePatch({ domainEventCount: 1 }));
  const oldCommand = harness.client.command(
    'runtime.pause',
    {},
    { commandId: 'old-world-command' },
  );
  const rejected = assert.rejects(
    oldCommand,
    /WORLD_GENERATION_CHANGED/,
  );

  socket.serverFrame(fullSnapshot({
    worldGeneration: 'generation-b',
    revision: 0,
    eventSeq: 0,
    value: snapshot({
      worldGeneration: 'generation-b',
      revision: 0,
      eventSeq: 0,
      day: 100,
    }),
  }));
  await rejected;
  assert.equal(harness.client.getSnapshot().worldGeneration, 'generation-b');
  assert.equal(harness.client.getSnapshot().day, 100);

  socket.serverFrame(domainEvent({
    worldGeneration: 'generation-a',
    eventSeq: 1,
    eventIndex: 0,
  }));
  socket.serverFrame(domainEvent({
    worldGeneration: 'generation-b',
    eventSeq: 0,
    eventIndex: 0,
    name: 'world.reset',
    payload: {
      reason: 'test-reset',
      worldGeneration: 'generation-b',
    },
  }));
  socket.serverFrame(ready({
    worldGeneration: 'generation-b',
    token: 'resume-generation-b',
  }));
  assert.equal(harness.client.getStatus().phase, 'ready');

  socket.serverFrame(statePatch({
    worldGeneration: 'generation-b',
    eventSeq: 1,
    baseRevision: 0,
    resultRevision: 1,
    value: snapshot({
      worldGeneration: 'generation-b',
      revision: 1,
      eventSeq: 1,
      day: 101,
    }),
  }));
  assert.equal(harness.client.getSnapshot().day, 101);
});

test('只收到新 generation ready 时先清空旧快照与缓冲，再请求该世代 snapshot', async () => {
  const harness = createHarness();
  const socket = await connectReady(harness);
  socket.serverFrame(statePatch({ domainEventCount: 1 }));

  socket.serverFrame(ready({
    worldGeneration: 'generation-b',
    token: 'resume-generation-b-first',
  }));
  assert.equal(harness.client.getStatus().worldGeneration, 'generation-b');
  assert.equal(harness.client.getStatus().phase, 'resyncing');
  assert.equal(harness.client.getSnapshot(), null);
  assert.equal(sentCommands(socket, 'snapshot.request').length, 1);

  socket.serverFrame(domainEvent({
    worldGeneration: 'generation-a',
    eventSeq: 1,
  }));
  socket.serverFrame(fullSnapshot({
    worldGeneration: 'generation-b',
    value: snapshot({
      worldGeneration: 'generation-b',
      day: 200,
    }),
  }));
  socket.serverFrame(ready({
    worldGeneration: 'generation-b',
    token: 'resume-generation-b-final',
  }));
  assert.equal(harness.client.getStatus().phase, 'ready');
  assert.equal(harness.client.getSnapshot().day, 200);
});

test('显式 requestSnapshot 等待 snapshot + ready barrier 后完成', async () => {
  const harness = createHarness();
  const socket = await connectReady(harness);

  const barrier = harness.client.requestSnapshot();
  assert.equal(harness.client.getStatus().phase, 'resyncing');
  assert.equal(sentCommands(socket, 'snapshot.request').length, 1);
  socket.serverFrame(fullSnapshot({
    revision: 3,
    eventSeq: 3,
  }));
  socket.serverFrame(ready({
    revision: 3,
    eventSeq: 3,
    token: 'resume-after-explicit-snapshot',
  }));

  assert.deepEqual(await barrier, harness.client.getSnapshot());
  assert.equal(harness.client.getStatus().phase, 'ready');
});
