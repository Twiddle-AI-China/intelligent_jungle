import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createUnixServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

import { createAudioWsGateway } from '../../src/api/audio-ws.js';
import { createLegacyRoutes } from '../../src/api/legacy-routes.js';
import { createPrimingMasterPcmPublisher } from '../../src/audio/priming-master-pcm-publisher.js';
import { createPublicAudioStatusStore } from '../../src/audio/public-audio-status.js';
import { createPcmRing } from '../../src/audio/pcm-ring.js';
import { createSplitRing } from '../../src/audio/split-ring.js';
import { createUnixWorkerConnection } from '../../src/audio/worker-protocol.js';
import { createWorkerSupervisor } from '../../src/audio/worker-supervisor.js';
import { PHASE_CONFIG } from '../../src/config.js';
import { createDecoderSessionRegistry } from '../../src/legacy/decoder-session-registry.js';
import { createRuntimeApp } from '../../src/runtime-app.js';

const WORKER_GEOMETRY = Object.freeze({ sampleRate: 6400, blockFrames: 64, poolSize: 1,
  rowVoices: ['bass'] });
const GEOMETRY = Object.freeze({ audioEpoch: 'phase5-local',
  manifestGeometrySha256: 'a'.repeat(64), sampleRate: 6400, blockFrames: 64,
  channels: 2, format: 'f32le', binaryHeaderVersion: 1, headerBytes: 32 });
const WORKER_IDENTITY = Object.freeze({ releaseRevision: 'phase5-local',
  sourceManifestSha256: 'b'.repeat(64), protocolFamily: 'flock-audio-uds', protocolVersion: 1,
  audioArtifactKind: 'checkpoint', audioArtifactSha256: 'c'.repeat(64) });
const RELEASE = Object.freeze({ releaseRevision: 'phase5-local',
  sourceManifestSha256: 'b'.repeat(64), runtimeOwner: 'server', audioOwner: 'world',
  workerIdentity: WORKER_IDENTITY, geometry: WORKER_GEOMETRY,
  manifestGeometrySha256: GEOMETRY.manifestGeometrySha256 });

async function withTimeout(promise, code, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function jsonFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(5 + body.length);
  frame.writeUInt32BE(body.length, 0); frame[4] = 1; body.copy(frame, 5);
  return frame;
}

function pcmFrame(startFrame) {
  const payload = Buffer.alloc(WORKER_GEOMETRY.blockFrames * 2 * 4);
  const body = Buffer.alloc(16 + payload.length);
  body.writeBigUInt64LE(startFrame, 0);
  body.writeUInt32LE(WORKER_GEOMETRY.blockFrames, 8);
  body.writeUInt16LE(2, 12); body.writeUInt16LE(1, 14); payload.copy(body, 16);
  const frame = Buffer.alloc(5 + body.length);
  frame.writeUInt32BE(body.length, 0); frame[4] = 2; body.copy(frame, 5);
  return frame;
}

async function startFakeUdsWorker(socketPath) {
  let connections = 0;
  let replacements = 0;
  const timers = new Set();
  const sockets = new Set();
  const server = createUnixServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    connections += 1;
    let input = Buffer.alloc(0);
    socket.write(jsonFrame({ type: 'worker.hello', identity: WORKER_IDENTITY }));
    socket.write(jsonFrame({ type: 'worker.ready', audioEpoch: GEOMETRY.audioEpoch,
      renderFrame: '0', geometry: WORKER_GEOMETRY }));
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 5 && input.length >= 5 + input.readUInt32BE(0)) {
        const length = input.readUInt32BE(0);
        const value = JSON.parse(input.subarray(5, 5 + length).toString('utf8'));
        input = input.subarray(5 + length);
        if (value.type !== 'audio.command.batch') continue;
        replacements += 1;
        socket.write(jsonFrame({ type: 'audio.state.applied', audioEpoch: GEOMETRY.audioEpoch,
          stateRevision: value.commands[0].value.stateRevision,
          appliedCommandSeq: value.commandSeq, renderFrame: '0' }));
        if (replacements === 2) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!socket.destroyed) socket.write(pcmFrame(0n));
          }, 25);
          timers.add(timer);
        }
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return { server, get connections() { return connections; },
    get replacements() { return replacements; },
    clearTimers() { for (const timer of timers) clearTimeout(timer); timers.clear(); },
    closeConnections() { for (const socket of sockets) socket.destroy(); sockets.clear(); } };
}

