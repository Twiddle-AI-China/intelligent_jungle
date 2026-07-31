import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPcmPlayer } from '../src/pcm-player.js';
import { createServerOwnedApp } from '../src/view-app.js';
import * as serverMain from '../src/server-main.js';

test('scene renderer coalesces snapshots and paints smoothly between server frames', () => {
  let now = 0;
  const animationFrames = [];
  const frames = [];
  const renderer = serverMain.createFrameCappedRenderer({
    renderer: { render(snapshot) { frames.push(snapshot); } },
    window: {
      performance: { now: () => now },
      requestAnimationFrame(callback) { animationFrames.push(callback); return animationFrames.length; },
    },
  });

  renderer.render({ revision: 1 });
  renderer.render({ revision: 2 });
  assert.equal(animationFrames.length, 1);
  animationFrames.shift()(0);
  assert.deepEqual(frames, [{ revision: 2 }]);

  now = 10;
  renderer.render({ revision: 3 });
  renderer.render({ revision: 4 });
  animationFrames.shift()(10);
  assert.deepEqual(frames, [{ revision: 2 }]);
  now = 70;
  animationFrames.shift()(70);
  assert.deepEqual(frames, [{ revision: 2 }, { revision: 4 }]);

  const projected = serverMain.projectSnapshotForRender({
    simTime: 8,
    phase: 0.98,
    day: 4,
    dayLength: 10,
    paused: false,
  }, 500);
  assert.equal(projected.simTime, 8.5);
  assert.ok(Math.abs(projected.phase - 0.03) < 1e-12);
  assert.equal(projected.day, 5);
  const paused = { simTime: 8, phase: 0.5, dayLength: 10, paused: true };
  assert.equal(serverMain.projectSnapshotForRender(paused, 500), paused);
});

test('production canvas caps Retina backing resolution', () => {
  const canvas = {
    clientWidth: 1_000,
    clientHeight: 600,
    width: 0,
    height: 0,
    addEventListener() {},
  };
  const document = {
    querySelector(selector) {
      if (selector === '#scene') return canvas;
      return null;
    },
    querySelectorAll() { return []; },
  };
  const renderer = { resizeCalls: 0, resize() { this.resizeCalls += 1; }, render() {}, hitTest() {} };
  const ui = serverMain.createProductionUi({
    document,
    window: { devicePixelRatio: 3, addEventListener() {} },
    runtimeClient: { command: async () => ({ accepted: true }) },
    renderer,
  });
  ui.resize();
  assert.equal(canvas.width, 1_000);
  assert.equal(canvas.height, 600);
  assert.equal(renderer.resizeCalls, 1);
});

test('HTTP origin derives the exact same-origin production endpoints', () => {
  assert.equal(typeof serverMain.deriveRuntimeEndpoints, 'function');
  assert.deepEqual(serverMain.deriveRuntimeEndpoints('http://voice.local:8090'), {
    baseUrl: 'http://voice.local:8090',
    bootstrapUrl: 'http://voice.local:8090/api/v1/bootstrap',
    runtimeWebSocketUrl: 'ws://voice.local:8090/api/v1/runtime',
    audioWebSocketUrl: 'ws://voice.local:8090/api/v1/audio',
    latentMapUrls: {
      bass: 'http://voice.local:8090/api/v1/latent-maps/bass',
      pad: 'http://voice.local:8090/api/v1/latent-maps/pad',
      melody: 'http://voice.local:8090/api/v1/latent-maps/melody',
    },
  });
});

test('HTTPS origin upgrades both production sockets to WSS', () => {
  assert.deepEqual(serverMain.deriveRuntimeEndpoints('https://voice.example.cn:8443'), {
    baseUrl: 'https://voice.example.cn:8443',
    bootstrapUrl: 'https://voice.example.cn:8443/api/v1/bootstrap',
    runtimeWebSocketUrl: 'wss://voice.example.cn:8443/api/v1/runtime',
    audioWebSocketUrl: 'wss://voice.example.cn:8443/api/v1/audio',
    latentMapUrls: {
      bass: 'https://voice.example.cn:8443/api/v1/latent-maps/bass',
      pad: 'https://voice.example.cn:8443/api/v1/latent-maps/pad',
      melody: 'https://voice.example.cn:8443/api/v1/latent-maps/melody',
    },
  });
});

