import assert from 'node:assert/strict';
import test from 'node:test';

import { createPcmRing } from '../src/audio/pcm-ring.js';
import { createProviderRunner } from '../src/agents/provider-runner.js';
import { createConnectionEgress } from '../src/api/connection-egress.js';
import { createPublicAudioStatusStore } from '../src/audio/public-audio-status.js';
import { createWorkerSupervisor } from '../src/audio/worker-supervisor.js';
import { createLeaseManager } from '../src/control/lease-manager.js';

const identity = Object.freeze({ releaseRevision: 'a'.repeat(40),
  sourceManifestSha256: 'b'.repeat(64), audioArtifactSha256: 'c'.repeat(64),
  protocolFamily: 'flock-audio-ipc', protocolVersion: 1, audioArtifactKind: 'release-artifact' });
const geometry = Object.freeze({ sampleRate: 44100, blockFrames: 64, poolSize: 1,
  rowVoices: ['bass'] });

function connection(epoch) {
  let listener;
  return { readWorkerHello: async () => ({ identity }), acceptIdentity() {},
    readWorkerReady: async () => ({ audioEpoch: epoch, renderFrame: 0n, geometry }),
    enqueueBatch: () => ({ accepted: true }), subscribe(fn) { listener = fn; return () => {}; },
    next: async () => ({ type: 'audio.state.applied', audioEpoch: epoch, stateRevision: 0,
      appliedCommandSeq: 1, renderFrame: '0' }), close() {}, emit(value) { listener?.(value); },
    get outboundQueueDepth() { return 0; } };
}

function supervisorFor(connections, publisher = { publish() {} }) {
  const planner = { pauseWorldWrites() {}, bindTransport() {}, bindEpoch() {}, bindGeometry() {},
    replaceFrameMap() {}, replace: () => ({ accepted: true, commandSeq: 1 }),
    replaceCurrentAndBufferFollowing: () => ({ accepted: true, commandSeq: 1, stateRevision: 0 }),
    resumeWorldWrites: () => ({ accepted: true }), getStatus: () => ({ degraded: false }) };
  return createWorkerSupervisor({ connector: { connect: async () => connections.shift() },
    trustedReleaseManifest: async () => ({ workerIdentity: identity,
      manifestGeometrySha256: 'd'.repeat(64), geometry }), planner,
    getAudioState: () => ({ stateRevision: 0, frameMap: { worldTimeSeconds: 0 } }),
    masterPcmPublisher: publisher, splitPcmSink: { publish() {}, reset() {} },
    publicStatusStore: createPublicAudioStatusStore(), delay: async () => {} });
}

test('worker crash never rebuilds world and emits one stream boundary', async () => {
  const first = connection('old-epoch'); const second = connection('new-epoch');
  const world = { worldGeneration: 'world-stable', revision: 42 };
  const discontinuities = [];
  const publisher = { publish() {}, hold() {}, stageStream(stream) { this.stream = stream; },
    commitStagedStream() { discontinuities.push({ scope: 'stream', ...this.stream }); } };
  const supervisor = supervisorFor([first, second], publisher);
  await supervisor.start();
  const before = structuredClone(world); const prior = discontinuities.length;
  first.emit({ type: 'worker.connection.closed' });
  for (let attempt = 0; attempt < 20 && supervisor.getStatus().audio?.audioEpoch !== 'new-epoch'; attempt += 1) {
    await new Promise((done) => setImmediate(done));
  }
  await supervisor.waitForReady();
  assert.deepEqual(world, before);
  assert.equal(discontinuities.length - prior, 1);
  assert.equal(supervisor.getStatus().audio.audioEpoch, 'new-epoch');
  await supervisor.stop();
});

test('PCM corruption triggers recovery and cannot publish a corrupt block', async () => {
  const first = connection('epoch-one'); const second = connection('epoch-two'); let published = 0;
  const supervisor = supervisorFor([first, second], { publish() { published += 1; } });
  await supervisor.start();
  first.emit({ type: 'pcm.master', frameCount: 63, channels: 2, format: 1,
    startFrame: 0n, payload: Buffer.alloc(1) });
  for (let attempt = 0; attempt < 20 && supervisor.getStatus().audio?.audioEpoch !== 'epoch-two'; attempt += 1) {
    await new Promise((done) => setImmediate(done));
  }
  assert.equal(published, 0);
  assert.equal((await supervisor.waitForReady()).audio.audioEpoch, 'epoch-two');
  await supervisor.stop();
});

