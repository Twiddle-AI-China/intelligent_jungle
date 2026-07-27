import assert from 'node:assert/strict';
import test from 'node:test';
import { createPcmPlayer } from '../src/pcm-player.js';

const SHA = 'a'.repeat(64);
function audio(blockFrames = 2048, sampleRate = 44100, audioEpoch = 'e') {
  return { audioEpoch, manifestGeometrySha256: SHA, sampleRate, blockFrames, channels: 2,
    format: 'f32le', binaryHeaderVersion: 1, headerBytes: 32 };
}
function runtimeStatus(overrides = {}) { return { statusRevision: 1, runtimeOwner: 'server',
  audioOwner: 'world', workerReady: true, recovering: false, degraded: false,
  degradedReason: null, audio: audio(), ...overrides }; }
function ready(overrides = {}) { return { type: 'audio.ready', protocolVersion: 1,
  streamRevision: 2, blockSeq: 3, resumeStartFrame: '0', ...audio(), ...overrides }; }

class RuntimeClient {
  subscribeStatus(listener) { this.listener = listener; return () => { this.listener = null; }; }
  publish(value) { this.listener?.(value); }
}
class Socket {
  constructor() { this.listeners = {}; this.closed = false; }
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
  emit(name, data) { for (const listener of this.listeners[name] ?? []) listener(data); }
  close() { this.closed = true; }
}
function harness({ addModule = async () => {} } = {}) {
  const runtimeClient = new RuntimeClient(); const sockets = []; const messages = [];
  let contextCalls = 0; let resumeCalls = 0; let contextCloseCalls = 0;
  const player = createPcmPlayer({ runtimeClient,
    webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    audioContextFactory: async ({ sampleRate }) => {
      contextCalls += 1;
      return { sampleRate, audioWorklet: { addModule }, destination: {},
        close() { contextCloseCalls += 1; },
        async resume() { resumeCalls += 1; } };
    }, workletNodeFactory: () => ({ port: { postMessage: (value) => messages.push(value) },
      connect() {}, disconnect() {} }) });
  return { runtimeClient, sockets, messages, player, contextCalls: () => contextCalls,
    resumeCalls: () => resumeCalls, contextCloseCalls: () => contextCloseCalls };
}

test('geometry comes from status and alternate block size sets three-block prime', async () => {
  const h = harness();
  h.runtimeClient.publish(runtimeStatus({ audio: audio(2048) }));
  assert.equal(h.sockets.length, 1);
  h.sockets[0].emit('message', { data: JSON.stringify(ready({ blockFrames: 2048 })) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.player.getStatus().blockFrames, 2048);
  assert.equal(h.player.getStatus().primeFrames, 6144);
  assert.equal(h.contextCalls(), 1);
});

test('ready mismatch closes and clears without creating AudioContext', async () => {
  const h = harness();
  h.runtimeClient.publish(runtimeStatus({ audio: audio(4096, 44100) }));
  h.sockets[0].emit('message', { data: JSON.stringify(ready({ blockFrames: 4096, sampleRate: 48000 })) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.contextCalls(), 0);
  assert.equal(h.player.getStatus().enabled, false);
  assert.equal(h.player.getStatus().lastError, 'AUDIO_READY_GEOMETRY_MISMATCH');
});

test('degraded and worker epoch changes independently close and reopen Audio WS', async () => {
  const h = harness();
  h.runtimeClient.publish(runtimeStatus());
  const first = h.sockets[0];
  h.runtimeClient.publish(runtimeStatus({ statusRevision: 2, degraded: true }));
  assert.equal(first.closed, true);
  h.runtimeClient.publish(runtimeStatus({ statusRevision: 3, audio: audio(2048, 44100, 'e2') }));
  assert.equal(h.sockets.length, 2);
  h.player.destroy();
  assert.equal(h.sockets[1].closed, true);
});

test('Audio WS transport reconnects without waiting for a Runtime WS status change', async () => {
  const h = harness();
  h.runtimeClient.publish(runtimeStatus());
  h.sockets[0].emit('close', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sockets.length, 2);
  assert.equal(h.player.getStatus().state, 'connecting');
});

test('start latches before readiness and resumes the first AudioContext', async () => {
  const h = harness();
  assert.equal(await h.player.start(), true);
  h.runtimeClient.publish(runtimeStatus());
  h.sockets[0].emit('message', { data: JSON.stringify(ready()) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.resumeCalls(), 1);
});

test('ready requires canonical u32 cursors before creating AudioContext', async () => {
  {
    const h = harness();
    h.runtimeClient.publish(runtimeStatus());
    assert.throws(() => h.player.acceptReady(ready({ streamRevision: -0 })),
      /AUDIO_READY_CURSOR_INVALID/);
    assert.equal(h.contextCalls(), 0);
  }
  for (const invalid of [-1, 0x1_0000_0000]) {
    const h = harness();
    h.runtimeClient.publish(runtimeStatus());
    h.sockets[0].emit('message', { data: JSON.stringify(ready({ streamRevision: invalid })) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.contextCalls(), 0);
    assert.equal(h.player.getStatus().lastError, 'AUDIO_READY_CURSOR_INVALID');
  }
});

test('worklet initialization queue is geometry-checked and bounded to ring history', async () => {
  let releaseModule;
  const modulePending = new Promise((resolve) => { releaseModule = resolve; });
  const h = harness({ addModule: () => modulePending });
  h.runtimeClient.publish(runtimeStatus());
  h.sockets[0].emit('message', { data: JSON.stringify(ready()) });
  await new Promise((resolve) => setImmediate(resolve));
  const bytes = 32 + (2048 * 2 * 4);
  const capacity = Math.ceil((3000 * 44100) / (1000 * 2048));
  for (let index = 0; index <= capacity; index += 1) {
    h.sockets[0].emit('message', { data: new ArrayBuffer(bytes) });
  }
  assert.equal(h.player.getStatus().lastError, 'AUDIO_PRIME_OVERFLOW');
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.contextCloseCalls(), 1);
  releaseModule();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sockets.length, 2);
});

test('started intent resumes every AudioContext created after Audio WS reconnect', async () => {
  const h = harness();
  await h.player.start();
  h.runtimeClient.publish(runtimeStatus());
  h.sockets[0].emit('message', { data: JSON.stringify(ready()) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.resumeCalls(), 1);
  h.sockets[0].emit('close', {});
  await new Promise((resolve) => setImmediate(resolve));
  h.sockets[1].emit('message', { data: JSON.stringify(ready()) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.resumeCalls(), 2);
});

test('stop cancels an Audio WS reconnect already queued by close', async () => {
  const h = harness();
  h.runtimeClient.publish(runtimeStatus());
  h.sockets[0].emit('close', {});
  h.player.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sockets.length, 1);
  assert.equal(h.player.getStatus().state, 'disabled');
});