test('runtime endpoint derivation rejects every non-canonical or non-origin input', () => {
  for (const origin of [
    undefined,
    null,
    '',
    'null',
    'ftp://voice.example.cn',
    'HTTP://voice.example.cn',
    'https://VOICE.example.cn',
    'https://voice.example.cn:443',
    'https://voice.example.cn/',
    'https://voice.example.cn/ui',
    'https://voice.example.cn?candidate=1',
    'https://voice.example.cn#candidate',
    'https://user:password@voice.example.cn',
  ]) {
    assert.throws(
      () => serverMain.deriveRuntimeEndpoints(origin),
      { code: 'RUNTIME_ORIGIN_INVALID' },
      String(origin),
    );
  }
});

function transportHarness(origin, {
  baseURI = `${origin}/product/index.html`,
} = {}) {
  const httpTargets = [];
  const webSocketTargets = [];
  const document = { baseURI };
  const window = {
    location: { origin },
    async fetch(input, options) {
      const resolvedUrl = new URL(input, document.baseURI).toString();
      httpTargets.push({ resolvedUrl, options });
      return {
        ok: true,
        async json() { return { resolvedUrl }; },
      };
    },
    WebSocket: class {
      constructor(url) {
        this.url = url;
        webSocketTargets.push(url);
      }
    },
  };
  return { document, window, httpTargets, webSocketTargets };
}

test('used browser transport reaches every derived endpoint over HTTP and HTTPS', async () => {
  for (const origin of ['http://voice.local:8090', 'https://voice.example.cn:8443']) {
    const value = transportHarness(origin);
    assert.equal(typeof serverMain.createBrowserRuntimeTransport, 'function');
    const transport = serverMain.createBrowserRuntimeTransport(value);
    const endpoints = serverMain.deriveRuntimeEndpoints(origin);
    assert.deepEqual(transport.endpoints, endpoints);

    const bootstrapOptions = { cache: 'no-store' };
    await transport.fetchBootstrap(endpoints.bootstrapUrl, bootstrapOptions);
    transport.openRuntimeSocket(endpoints.runtimeWebSocketUrl);
    transport.openAudioSocket('/api/v1/audio');
    for (const voice of ['bass', 'pad', 'melody']) {
      const result = await transport.fetchLatentMap(voice);
      assert.equal(result.resolvedUrl, endpoints.latentMapUrls[voice]);
    }

    assert.deepEqual(value.httpTargets, [
      { resolvedUrl: endpoints.bootstrapUrl, options: bootstrapOptions },
      { resolvedUrl: endpoints.latentMapUrls.bass, options: undefined },
      { resolvedUrl: endpoints.latentMapUrls.pad, options: undefined },
      { resolvedUrl: endpoints.latentMapUrls.melody, options: undefined },
    ]);
    assert.deepEqual(value.webSocketTargets, [
      endpoints.runtimeWebSocketUrl,
      endpoints.audioWebSocketUrl,
    ]);
  }
});

test('used browser transport rejects unknown latent voices and a cross-origin document base', async () => {
  const origin = 'https://voice.example.cn';
  const unknown = transportHarness(origin);
  const unknownTransport = serverMain.createBrowserRuntimeTransport(unknown);
  await assert.rejects(
    unknownTransport.fetchLatentMap('constructor'),
    { code: 'LATENT_MAP_UNAVAILABLE' },
  );
  assert.deepEqual(unknown.httpTargets, []);

  const poisoned = transportHarness(origin, { baseURI: 'https://attacker.invalid/product/' });
  const poisonedTransport = serverMain.createBrowserRuntimeTransport(poisoned);
  await assert.rejects(
    poisonedTransport.fetchBootstrap(poisonedTransport.endpoints.bootstrapUrl),
    { code: 'PRODUCTION_HTTP_TARGET_REJECTED' },
  );
  await assert.rejects(
    poisonedTransport.fetchLatentMap('bass'),
    { code: 'PRODUCTION_HTTP_TARGET_REJECTED' },
  );
  assert.deepEqual(poisoned.httpTargets, []);
});

