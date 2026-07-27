import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer, get } from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';

import { PHASE_CONFIG } from '../src/config.js';
import {
  createRuntimeApp,
  PHASE_2_SHADOW_SEED,
} from '../src/runtime-app.js';

const releaseInfo = Object.freeze({
  releaseRevision: 'unknown',
  sourceManifestSha256: 'unknown',
  protocolFamily: 'flock-runtime',
  protocolVersion: 1,
  runtimeOwner: 'browser',
  audioOwner: 'legacy',
});

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

async function within(promise, milliseconds = 500) {
  let handle;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        handle = setTimeout(() => resolve(Symbol.for('timeout')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(handle);
  }
}

async function readBootstrap(port) {
  return new Promise((resolve, reject) => {
    const request = get({
      host: '127.0.0.1',
      port,
      path: '/api/v1/bootstrap',
      headers: { origin: PHASE_CONFIG.allowedOrigin },
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        statusCode: incoming.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
  });
}

function createHarness() {
  const calls = {
    listen: 0,
    serverClose: 0,
    wsClose: 0,
    timers: [],
    cleared: [],
    serverOptions: null,
  };
  let listenCallback = null;
  const server = {
    listen(port, host, callback) {
      calls.listen += 1;
      calls.listenArgs = { port, host };
      listenCallback = callback;
    },
    close(callback) {
      calls.serverClose += 1;
      callback?.();
    },
  };
  const webSocketServer = {
    clients: new Set(),
    on() {},
    close(callback) {
      calls.wsClose += 1;
      callback?.();
    },
  };
  const app = createRuntimeApp({
    runtimeConfig: PHASE_CONFIG,
    releaseInfo,
    createServer(options) {
      calls.serverOptions = options;
      return server;
    },
    createWebSocketServer: () => webSocketServer,
    createGateway: () => ({ handleUpgrade() {}, routeCommand() {} }),
    scheduleInterval(callback, milliseconds) {
      const handle = { callback, milliseconds };
      calls.timers.push(handle);
      return handle;
    },
    clearScheduledInterval(handle) {
      calls.cleared.push(handle);
    },
  });
  return { app, calls, fireListen: () => listenCallback() };
}

test('import/create 零 timer 零 listen，只在 localhost listen 成功后启动 fixed tick', async () => {
  assert.equal(PHASE_2_SHADOW_SEED, 0x4c4353);
  const { app, calls, fireListen } = createHarness();
  assert.equal(calls.listen, 0);
  assert.equal(calls.timers.length, 0);
  assert.equal(typeof calls.serverOptions.apiHandler, 'function');
  assert.equal(typeof calls.serverOptions.upgradeHandler, 'function');

  const started = app.start();
  assert.equal(calls.listen, 1);
  assert.deepEqual(calls.listenArgs, { port: 18090, host: '127.0.0.1' });
  assert.equal(calls.timers.length, 0);
  fireListen();
  await started;
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].milliseconds, 1000 / 30);
  assert.equal(app.registry.get('default').revision, 0);
  calls.timers[0].callback();
  await flush();
  assert.equal(app.registry.get('default').revision, 1);

  await app.stop();
  assert.deepEqual(calls.cleared, [calls.timers[0]]);
  assert.equal(calls.serverClose, 1);
  assert.equal(calls.wsClose, 1);
  assert.throws(() => app.registry.get('default').kernel.getSnapshot(), /DISPOSED/);
  await app.stop();
  assert.equal(calls.serverClose, 1);
});

test('double start 拒绝，stop 后 upgrade 在 gateway 前 fail closed', async () => {
  const { app, calls, fireListen } = createHarness();
  const started = app.start();
  assert.throws(() => app.start(), /RUNTIME_APP_ALREADY_STARTED/);
  fireListen();
  await started;
  await app.stop();
  const socket = {
    destroyed: false,
    destroy() { this.destroyed = true; },
  };
  calls.serverOptions.upgradeHandler({}, socket, Buffer.alloc(0));
  assert.equal(socket.destroyed, true);
});

test('real localhost start/stop race 两个 Promise 都必须有界 settle', async () => {
  const app = createRuntimeApp({
    runtimeConfig: { ...PHASE_CONFIG, port: 0 },
    releaseInfo,
  });
  const starting = app.start();
  const stopping = app.stop();
  assert.equal(await within(starting), false);
  assert.equal(await within(stopping), true);
  assert.equal(app.server.address(), null);
});

test('listen error 有界 reject 且之后 stop 仍幂等', async () => {
  const blocker = createHttpServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  const { port } = blocker.address();
  const app = createRuntimeApp({
    runtimeConfig: { ...PHASE_CONFIG, port },
    releaseInfo,
  });
  try {
    await assert.rejects(app.start(), (error) => error.code === 'EADDRINUSE');
    assert.equal(await app.stop(), true);
    assert.equal(await app.stop(), true);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('real localhost app 把 /api/v1/bootstrap 接入权威 session', async () => {
  const app = createRuntimeApp({
    runtimeConfig: { ...PHASE_CONFIG, port: 0 },
    releaseInfo,
    scheduleInterval: () => ({ fake: true }),
    clearScheduledInterval: () => {},
  });
  await app.start();
  try {
    const { port } = app.server.address();
    const response = await readBootstrap(port);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.worldId, 'default');
    assert.equal(response.body.revision, 0);
    assert.equal(response.body.snapshot.paused, false);
  } finally {
    await app.stop();
  }
});

test('stop 关闭 active WS，detach 跨过 mailbox barrier 后才 dispose kernel', async () => {
  const app = createRuntimeApp({
    runtimeConfig: { ...PHASE_CONFIG, port: 0 },
    releaseInfo,
    scheduleInterval: () => ({ fake: true }),
    clearScheduledInterval: () => {},
  });
  await app.start();
  const { port } = app.server.address();
  const bootstrap = (await readBootstrap(port)).body;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/runtime`, {
    origin: PHASE_CONFIG.allowedOrigin,
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    clientId: bootstrap.clientId,
    worldGeneration: bootstrap.worldGeneration,
    bootstrapToken: bootstrap.bootstrapToken,
    lastRevision: bootstrap.revision,
    lastEventSeq: bootstrap.eventSeq,
  }));
  await new Promise((resolve, reject) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8'));
      if (frame.type === 'ready') resolve();
    });
    socket.on('error', reject);
  });
  const session = app.registry.get('default');
  assert.equal(session.subscriptions.size, 1);
  const closed = once(socket, 'close');
  await app.stop();
  await closed;
  assert.equal(session.subscriptions.size, 0);
  assert.throws(() => session.kernel.getSnapshot(), /DISPOSED/);
});
