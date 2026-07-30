import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { createAudioWsGateway } from '../../src/api/audio-ws.js';
import { createOriginPolicy } from '../../src/api/origin-policy.js';
import { createPcmRing } from '../../src/audio/pcm-ring.js';
import { createCandidateServer } from '../../src/server.js';

const CANONICAL_ORIGIN = 'http://127.0.0.1:18090';
const CANONICAL_AUTHORITY = '127.0.0.1:18090';

function originPolicy() {
  return createOriginPolicy({ canonicalOrigin: CANONICAL_ORIGIN });
}

function rawHeaders(options = {}) {
  const host = options.host ?? CANONICAL_AUTHORITY;
  const origin = Object.hasOwn(options, 'origin') ? options.origin : CANONICAL_ORIGIN;
  const extra = options.extra ?? [];
  const result = ['Host', host];
  if (origin !== undefined) result.push('Origin', origin);
  return [...result, ...extra];
}

const audio = { audioEpoch: 'epoch-real', manifestGeometrySha256: 'a'.repeat(64),
  sampleRate: 6400, blockFrames: 64, channels: 2, format: 'f32le',
  binaryHeaderVersion: 1, headerBytes: 32 };

test('Audio WS rejects malformed, forwarded, and non-exact requests before any upgrade or audio state', () => {
  const webSocketServer = new EventEmitter();
  let upgradeCalls = 0; let readyCalls = 0; let writerCalls = 0; let policyCalls = 0;
  const exactOriginPolicy = originPolicy();
  const countingPolicy = {
    authorize(...args) {
      policyCalls += 1;
      return exactOriginPolicy.authorize(...args);
    },
  };
  webSocketServer.handleUpgrade = () => { upgradeCalls += 1; };
  const gateway = createAudioWsGateway({
    ring: {},
    originPolicy: countingPolicy,
    getAudioReady: () => { readyCalls += 1; return audio; },
    createWriter: () => { writerCalls += 1; return { start() {}, stop() {} }; },
    webSocketServer,
  });
  assert.equal(Object.isFrozen(gateway), true);
  assert.equal(gateway.originPolicy, countingPolicy);
  const rejected = [
    rawHeaders({ origin: undefined }),
    rawHeaders({ origin: 'null' }),
    rawHeaders({ origin: 'https://127.0.0.1:18090' }),
    rawHeaders({ origin: 'http://127.0.0.1:8090' }),
    rawHeaders({ host: 'localhost:18090' }),
    rawHeaders({ extra: ['Origin', CANONICAL_ORIGIN] }),
    rawHeaders({ extra: ['Forwarded', `host=${CANONICAL_AUTHORITY}`] }),
    rawHeaders({ extra: ['X-Forwarded-Proto', 'http'] }),
  ];
  for (const candidate of rejected) {
    const ended = [];
    const socket = {
      end: (value) => ended.push(String(value)),
      destroy() {
        throw new Error('policy denial must use the fixed HTTP writer');
      },
    };
    const handled = gateway.handleUpgrade({
      url: '/api/v1/audio',
      rawHeaders: candidate,
      headers: { host: CANONICAL_AUTHORITY, origin: CANONICAL_ORIGIN },
    }, socket, Buffer.alloc(0));
    assert.equal(handled, true);
    assert.equal(ended.length, 1);
    assert.match(ended[0], /^HTTP\/1\.1 (?:400 Bad Request|403 Forbidden|421 Misdirected Request)\r\n/);
    assert.match(ended[0], /\r\nCache-Control: no-store\r\n/i);
    assert.doesNotMatch(ended[0], /101 Switching Protocols/);
  }
  assert.equal(upgradeCalls, 0);
  assert.equal(readyCalls, 0);
  assert.equal(writerCalls, 0);

  const policyCallsBeforeAliases = policyCalls;
  for (const url of [
    '/api/v1/not-audio',
    '/api/v1/audio/',
    '/api/v1/audio?debug=1',
    '//evil.example/api/v1/audio',
    'http://evil.example/api/v1/audio',
    '/api/v1/%61udio',
    '/api/v1\\audio',
    '/api/v1/audio#fragment',
    `/api/v1/audio${String.fromCharCode(0)}`,
  ]) {
    const wrongPath = { destroyCalls: 0, destroy() { this.destroyCalls += 1; } };
    assert.equal(gateway.handleUpgrade({
      url,
      rawHeaders: rawHeaders(),
    }, wrongPath, Buffer.alloc(0)), false, url);
    assert.equal(wrongPath.destroyCalls, 1, url);
  }
  assert.equal(policyCalls, policyCallsBeforeAliases);
  assert.equal(upgradeCalls, 0);
});

