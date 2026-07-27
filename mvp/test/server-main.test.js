import assert from 'node:assert/strict';
import test from 'node:test';

import { createPcmPlayer } from '../src/pcm-player.js';
import { createServerOwnedApp } from '../src/view-app.js';

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
