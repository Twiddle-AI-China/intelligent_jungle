import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer, get } from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';

import {
  authorizeExactIpv4LoopbackTransport,
  createOriginPolicy,
} from '../src/api/origin-policy.js';
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
const PHASE_ORIGIN_POLICY = createOriginPolicy({
  canonicalOrigin: PHASE_CONFIG.canonicalOrigin,
  opsAuthorities: PHASE_CONFIG.opsAuthorities,
  authorizeOperationalTransport: authorizeExactIpv4LoopbackTransport,
});
const PHASE_AUTHORITY = new URL(PHASE_CONFIG.canonicalOrigin).host;
const frozenStaticUi = (originPolicy = PHASE_ORIGIN_POLICY) => Object.freeze({
  originPolicy,
  handleHttp: () => false,
});
const frozenAudioGateway = (originPolicy = PHASE_ORIGIN_POLICY) => Object.freeze({
  originPolicy,
  handleUpgrade() {},
  close: async () => {},
});
const frozenLegacyRoutes = (originPolicy = PHASE_ORIGIN_POLICY) => Object.freeze({
  originPolicy,
  handleHttp: () => false,
  handleUpgrade: () => false,
  close: async () => {},
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

async function readJson(port, path = '/api/v1/bootstrap') {
  return new Promise((resolve, reject) => {
    const request = get({
      host: '127.0.0.1',
      port,
      path,
      headers: { host: PHASE_AUTHORITY, origin: PHASE_CONFIG.canonicalOrigin },
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

const readBootstrap = (port) => readJson(port);

function createHarness({
  audioOwnerController = null,
  audioGateway = null,
  legacyRoutes = null,
  runtimeConfig = PHASE_CONFIG,
  staticUi = null,
  originPolicy = PHASE_ORIGIN_POLICY,
} = {}) {
  const calls = {
    listen: 0,
    serverClose: 0,
    wsClose: 0,
    timers: [],
    cleared: [],
    serverOptions: null,
    bootstrapOptions: null,
    latentOptions: null,
    gatewayOptions: null,
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
    runtimeConfig,
    releaseInfo,
    createServer(options) {
      calls.serverOptions = options;
      return server;
    },
    createBootstrap(options) {
      calls.bootstrapOptions = options;
      return () => false;
    },
    createLatentMapRoutes(options) {
      calls.latentOptions = options;
      return () => false;
    },
    createWebSocketServer: () => webSocketServer,
    createGateway(options) {
      calls.gatewayOptions = options;
      return { handleUpgrade() {}, routeCommand() {} };
    },
    scheduleInterval(callback, milliseconds) {
      const handle = { callback, milliseconds };
      calls.timers.push(handle);
      return handle;
    },
    clearScheduledInterval(handle) {
      calls.cleared.push(handle);
    },
    audioOwnerController,
    audioGateway,
    legacyRoutes,
    staticUi,
    originPolicy,
  });
  return { app, calls, fireListen: () => listenCallback() };
}

test('fixed container-local profile reaches the real runtime app listen seam', async () => {
  const runtimeConfig = { ...PHASE_CONFIG, host: '0.0.0.0', port: 8090 };
  const { app, calls, fireListen } = createHarness({ runtimeConfig });
  const started = app.start(); fireListen(); await started;
  assert.deepEqual(calls.listenArgs, { host: '0.0.0.0', port: 8090 });
  await app.stop();
});

test('runtime app injects the prevalidated static UI into the candidate server', () => {
  const staticUi = frozenStaticUi();
  const { calls } = createHarness({ staticUi });
  assert.equal(calls.serverOptions.staticUi, staticUi);
});

test('runtime app passes one frozen exact-origin policy to every HTTP and runtime seam', () => {
  const { calls } = createHarness();
  assert.equal(Object.isFrozen(PHASE_ORIGIN_POLICY), true);
  assert.equal(calls.bootstrapOptions.originPolicy, PHASE_ORIGIN_POLICY);
  assert.equal(calls.latentOptions.originPolicy, PHASE_ORIGIN_POLICY);
  assert.equal(calls.gatewayOptions.originPolicy, PHASE_ORIGIN_POLICY);
  assert.equal(calls.serverOptions.originPolicy, PHASE_ORIGIN_POLICY);
  assert.equal(Object.hasOwn(calls.bootstrapOptions, 'allowedOrigin'), false);
  assert.equal(Object.hasOwn(calls.latentOptions, 'allowedOrigin'), false);
  assert.equal(Object.hasOwn(calls.gatewayOptions, 'allowedOrigin'), false);
});

test('runtime app rejects a missing or mutable origin policy before server creation', () => {
  for (const originPolicy of [
    undefined,
    null,
    { authorize() {} },
    Object.freeze({ authorize: null }),
  ]) {
    assert.throws(
      () => createRuntimeApp({ runtimeConfig: PHASE_CONFIG, releaseInfo, originPolicy }),
      /RUNTIME_APP_DEPENDENCIES_INVALID/,
    );
  }
});

test('runtime app rejects mutable, incomplete, or policy-mismatched preconstructed gateways early', () => {
  const otherPolicy = createOriginPolicy({ canonicalOrigin: 'http://localhost:8090' });
  const cases = [
    { staticUi: { originPolicy: PHASE_ORIGIN_POLICY, handleHttp() {} } },
    { staticUi: Object.freeze({ originPolicy: otherPolicy, handleHttp() {} }) },
    { staticUi: Object.freeze({ originPolicy: PHASE_ORIGIN_POLICY }) },
    { audioGateway: {
      originPolicy: PHASE_ORIGIN_POLICY, handleUpgrade() {}, close() {},
    } },
    { audioGateway: Object.freeze({
      originPolicy: otherPolicy, handleUpgrade() {}, close() {},
    }) },
    { audioGateway: Object.freeze({
      originPolicy: PHASE_ORIGIN_POLICY, handleUpgrade() {},
    }) },
    { legacyRoutes: {
      originPolicy: PHASE_ORIGIN_POLICY, handleHttp() {}, handleUpgrade() {}, close() {},
    } },
    { legacyRoutes: Object.freeze({
      originPolicy: otherPolicy, handleHttp() {}, handleUpgrade() {}, close() {},
    }) },
    { legacyRoutes: Object.freeze({
      originPolicy: PHASE_ORIGIN_POLICY, handleHttp() {}, handleUpgrade() {},
    }) },
  ];
  let sideEffects = 0;
  for (const candidate of cases) {
    assert.throws(() => createRuntimeApp({
      runtimeConfig: PHASE_CONFIG,
      releaseInfo,
      originPolicy: PHASE_ORIGIN_POLICY,
      ...candidate,
      createRegistry() {
        sideEffects += 1;
        throw new Error('state must not be created');
      },
      createServer() {
        sideEffects += 1;
        throw new Error('server must not be created');
      },
      scheduleInterval() {
        sideEffects += 1;
        throw new Error('timer must not be created');
      },
    }), /RUNTIME_APP_DEPENDENCIES_INVALID/);
  }
  assert.equal(sideEffects, 0);
});

test('runtime app accepts frozen preconstructed seams bound to its exact policy identity', async () => {
  const { app, calls, fireListen } = createHarness({
    staticUi: frozenStaticUi(),
    audioGateway: frozenAudioGateway(),
    legacyRoutes: frozenLegacyRoutes(),
  });
  const started = app.start();
  fireListen();
  await started;
  assert.equal(calls.serverOptions.staticUi.originPolicy, PHASE_ORIGIN_POLICY);
  assert.equal(calls.serverOptions.originPolicy, PHASE_ORIGIN_POLICY);
  await app.stop();
});

test('import/create 零 timer 零 listen，只在 localhost listen 成功后启动 fixed tick', async () => {
  assert.equal(PHASE_2_SHADOW_SEED, 0x4c4353);
  const { app, calls, fireListen } = createHarness();
  assert.equal(calls.listen, 0);
  assert.equal(calls.timers.length, 0);
  assert.equal(typeof calls.serverOptions.apiHandler, 'function');
  assert.equal(typeof calls.serverOptions.latentRoutes, 'function');
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

test('audio owner expiry failure stays audio-local and does not stop the runtime', async () => {
  const { app, calls, fireListen } = createHarness({
    audioOwnerController: { expire: async () => { throw new Error('AUDIO_WORKER_NOT_READY'); } },
  });
  const started = app.start(); fireListen(); await started;
  calls.timers[0].callback(); await flush(); await flush();
  assert.equal(app.registry.get('default').revision, 1);
  assert.equal(calls.serverClose, 0);
  calls.timers[0].callback(); await flush(); await flush();
  assert.equal(app.registry.get('default').revision, 2);
  await app.stop();
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
    originPolicy: PHASE_ORIGIN_POLICY,
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
    originPolicy: PHASE_ORIGIN_POLICY,
  });
  try {
    await assert.rejects(app.start(), (error) => error.code === 'EADDRINUSE');
    assert.equal(await app.stop(), true);
    assert.equal(await app.stop(), true);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('worker recovery never removes the listening health surface', async () => {
  let stopped = false;
  const app = createRuntimeApp({ runtimeConfig: { ...PHASE_CONFIG, port: 0 }, releaseInfo,
    originPolicy: PHASE_ORIGIN_POLICY,
    scheduleInterval: () => ({ fake: true }), clearScheduledInterval: () => {},
    audioSupervisor: { start: () => new Promise(() => {}), stop: async () => { stopped = true; },
      getStatus: () => ({ workerReady: false, recovering: true }) } });
  assert.equal(await within(app.start()), true);
  assert.notEqual(app.server.address(), null);
  await app.stop();
  assert.equal(stopped, true);
});

test('real localhost app 把 /api/v1/bootstrap 接入权威 session', async () => {
  const app = createRuntimeApp({
    runtimeConfig: { ...PHASE_CONFIG, port: 0 },
    releaseInfo,
    originPolicy: PHASE_ORIGIN_POLICY,
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
    assert.equal(response.body.capabilities.commands.includes('control.take'), true);
    const latentMap = await readJson(port, '/api/v1/latent-maps/melody');
    assert.equal(latentMap.statusCode, 200);
    assert.equal(latentMap.body.voice, 'melody');
    assert.deepEqual(Object.keys(latentMap.body).sort(), [
      'cursor', 'neighbors', 'pcaDimensions', 'pcaRanges', 'points', 'range', 'voice',
    ]);
  } finally {
    await app.stop();
  }
});

test('stop 关闭 active WS，detach 跨过 mailbox barrier 后才 dispose kernel', async () => {
  const app = createRuntimeApp({
    runtimeConfig: { ...PHASE_CONFIG, port: 0 },
    releaseInfo,
    originPolicy: PHASE_ORIGIN_POLICY,
    scheduleInterval: () => ({ fake: true }),
    clearScheduledInterval: () => {},
  });
  await app.start();
  const { port } = app.server.address();
  const bootstrap = (await readBootstrap(port)).body;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/runtime`, {
    origin: PHASE_CONFIG.canonicalOrigin,
    headers: { Host: PHASE_AUTHORITY },
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
