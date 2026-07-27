import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerSupervisor } from '../../src/audio/worker-supervisor.js';
import { createPublicAudioStatusStore } from '../../src/audio/public-audio-status.js';
import { createAudioControlBarrier } from '../../src/audio/audio-control-barrier.js';
import { createLegacyWriteAccess } from '../../src/legacy/write-access.js';
import { createPcmRing } from '../../src/audio/pcm-ring.js';
import { createPrimingMasterPcmPublisher } from '../../src/audio/priming-master-pcm-publisher.js';

test('identity, geometry and replacement gate readiness', async () => {
  const identity = { releaseRevision: '1' };
  let listener = null;
  const connection = { readWorkerHello: async () => ({ identity }), acceptIdentity() {},
    readWorkerReady: async () => ({ audioEpoch: 'e', renderFrame: 0n,
      geometry: { sampleRate: 44100, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] } }),
    subscribe(fn) { listener = fn; return () => {}; },
    next: async () => ({ type: 'audio.state.applied', audioEpoch: 'e', stateRevision: 0,
      appliedCommandSeq: 1, renderFrame: '0' }), close() {} };
  const planner = { pauseWorldWrites() {}, bindEpoch() {}, replace: () => ({ accepted: true, commandSeq: 1 }),
    replaceCurrentAndBufferFollowing: () => ({ accepted: true, commandSeq: 1, stateRevision: 0 }),
    resumeWorldWrites: () => ({ accepted: true, flushed: false }), noteApplied() {} };
  const store = createPublicAudioStatusStore();
  const supervisor = createWorkerSupervisor({ connector: { connect: async () => connection },
    trustedReleaseManifest: async () => ({ workerIdentity: identity, manifestGeometrySha256: 'x',
      geometry: { sampleRate: 44100, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] } }),
    planner, getAudioState: () => ({ stateRevision: 0 }), masterPcmPublisher: { publish() {} },
    splitPcmSink: { publish() {} }, publicStatusStore: store });
  await supervisor.start();
  assert.equal(store.get().workerReady, true);
  listener({ type: 'pcm.split', startFrame: 0n, frameCount: 64, channels: 1, format: 1 });
});

function readyConnection(identity, onSubscribe = () => {}, audioEpoch = 'e') {
  let listener;
  return { readWorkerHello: async () => ({ identity }), acceptIdentity() {}, enqueueBatch: () => ({ accepted: true }),
    readWorkerReady: async () => ({ audioEpoch, renderFrame: 0n,
      geometry: { sampleRate: 44100, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] } }),
    subscribe(fn) { listener = fn; onSubscribe(fn); return () => {}; },
    next: async () => ({ type: 'audio.state.applied', audioEpoch, stateRevision: 0,
      appliedCommandSeq: 1, renderFrame: '0' }),
    close() {}, emit(value) { listener?.(value); }, get outboundQueueDepth() { return 0; } };
}

test('unexpected worker close rebuilds through 1 second backoff and increments public recovery state', async () => {
  const identity = { releaseRevision: '1' };
  const first = readyConnection(identity);
  const connections = [first, readyConnection(identity)];
  const delays = [];
  const planner = { pauseWorldWrites() {}, bindTransport() {}, bindEpoch() {}, replaceFrameMap() {},
    replace: () => ({ accepted: true, commandSeq: 1 }),
    replaceCurrentAndBufferFollowing: () => ({ accepted: true, commandSeq: 1, stateRevision: 0 }),
    resumeWorldWrites: () => ({ accepted: true, flushed: false }) };
  const store = createPublicAudioStatusStore();
  const supervisor = createWorkerSupervisor({ connector: { connect: async () => connections.shift() },
    trustedReleaseManifest: async () => ({ workerIdentity: identity, manifestGeometrySha256: 'a'.repeat(64),
      geometry: { sampleRate: 44100, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] } }),
    planner, getAudioState: () => ({ stateRevision: 0, frameMap: { worldTimeSeconds: 0 } }),
    masterPcmPublisher: { publish() {} }, splitPcmSink: { publish() {} }, publicStatusStore: store,
    delay: async (ms) => { delays.push(ms); } });
  await supervisor.start();
  assert.equal(supervisor.getStatus().workerReady, true);
  first.emit({ type: 'worker.connection.closed' });
  for (let attempt = 0; attempt < 10 && supervisor.getStatus().restartCount === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await supervisor.waitForReady();
  assert.deepEqual(delays, [1000]);
  assert.equal(supervisor.getStatus().restartCount, 1);
  assert.equal(store.get().workerReady, true);
});