test('browser production entry has one same-origin endpoint authority and no endpoint override', async () => {
  const source = await readFile(new URL('../src/server-main.js', import.meta.url), 'utf8');
  assert.match(source, /ui\.enter\(\);\s*app\.start\(\)\.catch/);
  assert.equal(
    source.match(/deriveRuntimeEndpoints\(window\.location\.origin\)/g)?.length,
    1,
  );
  for (const forbidden of [
    '127.0.0.1:18090',
    '4193',
    '8081',
    '/decoder',
    'location.search',
    'localStorage',
    'runtime-config',
    'process.env',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

function harness({ owner = 'server', startError = null } = {}) {
  const listeners = new Set();
  const calls = [];
  const runtimeClient = {
    async connect() { calls.push('connect'); },
    disconnect() { calls.push('disconnect'); },
    getStatus() { return { runtimeOwner: owner }; },
    subscribe(listener) { calls.push('bind'); listeners.add(listener);
      return () => { calls.push('unbind'); listeners.delete(listener); }; },
    publish(snapshot) { for (const listener of listeners) listener(snapshot); },
    command() { calls.push('command'); },
  };
  const pcmPlayer = {
    async start() { calls.push('audio.start'); if (startError) throw startError; },
    stop() { calls.push('audio.stop'); },
  };
  const renderer = { frames: [], render(snapshot) { this.frames.push(snapshot); } };
  const ui = { frames: [], render(snapshot) { this.frames.push(snapshot); } };
  return { runtimeClient, pcmPlayer, renderer, ui, calls };
}

test('server owner app renders snapshots without advancing domain', async () => {
  const value = harness();
  const app = createServerOwnedApp(value);
  await app.start();
  const snapshot = Object.freeze({ revision: 7 });
  value.runtimeClient.publish(snapshot);
  assert.deepEqual(value.renderer.frames, [snapshot]);
  assert.deepEqual(value.ui.frames, [snapshot]);
  assert.equal(value.calls.includes('command'), false);
  assert.deepEqual(value.calls.slice(0, 3), ['connect', 'bind', 'audio.start']);
  await app.stop();
  assert.equal(value.calls.filter((call) => call === 'unbind').length, 1);
});

test('owner assertion and audio failure both rollback the whole composition', async () => {
  for (const value of [harness({ owner: 'browser' }), harness({
    startError: Object.assign(new Error('failed'), { code: 'AUDIO_FAILED' }),
  })]) {
    const app = createServerOwnedApp(value);
    await assert.rejects(app.start());
    assert.equal(value.calls.at(-1), 'disconnect');
    assert.equal(value.calls.filter((call) => call === 'audio.stop').length, 1);
    value.runtimeClient.publish({ revision: 8 });
    assert.equal(value.renderer.frames.length, 0);
  }
});

test('concurrent start and repeated stop are idempotent at the subscription boundary', async () => {
  const value = harness();
  const app = createServerOwnedApp(value);
  await Promise.all([app.start(), app.start()]);
  assert.equal(value.calls.filter((call) => call === 'connect').length, 1);
  assert.equal(value.calls.filter((call) => call === 'bind').length, 1);
  await app.stop();
  await app.stop();
  assert.equal(value.calls.filter((call) => call === 'unbind').length, 1);
});

test('real PCM player cannot open audio before the server owner assertion', async () => {
  let statusListener = null;
  const sockets = [];
  const runtimeClient = {
    subscribeStatus(listener) { statusListener = listener; return () => { statusListener = null; }; },
    subscribe() { return () => {}; },
    async connect() {
      statusListener({ runtimeOwner: 'browser', audioOwner: 'world', workerReady: true,
        recovering: false, degraded: false, audio: { audioEpoch: 'e',
          manifestGeometrySha256: 'a'.repeat(64), sampleRate: 44100, blockFrames: 64,
          channels: 2, format: 'f32le', binaryHeaderVersion: 1, headerBytes: 32 } });
    },
    disconnect() {},
    getStatus() { return { runtimeOwner: 'browser' }; },
  };
  const pcmPlayer = createPcmPlayer({ runtimeClient,
    audioContextFactory: async () => { throw new Error('AUDIO_CONTEXT_MUST_NOT_START'); },
    webSocketFactory: (url) => { sockets.push(url); throw new Error('AUDIO_WS_MUST_NOT_START'); },
  });
  const app = createServerOwnedApp({ runtimeClient, pcmPlayer,
    renderer: { render() {} }, ui: { render() {} } });
  await assert.rejects(app.start(), /SERVER_OWNER_TUPLE_NOT_READY/);
  assert.deepEqual(sockets, []);
  pcmPlayer.destroy();
});