function createPlanner() {
  let transport = () => ({ accepted: false });
  let commandSeq = 0;
  let audioEpoch = null;
  return Object.freeze({
    accept: () => ({ accepted: true, deferred: true }),
    pauseWorldWrites() {},
    bindTransport(next) { transport = next; },
    bindEpoch(value) { audioEpoch = value; commandSeq = 0; },
    bindGeometry() {}, replaceFrameMap() {},
    replace(value) {
      commandSeq += 1;
      const result = transport({ type: 'audio.command.batch', audioEpoch, commandSeq,
        targetFrame: '0', commands: [{ type: 'state.replace', value }] });
      return { ...result, commandSeq };
    },
    replaceCurrentAndBufferFollowing() {
      const value = { stateRevision: 1, frameMap: { worldTimeSeconds: 0 } };
      return { ...this.replace(value), stateRevision: value.stateRevision };
    },
    resumeWorldWrites: () => ({ accepted: true }),
    enqueueControl: () => ({ accepted: false, reason: 'LEGACY_LEASE_REQUIRED' }),
    getStatus: () => ({ audioEpoch, degraded: false }),
  });
}

async function bootstrap(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
    headers: { origin: PHASE_CONFIG.allowedOrigin },
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function runtimeSocket(port) {
  const state = await bootstrap(port);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/runtime`, {
    origin: PHASE_CONFIG.allowedOrigin,
  });
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(2000) });
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientId: state.clientId,
      bootstrapToken: state.bootstrapToken, worldGeneration: state.worldGeneration,
      lastRevision: state.revision, lastEventSeq: state.eventSeq }));
    const frames = [];
    await withTimeout(new Promise((resolve, reject) => {
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString('utf8')); frames.push(frame);
        if (frame.type === 'ready') resolve();
      });
      socket.on('error', reject);
    }), 'RUNTIME_WS_READY_TIMEOUT');
    return { socket, state, frames };
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

async function audioSocket(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/audio`, {
    origin: PHASE_CONFIG.allowedOrigin,
  });
  try {
    const frames = [];
    await withTimeout(new Promise((resolve, reject) => {
      socket.on('message', (data, binary) => {
        frames.push(binary ? Buffer.from(data) : JSON.parse(data.toString('utf8')));
        if (frames.length === 2) resolve();
      });
      socket.on('error', reject);
    }), 'AUDIO_WS_READY_TIMEOUT');
    return { socket, frames };
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

async function openSockets(factory, count, sockets) {
  const results = await Promise.allSettled(Array.from({ length: count }, () => factory()));
  for (const result of results) {
    if (result.status === 'fulfilled') sockets.push(result.value.socket);
  }
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map((result) => result.value);
}

function localWorkerEndpoint(temporary) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${basename(temporary)}-audio`
    : join(temporary, 'audio.sock');
}

test('phase5 localhost owns one world, one worker, and one PCM master timeline', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'flock-phase5-uds-'));
  let worker = null;
  let app = null;
  const sockets = [];
  t.after(async () => {
    let firstError = null;
    const cleanup = async (operation) => {
      try { await operation(); } catch (error) { firstError ??= error; }
    };
    await cleanup(async () => { for (const socket of sockets) socket.terminate(); });
    if (app) await cleanup(() => withTimeout(app.stop(), 'RUNTIME_APP_STOP_TIMEOUT'));
    if (worker) {
      await cleanup(async () => { worker.clearTimers(); worker.closeConnections(); });
      if (worker.server.listening) await cleanup(() => withTimeout(new Promise((resolve, reject) => {
        worker.server.close((error) => error ? reject(error) : resolve());
      }), 'FAKE_UDS_CLOSE_TIMEOUT'));
    }
    await cleanup(() => rm(temporary, { recursive: true, force: true }));
    if (firstError) throw firstError;
  });
  const socketPath = localWorkerEndpoint(temporary);
  worker = await startFakeUdsWorker(socketPath);
  const ring = createPcmRing({ sampleRate: GEOMETRY.sampleRate,
    blockFrames: GEOMETRY.blockFrames });
  const splitRing = createSplitRing({ geometry: WORKER_GEOMETRY });
  const publisher = createPrimingMasterPcmPublisher({ downstream: ring });
  const status = createPublicAudioStatusStore();
  const audioGateway = createAudioWsGateway({ ring, allowedOrigin: PHASE_CONFIG.allowedOrigin,
    getAudioReady: () => status.get().audio });
  const planner = createPlanner();
  const supervisor = createWorkerSupervisor({
    connector: { connect: () => createUnixWorkerConnection({ socketPath }) },
    trustedReleaseManifest: async () => RELEASE,
    planner,
    getAudioState: () => ({ stateRevision: 0, frameMap: { worldTimeSeconds: 0 } }),
    masterPcmPublisher: publisher,
    splitPcmSink: splitRing,
    publicStatusStore: status,
  });
  const decoderSessions = createDecoderSessionRegistry({ tokenFactory: () => 'phase5' });
  const audioOwner = { owns: () => false,
    getStatus: () => ({ audioOwner: 'world', decoderSessionId: null, expiresAt: null }),
    decoderDisconnected: async () => false };
  const legacyRoutes = createLegacyRoutes({ sessionRegistry: decoderSessions, audioOwner,
    planner, masterRing: ring, splitRing, geometry: WORKER_GEOMETRY,
    allowedOrigin: PHASE_CONFIG.allowedOrigin,
    getPublicAudioStatus: () => status.get() });
  app = createRuntimeApp({ runtimeConfig: { ...PHASE_CONFIG, port: 0 }, releaseInfo: RELEASE,
    audioStatusStore: status, audioGateway, audioSupervisor: supervisor, audioPlanner: planner,
    legacyRoutes, scheduleInterval: () => 1, clearScheduledInterval: () => {},
  });
  await app.start();
  const port = app.server.address().port;
  try {
    let readyTimer;
    try {
      await Promise.race([supervisor.waitForReady(), new Promise((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error(`FAKE_UDS_READY_TIMEOUT:${JSON.stringify({
          connections: worker.connections, replacements: worker.replacements,
          supervisor: supervisor.getStatus(), status: status.get(),
        })}`)), 2000);
      })]);
    } finally { clearTimeout(readyTimer); }
    const runtimes = await openSockets(() => runtimeSocket(port), 2, sockets);
    assert.equal(runtimes[0].state.worldGeneration, runtimes[1].state.worldGeneration);
    assert.deepEqual(runtimes[0].state.snapshot, runtimes[1].state.snapshot);
    assert.equal(worker.connections, 1);
    assert.equal(worker.replacements, 2);

    const audio = await openSockets(() => audioSocket(port), 2, sockets);
    assert.deepEqual(audio[0].frames[0], audio[1].frames[0]);
    assert.equal(audio[0].frames[1].readUInt32LE(8), audio[1].frames[1].readUInt32LE(8));
    assert.equal(audio[0].frames[1].readBigUInt64LE(16), audio[1].frames[1].readBigUInt64LE(16));

    const legacy = new WebSocket(`ws://127.0.0.1:${port}/decoder`, {
      origin: PHASE_CONFIG.allowedOrigin,
    });
    sockets.push(legacy);
    await once(legacy, 'open', { signal: AbortSignal.timeout(2000) });
    const rejected = new Promise((resolve, reject) => {
      legacy.on('message', (data, binary) => {
        if (binary) return;
        const frame = JSON.parse(data.toString('utf8'));
        if (frame.type === 'error') resolve(frame);
      });
      legacy.on('error', reject);
    });
    legacy.send(JSON.stringify({ type: 'note', voice: 0, midi: 60, velocity: 1,
      durationSeconds: 1 }));
    assert.equal((await withTimeout(rejected, 'LEGACY_REJECT_TIMEOUT')).code,
      'LEGACY_LEASE_REQUIRED');
  } finally {
    for (const socket of sockets) socket.close();
  }
});