test('close during guarded ready publication invalidates the attempt before ready is visible', async () => {
  const identity = { releaseRevision: '1' };
  const first = readyConnection(identity);
  const second = readyConnection(identity);
  const connections = [first, second];
  const planner = { pauseWorldWrites() {}, bindTransport() {}, bindEpoch() {}, bindGeometry() {},
    replaceFrameMap() {}, replace: () => ({ accepted: true, commandSeq: 1 }),
    replaceCurrentAndBufferFollowing: () => ({ accepted: true, commandSeq: 1, stateRevision: 0 }),
    resumeWorldWrites: () => ({ accepted: true }), getStatus: () => ({ degraded: false }) };
  const backing = createPublicAudioStatusStore();
  const visibleReady = [];
  backing.subscribe((value) => { if (value.workerReady) visibleReady.push(value.statusRevision); });
  let injectClose = true;
  const store = {
    update: backing.update,
    guardedUpdate(patch, guard, beforePublish) {
      if (injectClose) { injectClose = false; first.emit({ type: 'worker.connection.closed' }); }
      return backing.guardedUpdate(patch, guard, beforePublish);
    },
  };
  const supervisor = createWorkerSupervisor({ connector: { connect: async () => connections.shift() },
    trustedReleaseManifest: async () => ({ workerIdentity: identity,
      manifestGeometrySha256: 'a'.repeat(64),
      geometry: { sampleRate: 44100, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] } }),
    planner, getAudioState: () => ({ stateRevision: 0, frameMap: { worldTimeSeconds: 0 } }),
    masterPcmPublisher: { publish() {} }, splitPcmSink: { publish() {} },
    publicStatusStore: store, delay: async () => {} });
  await supervisor.start();
  assert.equal(supervisor.getStatus().workerReady, true);
  assert.deepEqual(visibleReady.length, 1);
  assert.equal(backing.get().workerReady, true);
});

test('close before replacement assertion retries instead of cancelling recovery', async () => {
  const identity = { releaseRevision: '1' };
  const first = readyConnection(identity);
  const connections = [first, readyConnection(identity)];
  const planner = { pauseWorldWrites() {}, bindTransport() {}, bindEpoch() {}, bindGeometry() {},
    replaceFrameMap() {}, replace: () => ({ accepted: true, commandSeq: 1 }),
    replaceCurrentAndBufferFollowing: () => ({ accepted: true, commandSeq: 1, stateRevision: 0 }),
    resumeWorldWrites: () => ({ accepted: true }), getStatus: () => ({ degraded: false }) };
  let projections = 0;
  const supervisor = createWorkerSupervisor({ connector: { connect: async () => connections.shift() },
    trustedReleaseManifest: async () => ({ workerIdentity: identity,
      manifestGeometrySha256: 'a'.repeat(64),
      geometry: { sampleRate: 44100, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] } }),
    planner, getAudioState: () => {
      projections += 1;
      if (projections === 1) first.emit({ type: 'worker.connection.closed' });
      return { stateRevision: 0, frameMap: { worldTimeSeconds: 0 } };
    }, masterPcmPublisher: { publish() {} }, splitPcmSink: { publish() {} },
    publicStatusStore: createPublicAudioStatusStore(), delay: async () => {} });
  await supervisor.start();
  assert.equal(projections, 2);
  assert.equal(supervisor.getStatus().workerReady, true);
});

test('failed reconnect continues through 1/2 second backoff until ready', async () => {
  const identity = { releaseRevision: '1' };
  const first = readyConnection(identity);
  const third = readyConnection(identity);
  let calls = 0;
  const delays = [];
  const planner = { pauseWorldWrites() {}, bindTransport() {}, bindEpoch() {}, bindGeometry() {},
    replaceFrameMap() {}, replace: () => ({ accepted: true, commandSeq: 1 }),
    replaceCurrentAndBufferFollowing: () => ({ accepted: true, commandSeq: 1, stateRevision: 0 }),
    resumeWorldWrites: () => ({ accepted: true, flushed: false }) };
  const store = createPublicAudioStatusStore();
  const supervisor = createWorkerSupervisor({ connector: { connect: async () => {
    calls += 1;
    if (calls === 1) return first;
    if (calls === 2) throw new Error('CONNECT_FAILED');
    return third;
  } }, trustedReleaseManifest: async () => ({ workerIdentity: identity,
    manifestGeometrySha256: 'a'.repeat(64),
    geometry: { sampleRate: 44100, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] } }),
  planner, getAudioState: () => ({ stateRevision: 0, frameMap: { worldTimeSeconds: 0 } }),
  masterPcmPublisher: { publish() {} }, splitPcmSink: { publish() {} }, publicStatusStore: store,
  delay: async (ms) => { delays.push(ms); } });
  await supervisor.start();
  first.emit({ type: 'worker.connection.closed' });
  for (let attempt = 0; attempt < 20 && (calls < 3 || !supervisor.getStatus().workerReady); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(supervisor.getStatus().workerReady, true);
});