test('real Audio WS sends ready before an exactly matching first binary cursor', async () => {
  const ring = createPcmRing({ sampleRate: 6400, blockFrames: 64 });
  ring.beginStream({ audioEpoch: audio.audioEpoch, minStartFrame: 0n });
  ring.publish({ startFrame: 0n, frameCount: 64, channels: 2, format: 1,
    payload: Buffer.alloc(64 * 2 * 4) });
  const gateway = createAudioWsGateway({ ring, originPolicy: originPolicy(),
    getAudioReady: () => audio });
  const server = createCandidateServer({ releaseInfo: {}, audioUpgradeHandler: gateway.handleUpgrade });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/audio`, {
    origin: CANONICAL_ORIGIN,
    headers: { Host: CANONICAL_AUTHORITY },
  });
  const frames = [];
  await new Promise((resolve, reject) => {
    socket.on('message', (data, binary) => {
      frames.push(binary ? Buffer.from(data) : JSON.parse(data.toString()));
      if (frames.length === 2) resolve();
    });
    socket.on('error', reject);
  });
  assert.equal(frames[0].type, 'audio.ready');
  assert.equal(frames[0].resumeStartFrame, frames[1].readBigUInt64LE(16).toString());
  assert.equal(frames[0].blockSeq, frames[1].readUInt32LE(12));
  socket.close();
  await gateway.close();
  await new Promise((resolve) => server.close(resolve));
});

test('fault audio upgrade requires the audio grant and issues next generation on close', () => {
  const webSocketServer = new EventEmitter();
  const client = new EventEmitter();
  client.close = () => {};
  const calls = [];
  webSocketServer.clients = new Set();
  webSocketServer.handleUpgrade = (_request, _socket, _head, callback) => {
    callback(client);
  };
  const registry = {
    claim(value) {
      calls.push(['claim', value]);
      if (value.socketKind !== 'audio' || value.capability !== 'audio-cap') {
        throw new Error('CAPABILITY_INVALID');
      }
      return {
        client: 4,
        clientIdentitySha256: '4'.repeat(64),
        socketKind: 'audio',
        generation: 1,
      };
    },
    close(value) {
      calls.push(['close', value]);
      return { ...value, generation: 2, capability: 'next-audio-cap' };
    },
  };
  const reconnects = [];
  const gateway = createAudioWsGateway({
    ring: {},
    originPolicy: { authorize: () => ({ allowed: true }) },
    getAudioReady: () => audio,
    createWriter: () => ({ start() { calls.push(['start']); }, stop() {} }),
    webSocketServer,
    faultClientRegistry: registry,
    onFaultReconnectGrant: (grant) => reconnects.push(grant),
  });
  const missing = { destroyCalls: 0, destroy() { this.destroyCalls += 1; } };
  assert.equal(gateway.handleUpgrade({
    url: '/api/v1/audio',
    headers: {},
  }, missing, Buffer.alloc(0)), true);
  assert.equal(missing.destroyCalls, 1);

  assert.equal(gateway.handleUpgrade({
    url: '/api/v1/audio',
    headers: { 'x-flock-phase5-client-capability': 'audio-cap' },
  }, { destroy() {} }, Buffer.alloc(0)), true);
  client.emit('close');
  assert.deepEqual(calls, [
    ['claim', { socketKind: 'audio', capability: 'audio-cap' }],
    ['start'],
    ['close', { client: 4, socketKind: 'audio', generation: 1 }],
  ]);
  assert.equal(reconnects[0].generation, 2);
});
