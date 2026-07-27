import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { createLegacyRoutes } from '../../src/api/legacy-routes.js';
import { createCandidateServer } from '../../src/server.js';
import { createDecoderSessionRegistry } from '../../src/legacy/decoder-session-registry.js';
import { createPcmRing } from '../../src/audio/pcm-ring.js';
import { createSplitRing } from '../../src/audio/split-ring.js';
import { createDecoderAdapter } from '../../src/legacy/decoder-adapter.js';

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timeout: ${label}`);
}

test('legacy route exposes a read-only session, streams master PCM, and gates writes by exact owner', async (context) => {
  const allowedOrigin = 'http://127.0.0.1:4193';
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
  const routes = createLegacyRoutes({ sessionRegistry: sessions, audioOwner: owner,
    planner: { enqueueControl(value) { commands.push(value); return { accepted: true }; } },
    masterRing, splitRing, geometry, allowedOrigin,
    getPublicAudioStatus: () => ({ audioOwner: publishedOwner }) });
  const server = createCandidateServer({ releaseInfo: {}, legacyRoutes: routes });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { await routes.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve)); });
  const unauthorized = new WebSocket(`ws://127.0.0.1:${server.address().port}/decoder`,
    { origin: 'http://evil.invalid' });
  await new Promise((resolve) => { unauthorized.once('error', resolve); unauthorized.once('close', resolve); });
  assert.equal(sessions.list().length, 0);
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/decoder`,
    { origin: allowedOrigin });
  const frames = [];
  socket.on('message', (data, binary) => frames.push(binary ? Buffer.from(data) : JSON.parse(data)));
  const opened = new Promise((resolve) => socket.once('open', resolve));
  const status = await fetch(`http://127.0.0.1:${server.address().port}/api/decoder-status`).then((r) => r.json());
  assert.equal(status.backend, 'backend-owned-runtime');
  assert.equal(status.audioOwner, 'world');
  assert.equal(status.framesPerDecode, 1);
  assert.deepEqual(status.controlSchemes, ['control', 'note']);
  assert.equal(status.models[0].id, 'brave-voices');
  assert.equal(status.models[0].voices.lead.roam.available, true);
  assert.equal(status.models[0].voices.lead.roam.points, 45);
  assert.equal(status.models[0].voices.lead.roam.layout, 'tsne');
  assert.equal(status.models[0].voices.lead.roam.pca.dims, 10);
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/load`)).status, 200);
  assert.match(await fetch(`http://127.0.0.1:${server.address().port}/voice-client.js`).then((r) => r.text()),
    /decoderSessionId/);
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/assets/timbre/voice_maps/lead.json`)).status, 200);
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
  const pendingStatus = await fetch(`http://127.0.0.1:${server.address().port}/api/decoder-status`)
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

  const selfHosted = new WebSocket(`ws://127.0.0.1:${server.address().port}/decoder`,
    { origin: 'http://127.0.0.1:18090' });
  await new Promise((resolve, reject) => {
    selfHosted.once('open', resolve); selfHosted.once('error', reject);
  });
  selfHosted.close();
  await new Promise((resolve) => selfHosted.once('close', resolve));
});

test('adapter construction failure detaches the session and runs owner cleanup', async (context) => {
  const geometry = { sampleRate: 6400, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] };
  const sessions = createDecoderSessionRegistry({ tokenFactory: () => 'broken' });
  const disconnected = [];
  const routes = createLegacyRoutes({ sessionRegistry: sessions,
    audioOwner: { owns: () => false, getStatus: () => ({}),
      decoderDisconnected: async (id) => disconnected.push(id) },
    planner: { enqueueControl: () => ({ accepted: true }) }, masterRing: {}, splitRing: {}, geometry,
    allowedOrigin: 'http://127.0.0.1:4193',
    createAdapter: () => ({ start() { throw new Error('START_FAILED'); }, stop() {} }) });
  const server = createCandidateServer({ releaseInfo: {}, legacyRoutes: routes });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { await routes.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve)); });
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/decoder`,
    { origin: 'http://127.0.0.1:4193' });
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