test('post-replacement PCM prime is bounded and never publishes ready on timeout', async () => {
  const identity = { releaseRevision: '1' };
  const planner = { pauseWorldWrites() {}, bindTransport() {}, bindEpoch() {}, replaceFrameMap() {},
    replace: () => ({ accepted: true, commandSeq: 1 }),
    replaceCurrentAndBufferFollowing: () => ({ accepted: true, commandSeq: 1, stateRevision: 0 }),
    resumeWorldWrites: () => ({ accepted: true, flushed: false }) };
  const store = createPublicAudioStatusStore();
  const supervisor = createWorkerSupervisor({ connector: { connect: async () => readyConnection(identity) },
    trustedReleaseManifest: async () => ({ workerIdentity: identity, manifestGeometrySha256: 'a'.repeat(64),
      geometry: { sampleRate: 44100, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] } }),
    planner, getAudioState: () => ({ stateRevision: 0, frameMap: { worldTimeSeconds: 0 } }),
    masterPcmPublisher: { publish() {}, waitForPostAppliedPrime: () => new Promise(() => {}) },
    splitPcmSink: { publish() {} }, publicStatusStore: store, primeTimeoutMs: 5,
    delay: () => new Promise(() => {}) });
  supervisor.start().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(store.get().workerReady, false);
  assert.equal(store.get().recovering, true);
  await supervisor.stop();
});

test('legacy restore stages PCM and holds the stream again when its prime times out', async () => {
  const identity = { releaseRevision: '1' };
  const planner = { pauseWorldWrites() {}, bindTransport() {}, bindEpoch() {}, bindGeometry() {},
    replaceFrameMap() {}, replace: () => ({ accepted: true, commandSeq: 1 }),
    replaceCurrentAndBufferFollowing: () => ({ accepted: true, commandSeq: 2, stateRevision: 0 }),
    resumeWorldWrites: () => ({ accepted: true }),
    getStatus: () => ({ audioEpoch: 'e', degraded: false }) };
  let waits = 0; let holds = 0; let staged = 0;
  const publisher = { publish() {}, beginStream() {}, hold() { holds += 1; },
    stageStream() { staged += 1; }, commitStagedStream() {},
    waitForPostAppliedPrime() { waits += 1;
      return waits === 1 ? Promise.resolve() : new Promise(() => {}); } };
  const supervisor = createWorkerSupervisor({ connector: { connect: async () => readyConnection(identity) },
    trustedReleaseManifest: async () => ({ workerIdentity: identity,
      manifestGeometrySha256: 'a'.repeat(64),
      geometry: { sampleRate: 44100, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] } }),
    planner, getAudioState: () => ({ stateRevision: 0, frameMap: { worldTimeSeconds: 0 } }),
    masterPcmPublisher: publisher, splitPcmSink: { publish() {} },
    publicStatusStore: createPublicAudioStatusStore(), primeTimeoutMs: 5 });
  await supervisor.start();
  await assert.rejects(supervisor.barrierControl.replaceWorld(), /AUDIO_PCM_PRIME_TIMEOUT/);
  assert.equal(staged, 2);
  assert.equal(holds, 3);
  await supervisor.stop();
});

test('worker recovery under a stable legacy owner never resumes world writes', async () => {
  const identity = { releaseRevision: '1' }; let resumes = 0;
  const legacyAccess = createLegacyWriteAccess();
  legacyAccess.allowExactGeneration('decoder-stable');
  const planner = { pauseWorldWrites() {}, bindTransport() {}, bindEpoch() {}, bindGeometry() {},
    replaceFrameMap() {}, replace: () => ({ accepted: true, commandSeq: 1 }),
    replaceCurrentAndBufferFollowing: () => ({ accepted: true, commandSeq: 1, stateRevision: 0 }),
    resumeWorldWrites() { resumes += 1; return { accepted: true }; },
    getStatus: () => ({ degraded: false }) };
  const supervisor = createWorkerSupervisor({ connector: { connect: async () => readyConnection(identity) },
    trustedReleaseManifest: async () => ({ workerIdentity: identity,
      manifestGeometrySha256: 'a'.repeat(64),
      geometry: { sampleRate: 44100, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] } }),
    planner, getAudioState: () => ({ stateRevision: 0, frameMap: { worldTimeSeconds: 0 },
      audioOwner: 'legacy' }), masterPcmPublisher: { publish() {} },
    splitPcmSink: { publish() {} }, publicStatusStore: createPublicAudioStatusStore({
      initialStatus: { audioOwner: 'legacy' } }),
    legacyAccess,
    getAudioControlState: () => ({ audioOwner: 'legacy', decoderSessionId: 'decoder-stable',
      transitioning: false }) });
  await supervisor.start();
  assert.equal(supervisor.getStatus().workerReady, true);
  assert.equal(resumes, 0);
  assert.equal(legacyAccess.isAllowed('decoder-stable'), true);
  await supervisor.stop();
});