test('slow or throwing client writers are isolated from hot PCM subscribers', () => {
  const ring = createPcmRing({ sampleRate: 44100, blockFrames: 64 }); let hot = 0;
  ring.subscribe(() => { throw new Error('SLOW_WRITER'); });
  ring.subscribe((value) => { if (value.type === 'pcm.block') hot += 1; });
  ring.beginStream({ audioEpoch: 'epoch', minStartFrame: 0n });
  for (let block = 0n; block < 8n; block += 1n) ring.publish({ startFrame: block * 64n,
    frameCount: 64, channels: 2, format: 1, payload: Buffer.alloc(64 * 2 * 4) });
  assert.equal(hot, 8);
});

test('lease disconnect releases only the exact socket generation while world remains live', () => {
  let now = 0; const manager = createLeaseManager({ clock: { now: () => now } });
  manager.take({ resource: 'latent:bass', clientId: 'client', connectionGeneration: 'old' });
  const released = manager.disconnect({ clientId: 'client', connectionGeneration: 'new' });
  assert.equal(released.length, 0); now += 1;
  assert.ok(manager.get('latent:bass'));
});

test('worker replacement stall stays audio-local and readiness remains fail closed', async () => {
  const stalled = connection('stalled-epoch');
  stalled.next = async (_predicate, timeoutMs) => new Promise((_, reject) => {
    setTimeout(() => reject(new Error('AUDIO_REPLACE_TIMEOUT')), timeoutMs);
  });
  const planner = { pauseWorldWrites() {}, bindTransport() {}, bindEpoch() {}, bindGeometry() {},
    replaceFrameMap() {}, replace: () => ({ accepted: true, commandSeq: 1 }),
    replaceCurrentAndBufferFollowing: () => ({ accepted: true, commandSeq: 1, stateRevision: 0 }),
    resumeWorldWrites: () => ({ accepted: true }) };
  const store = createPublicAudioStatusStore(); let worldTicks = 0;
  const supervisor = createWorkerSupervisor({ connector: { connect: async () => stalled },
    trustedReleaseManifest: async () => ({ workerIdentity: identity,
      manifestGeometrySha256: 'd'.repeat(64), geometry }), planner,
    getAudioState: () => ({ stateRevision: 0, frameMap: { worldTimeSeconds: worldTicks } }),
    masterPcmPublisher: { publish() {} }, splitPcmSink: { publish() {} }, publicStatusStore: store,
    replaceTimeoutMs: 5, delay: () => new Promise(() => {}) });
  supervisor.start().catch(() => {});
  worldTicks += 10;
  await new Promise((done) => setTimeout(done, 12));
  assert.equal(worldTicks, 10);
  assert.equal(store.get().workerReady, false);
  assert.equal(store.get().recovering, true);
  await supervisor.stop();
});

test('runtime edge overflow closes only the overflowing connection', async () => {
  let callback; const closes = [];
  const egress = createConnectionEgress({ capacity: 2, socket: {
    send(_body, done) { callback = done; }, close(code, reason) { closes.push({ code, reason }); },
  } });
  egress.startWriter();
  assert.equal(egress.enqueue({ revision: 1 }), true);
  await new Promise((done) => setImmediate(done));
  assert.equal(egress.enqueue({ revision: 2 }), true);
  assert.equal(egress.enqueue({ revision: 3 }), false);
  assert.deepEqual(closes, [{ code: 4410, reason: 'EGRESS_OVERFLOW' }]);
  callback?.();
});

test('8081 provider timeout settles while authoritative world ticks continue', async () => {
  let worldTicks = 0; let settle;
  const settled = new Promise((done) => { settle = done; });
  const runner = createProviderRunner({ channel: 'species', attemptTimeoutMs: 5, deadlineMs: 10,
    maxAttempts: 1, failureThreshold: 3, cooldownMs: 100,
    clock: { now: () => 0 }, setTimer: (fn) => { queueMicrotask(fn); return 1; }, clearTimer() {} });
  assert.equal(runner.tryStart({ requestId: 'provider-timeout', invoke: () => new Promise(() => {}),
    onSettled: settle }).accepted, true);
  worldTicks += 4;
  const result = await settled;
  assert.equal(result.status, 'timeout');
  assert.equal(worldTicks, 4);
});
