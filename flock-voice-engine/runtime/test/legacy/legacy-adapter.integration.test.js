import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { createLegacyRoutes } from '../../src/api/legacy-routes.js';
import { createOriginPolicy } from '../../src/api/origin-policy.js';
import { createCandidateServer } from '../../src/server.js';
import { createDecoderSessionRegistry } from '../../src/legacy/decoder-session-registry.js';
import { createPcmRing } from '../../src/audio/pcm-ring.js';
import { createSplitRing } from '../../src/audio/split-ring.js';
import { createDecoderAdapter } from '../../src/legacy/decoder-adapter.js';

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

function browserFetchOptions(canonicalOrigin, method = 'GET') {
  return {
    method,
    headers: {
      Origin: canonicalOrigin,
    },
  };
}

function deferredOriginPolicy() {
  let delegate = null;
  return Object.freeze({
    authorize(...args) {
      if (delegate === null) throw new Error('TEST_ORIGIN_POLICY_NOT_READY');
      return delegate.authorize(...args);
    },
    setCanonicalOrigin(canonicalOrigin) {
      delegate = createOriginPolicy({ canonicalOrigin });
    },
  });
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timeout: ${label}`);
}

test('legacy HTTP and WS deny before upgrade, owner state, or request body access', () => {
  const webSocketServer = new EventEmitter();
  let upgradeCalls = 0; let ownerStatusCalls = 0; let publicStatusCalls = 0;
  let policyCalls = 0;
  const exactOriginPolicy = originPolicy();
  const countingPolicy = {
    authorize(...args) {
      policyCalls += 1;
      return exactOriginPolicy.authorize(...args);
    },
  };
  webSocketServer.handleUpgrade = () => { upgradeCalls += 1; };
  const routes = createLegacyRoutes({
    sessionRegistry: {},
    audioOwner: {
      getStatus() {
        ownerStatusCalls += 1;
        return { audioOwner: 'world' };
      },
    },
    planner: {},
    masterRing: {},
    splitRing: {},
    geometry: { sampleRate: 6400, blockFrames: 64, poolSize: 1, rowVoices: ['unknown'] },
    originPolicy: countingPolicy,
    getPublicAudioStatus() {
      publicStatusCalls += 1;
      return { audioOwner: 'world' };
    },
    webSocketServer,
  });
  assert.equal(Object.isFrozen(routes), true);
  assert.equal(routes.originPolicy, countingPolicy);
  const rejected = [
    rawHeaders({ origin: undefined }),
    rawHeaders({ origin: 'null' }),
    rawHeaders({ host: 'localhost:18090' }),
    rawHeaders({ extra: ['Origin', CANONICAL_ORIGIN] }),
    rawHeaders({ extra: ['Forwarded', `host=${CANONICAL_AUTHORITY}`] }),
    rawHeaders({ extra: ['X-Forwarded-For', '127.0.0.1'] }),
  ];

  for (const candidate of rejected) {
    const upgradeResponses = [];
    const upgradeSocket = { end: (value) => upgradeResponses.push(String(value)) };
    assert.equal(routes.handleUpgrade({
      url: '/decoder',
      rawHeaders: candidate,
      headers: { host: CANONICAL_AUTHORITY, origin: CANONICAL_ORIGIN },
    }, upgradeSocket, Buffer.alloc(0)), true);
    assert.equal(upgradeResponses.length, 1);
    assert.match(upgradeResponses[0],
      /^HTTP\/1\.1 (?:400 Bad Request|403 Forbidden|421 Misdirected Request)\r\n/);
    assert.doesNotMatch(upgradeResponses[0], /101 Switching Protocols/);

    for (const [method, url] of [
      ['GET', '/api/decoder-status'],
      ['GET', '/api/load'],
      ['POST', '/api/load'],
    ]) {
      const request = new EventEmitter();
      Object.assign(request, {
        method,
        url,
        rawHeaders: candidate,
        headers: { host: CANONICAL_AUTHORITY, origin: CANONICAL_ORIGIN },
      });
      const writes = []; const bodies = [];
      const response = {
        writeHead: (...args) => writes.push(args),
        end: (body) => bodies.push(body),
      };
      assert.equal(routes.handleHttp(request, response), true);
      assert.equal(writes.length, 1);
      assert.match(String(bodies[0]), /^{"error":"ORIGIN_POLICY_/);
      assert.equal(request.listenerCount('data'), 0);
      assert.equal(request.listenerCount('end'), 0);
    }
  }
  assert.equal(upgradeCalls, 0);
  assert.equal(ownerStatusCalls, 0);
  assert.equal(publicStatusCalls, 0);

  const policyCallsBeforeAliases = policyCalls;
  for (const url of [
    '/not-decoder',
    '/decoder/',
    '/decoder?split=0',
    '/decoder?split=true',
    '/decoder?model=brave-voices',
    '/decoder?split=1&model=brave-voices',
    '//evil.example/decoder',
    'http://evil.example/decoder',
    '/de%63oder',
    '/decoder\\child',
    '/decoder#fragment',
    `/decoder${String.fromCharCode(0)}`,
  ]) {
    const wrongUpgrade = { destroyCalls: 0, destroy() { this.destroyCalls += 1; } };
    assert.equal(routes.handleUpgrade({
      url,
      rawHeaders: rawHeaders(),
    }, wrongUpgrade, Buffer.alloc(0)), false, url);
    assert.equal(wrongUpgrade.destroyCalls, 0, url);
  }
  for (const url of [
    '/api/decoder-status?debug=1',
    '//evil.example/api/decoder-status',
    'http://evil.example/api/decoder-status',
    '/api/%64ecoder-status',
    '/api/decoder-status\\child',
    '/api/load?debug=1',
    '//evil.example/api/load',
    'http://evil.example/api/load',
    '/api/%6coad',
    '/api/load\\child',
  ]) {
    const request = { method: 'GET', url, rawHeaders: rawHeaders() };
    assert.equal(routes.handleHttp(request, {
      writeHead() {
        throw new Error('raw target alias must not write a response');
      },
      end() {
        throw new Error('raw target alias must not write a body');
      },
    }), false, url);
  }
  assert.equal(policyCalls, policyCallsBeforeAliases);
  assert.equal(upgradeCalls, 0);

  const splitSocket = {};
  assert.equal(routes.handleUpgrade({
    url: '/decoder?split=1',
    rawHeaders: rawHeaders(),
  }, splitSocket, Buffer.alloc(0)), true);
  assert.equal(upgradeCalls, 1);
  assert.equal(policyCalls, policyCallsBeforeAliases + 1);
});

test('legacy route exposes a read-only session, streams master PCM, and gates writes by exact owner', async (context) => {
  const geometry = { sampleRate: 6400, blockFrames: 64, poolSize: 5,
    rowVoices: ['bass', 'pad', 'lead', 'pluck', 'pad'] };
  const masterRing = createPcmRing(geometry); masterRing.beginStream({ audioEpoch: 'e', minStartFrame: 0n });
  const splitRing = createSplitRing({ geometry });
  let exactOwner = null; let publishedOwner = 'world'; const commands = []; const disconnected = [];
  const owner = { owns: (id) => id === exactOwner,
    decoderDisconnected: async (id) => disconnected.push(id),
    getStatus: () => ({ audioOwner: exactOwner ? 'legacy' : 'world',
      decoderSessionId: exactOwner, expiresAt: null }) };
  const sessions = createDecoderSessionRegistry({ tokenFactory: () => 'session-a' });
  const liveOriginPolicy = deferredOriginPolicy();
  const routes = createLegacyRoutes({ sessionRegistry: sessions, audioOwner: owner,
    planner: { enqueueControl(value) { commands.push(value); return { accepted: true }; } },
    masterRing, splitRing, geometry, originPolicy: liveOriginPolicy,
    getPublicAudioStatus: () => ({ audioOwner: publishedOwner }) });
  const server = createCandidateServer({ releaseInfo: {}, legacyRoutes: routes });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const liveOrigin = `http://127.0.0.1:${server.address().port}`;
  liveOriginPolicy.setCanonicalOrigin(liveOrigin);
  context.after(async () => { await routes.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve)); });
  const unauthorized = new WebSocket(`ws://127.0.0.1:${server.address().port}/decoder`,
    { origin: 'http://evil.invalid' });
  await new Promise((resolve) => { unauthorized.once('error', resolve); unauthorized.once('close', resolve); });
  assert.equal(sessions.list().length, 0);
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/decoder`,
    { origin: liveOrigin });
  const frames = [];
  socket.on('message', (data, binary) => frames.push(binary ? Buffer.from(data) : JSON.parse(data)));
  const opened = new Promise((resolve) => socket.once('open', resolve));
  const status = await fetch(
    `http://127.0.0.1:${server.address().port}/api/decoder-status`,
    browserFetchOptions(liveOrigin),
  ).then((r) => r.json());
  assert.equal(status.backend, 'backend-owned-runtime');
  assert.equal(status.audioOwner, 'world');
  assert.equal(status.framesPerDecode, 1);
  assert.deepEqual(status.controlSchemes, ['control', 'note']);
  assert.equal(status.models[0].id, 'brave-voices');
  assert.equal(status.models[0].voices.lead.roam.available, true);
  assert.equal(status.models[0].voices.lead.roam.points, 45);
  assert.equal(status.models[0].voices.lead.roam.layout, 'tsne');
  assert.equal(status.models[0].voices.lead.roam.pca.dims, 10);
  assert.equal((await fetch(
    `http://127.0.0.1:${server.address().port}/api/load`,
    browserFetchOptions(liveOrigin),
  )).status, 200);
  assert.equal((await fetch(
    `http://127.0.0.1:${server.address().port}/api/load`,
    browserFetchOptions(liveOrigin, 'POST'),
  )).status, 200);
  for (const path of ['/', '/demo.html', '/tracks.html', '/voice-client.js',
    '/voice-client-production.js', '/pcm-player-worklet.js',
    '/assets/timbre/latent_map.json',
    '/assets/timbre/voice_maps/lead.json']) {
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${path}`)).status,
      404, path);
  }
  await opened;
  await waitFor(() => frames.some((frame) => frame.type === 'ready'), 'legacy ready');
  const ready = frames.find((frame) => frame.type === 'ready');
  assert.equal(ready.samplesPerFrame, 64);
  assert.equal(ready.framesPerDecode, 1);
  assert.equal(ready.trackCount, 1);
  assert.equal(ready.splitSupported, true);
  const session = frames.find((frame) => frame.type === 'legacy.session');
  socket.send(JSON.stringify({ type: 'note', voice: 0, midi: 60, velocity: .5, durationSeconds: 1 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commands.length, 0);
  exactOwner = session.decoderSessionId;
  const pendingStatus = await fetch(
    `http://127.0.0.1:${server.address().port}/api/decoder-status`,
    browserFetchOptions(liveOrigin),
  )
    .then((response) => response.json());
  assert.equal(pendingStatus.audioOwner, 'world');
  assert.equal(pendingStatus.decoderSessionId, null);
  publishedOwner = 'legacy';
  socket.send(JSON.stringify({ type: 'note', voice: 0, midi: 60, velocity: .5, durationSeconds: 1 }));
  masterRing.publish({ startFrame: 0n, frameCount: 64, channels: 2, format: 1,
    payload: Buffer.alloc(512, 3) });
  await waitFor(() => frames.some(Buffer.isBuffer), 'legacy binary');
  await waitFor(() => commands.length >= 1 || socket.readyState !== WebSocket.OPEN, 'legacy command');
  assert.equal(commands.at(-1)?.[0]?.type, 'note.on', JSON.stringify(frames.filter((x) => !Buffer.isBuffer(x))));
  socket.send(JSON.stringify({ type: 'note', voice: 0, midi: 60, velocity: .5, durationSeconds: 1,
    gain: .7, timbre: 3, timbreXY: [.2, -.3], timbreK: 4, timbrePCA: null }));
  socket.send(JSON.stringify({ type: 'control', voices: [{ voice: 0, midi: 62, velocity: .8,
    gate: true, timbre: 2, timbreXY: null }] }));
  socket.send(JSON.stringify({ type: 'noteOff', voice: 0 }));
  await waitFor(() => commands.length >= 4, 'legacy compatibility commands');
  assert.deepEqual(commands.at(-3).map((value) => value.type),
    ['continuous.set', 'latent.set', 'latent.set', 'latent.set', 'latent.set', 'note.on']);
  assert.deepEqual(commands.at(-2).map((value) => value.type),
    ['latent.set', 'latent.set', 'gate.on']);
  assert.deepEqual(commands.at(-1), [{ type: 'note.off', row: 0 }]);
  assert.equal(frames.find(Buffer.isBuffer).length, 512);
  socket.close();
  await new Promise((resolve) => socket.once('close', resolve));
  await waitFor(() => disconnected.length === 1, 'decoder cleanup');
  assert.deepEqual(disconnected, [session.decoderSessionId]);

  const obsoleteUiOrigin = new WebSocket(`ws://127.0.0.1:${server.address().port}/decoder`,
    { origin: 'http://127.0.0.1:4193' });
  const obsoleteStatus = await new Promise((resolve, reject) => {
    obsoleteUiOrigin.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    obsoleteUiOrigin.once('open', () => reject(new Error('obsolete UI origin reached 101')));
    obsoleteUiOrigin.once('error', () => undefined);
  });
  assert.equal(obsoleteStatus, 403);
});