test('overlapping legacy take commits owner and new epoch before staged recovery PCM', async () => {
  const identity = { releaseRevision: '1' };
  let unblockHello;
  const secondHello = new Promise((resolve) => { unblockHello = resolve; });
  const first = readyConnection(identity);
  const second = readyConnection(identity, () => {}, 'e2');
  second.readWorkerHello = async () => { await secondHello; return { identity }; };
  const connections = [first, second];
  const planner = { pauseWorldWrites() {}, bindTransport() {}, bindEpoch() {}, bindGeometry() {},
    replaceFrameMap() {}, replace: () => ({ accepted: true, commandSeq: 1 }),
    replaceCurrentAndBufferFollowing: () => ({ accepted: true, commandSeq: 1, stateRevision: 0 }),
    enqueueControl: () => ({ accepted: true, commandSeq: 2 }),
    resumeWorldWrites: () => ({ accepted: true }),
    getStatus: () => ({ audioEpoch: 'e2', degraded: false }) };
  const legacyAccess = createLegacyWriteAccess();
  const owner = { audioOwner: 'world', decoderSessionId: null };
  const store = createPublicAudioStatusStore({ initialStatus: { audioOwner: 'world' } });
  const ring = createPcmRing({ sampleRate: 44100, blockFrames: 64 });
  const basePublisher = createPrimingMasterPcmPublisher({ downstream: ring });
  const publisher = { ...basePublisher, waitForPostAppliedPrime() {
    basePublisher.publish({ startFrame: 0n, frameCount: 64, channels: 2, format: 1,
      payload: Buffer.alloc(64 * 2 * 4) });
    return basePublisher.waitForPostAppliedPrime();
  } };
  const publicAtEpoch = [];
  ring.subscribe((value) => {
    if (value.audioEpoch === 'e2' || value.record?.audioEpoch === 'e2') {
      publicAtEpoch.push(structuredClone(store.get()));
    }
  });
  let barrier;
  const supervisor = createWorkerSupervisor({ connector: { connect: async () => connections.shift() },
    trustedReleaseManifest: async () => ({ workerIdentity: identity,
      manifestGeometrySha256: 'a'.repeat(64),
      geometry: { sampleRate: 44100, blockFrames: 64, poolSize: 1, rowVoices: ['bass'] } }),
    planner, getAudioState: () => ({ stateRevision: 0, frameMap: { worldTimeSeconds: 0 },
      audioOwner: owner.audioOwner }), masterPcmPublisher: publisher,
    splitPcmSink: { publish() {}, reset() {} },
    publicStatusStore: store, legacyAccess, delay: async () => {},
    getAudioControlState: () => ({ ...owner, publicAudioOwner: store.get().audioOwner,
      transitioning: barrier?.getStatus().transitioning ?? false }) });
  barrier = createAudioControlBarrier({ runExclusive: async (_kind, operation) => operation(), planner,
    workerControl: supervisor.barrierControl, publicStatusStore: store, legacyAccess,
    streamTimeline: { discontinuity() {} } });
  await supervisor.start();
  const recovery = supervisor.restart('TEST_RESTART');
  await new Promise((resolve) => setImmediate(resolve));
  owner.audioOwner = 'legacy'; owner.decoderSessionId = 'decoder-a';
  const taking = barrier.enterLegacy({ decoderSessionId: 'decoder-a' });
  unblockHello();
  await recovery;
  await taking;
  assert.equal(barrier.getStatus().transitioning, false);
  assert.equal(store.get().audioOwner, 'legacy');
  assert.equal(store.get().workerReady, true);
  assert.equal(store.get().audio.audioEpoch, 'e2');
  assert.equal(ring.getStatus().audioEpoch, 'e2');
  assert.ok(publicAtEpoch.length > 0);
  assert.ok(publicAtEpoch.every((value) => value.audioOwner === 'legacy'
    && value.audio.audioEpoch === 'e2'));
  assert.equal(legacyAccess.isAllowed('decoder-a'), true);
  await supervisor.stop();
});