test('adapter construction failure detaches the session and runs owner cleanup', async (context) => {
  const geometry = { sampleRate: 6400, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] };
  const sessions = createDecoderSessionRegistry({ tokenFactory: () => 'broken' });
  const disconnected = [];
  const liveOriginPolicy = deferredOriginPolicy();
  const routes = createLegacyRoutes({ sessionRegistry: sessions,
    audioOwner: { owns: () => false, getStatus: () => ({}),
      decoderDisconnected: async (id) => disconnected.push(id) },
    planner: { enqueueControl: () => ({ accepted: true }) }, masterRing: {}, splitRing: {}, geometry,
    originPolicy: liveOriginPolicy,
    createAdapter: () => ({ start() { throw new Error('START_FAILED'); }, stop() {} }) });
  const server = createCandidateServer({ releaseInfo: {}, legacyRoutes: routes });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const liveOrigin = `http://127.0.0.1:${server.address().port}`;
  liveOriginPolicy.setCanonicalOrigin(liveOrigin);
  context.after(async () => { await routes.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve)); });
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/decoder`,
    { origin: liveOrigin });
  await new Promise((resolve) => { socket.once('error', resolve); socket.once('close', resolve); });
  await waitFor(() => disconnected.length === 1, 'failed attach cleanup');
  assert.equal(sessions.list().length, 0);
});

test('split adapter emits raw pre-mix PCM with the advertised channel count', () => {
  const geometry = { sampleRate: 6400, blockFrames: 64, poolSize: 3 };
  const splitRing = createSplitRing({ geometry });
  const sent = [];
  const socket = { send(data, options, done) { sent.push({ data, binary: options.binary }); done(); } };
  const adapter = createDecoderAdapter({ socket,
    session: { decoderSessionId: 'decoder-split', split: true },
    audioOwner: { owns: () => false }, planner: { enqueueControl: () => ({ accepted: true }) },
    masterRing: {}, splitRing, geometry });
  adapter.start();
  const payload = Buffer.alloc(64 * 3 * 4, 9);
  splitRing.publish({ startFrame: 0n, frameCount: 64, channels: 3, format: 1, payload });
  const ready = sent.filter((entry) => !entry.binary).map((entry) => JSON.parse(entry.data))
    .find((entry) => entry.type === 'ready');
  assert.equal(ready.channels, 3);
  assert.equal(ready.split, true);
  assert.equal(ready.trackCount, 3);
  assert.deepEqual(sent.find((entry) => entry.binary).data, payload);
  adapter.stop();
});

test('slow legacy egress is bounded and closes instead of dropping PCM silently', () => {
  const geometry = { sampleRate: 6400, blockFrames: 64, poolSize: 2 };
  const splitRing = createSplitRing({ geometry });
  const callbacks = []; const closed = [];
  const socket = { send(_data, _options, done) { callbacks.push(done); },
    close(code, reason) { closed.push([code, reason]); } };
  const adapter = createDecoderAdapter({ socket, egressMs: 10,
    session: { decoderSessionId: 'decoder-slow', split: true },
    audioOwner: { owns: () => false }, planner: { enqueueControl: () => ({ accepted: true }) },
    masterRing: {}, splitRing, geometry });
  adapter.start();
  callbacks.shift()(); callbacks.shift()();
  const block = (startFrame) => ({ startFrame, frameCount: 64, channels: 2, format: 1,
    payload: Buffer.alloc(512) });
  splitRing.publish(block(0n));
  splitRing.publish(block(64n));
  assert.deepEqual(closed, [[1011, 'LEGACY_EGRESS_OVERFLOW']]);
  assert.equal(adapter.getStatus().stopped, true);
});
