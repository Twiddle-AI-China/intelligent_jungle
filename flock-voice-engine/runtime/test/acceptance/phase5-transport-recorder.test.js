import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _createPhase5TransportRecorder,
} from '../../src/acceptance/phase5-transport-recorder.js';

function recorderFixture({ maxEvents = 20, maxBytes = 100_000 } = {}) {
  let now = 100;
  return _createPhase5TransportRecorder({
    monotonicNow: () => (now += 1),
    unixNow: () => 1_000 + now,
    maxEvents,
    maxBytes,
  });
}

const runtimeClaim = Object.freeze({
  runId: '123e4567-e89b-42d3-a456-426614174000',
  client: 4,
  clientIdentitySha256: '4'.repeat(64),
  socketKind: 'runtime',
  generation: 2,
});
const audioClaim = Object.freeze({
  ...runtimeClaim,
  socketKind: 'audio',
  generation: 3,
});

test('named server observations own timestamps type and client binding', () => {
  const recorder = recorderFixture();
  recorder.runtimeOpen(runtimeClaim, { mode: 'resume' });
  recorder.runtimeReady(runtimeClaim, {
    worldGeneration: 'world-a', revision: 7, eventSeq: 8,
  });
  recorder.audioOpen(audioClaim);
  recorder.audioPcm(audioClaim, {
    audioEpoch: 'epoch-a', streamRevision: 2, blockSeq: 3,
    startFrame: '4096', frameCount: 4096,
  });
  const values = recorder.flush();
  assert.deepEqual(values.map(({ client, type }) => ({ client, type })), [
    { client: 4, type: 'runtime.open' },
    { client: 4, type: 'runtime.ready' },
    { client: 4, type: 'audio.open' },
    { client: 4, type: 'audio.pcm' },
  ]);
  assert.deepEqual(values[0].payload, {
    generation: 2,
    mode: 'resume',
    clientIdentitySha256: '4'.repeat(64),
  });
  assert.equal(values[3].payload.generation, 3);
  assert.equal(values.every((value, index) => (
    index === 0 || value.atMonotonicMs > values[index - 1].atMonotonicMs
  )), true);
});

test('cross-kind claims, generic fields and overflow consume the recorder', () => {
  const recorder = recorderFixture({ maxEvents: 1 });
  assert.throws(
    () => recorder.runtimeOpen(audioClaim, { mode: 'bootstrap' }),
    /PHASE5_TRANSPORT_OBSERVATION_INVALID/u,
  );
  assert.throws(() => recorder.flush(), /PHASE5_TRANSPORT_RECORDER_TERMINAL/u);

  const overflow = recorderFixture({ maxEvents: 1 });
  overflow.audioOpen(audioClaim);
  assert.throws(
    () => overflow.audioClose(audioClaim, { code: 1000, reason: 'done' }),
    /PHASE5_TRANSPORT_RECORDER_OVERFLOW/u,
  );
  assert.throws(() => overflow.flush(), /PHASE5_TRANSPORT_RECORDER_TERMINAL/u);
});

test('worker and agent observations own their clock and fixed payload shape', () => {
  const recorder = recorderFixture();
  recorder.workerSample({
    pid: 500, ready: true, recovering: false,
    restartCount: 0, audioEpoch: 'epoch-a', supervisorGeneration: 1,
    lastExitedPid: null, lastExitSignal: null,
  });
  recorder.agentStart({
    requestId: 'timeout-injected-1', source: 'injected',
    model: 'bird_agent', attempts: 1,
  });
  recorder.agentSettle({
    requestId: 'timeout-injected-1', source: 'injected',
    model: 'bird_agent', status: 'timeout', reason: 'ATTEMPT_TIMEOUT',
    attempts: 1, httpStatus: null,
  });
  const values = recorder.flush();
  assert.deepEqual(values.map(({ client, type }) => ({ client, type })), [
    { client: 0, type: 'worker.sample' },
    { client: 0, type: 'agent.start' },
    { client: 0, type: 'agent.settle' },
  ]);
  assert.equal(values[1].payload.startedAtMonotonicMs,
    values[1].atMonotonicMs);
  assert.equal(values[2].payload.startedAtMonotonicMs,
    values[1].atMonotonicMs);
  assert.equal(values[2].payload.settledAtMonotonicMs,
    values[2].atMonotonicMs);
});

test('worker recovery stays hidden until the signed recovery action releases it', () => {
  const recorder = recorderFixture();
  recorder.workerSample({
    pid: 500, ready: true, recovering: false,
    restartCount: 0, audioEpoch: 'epoch-a', supervisorGeneration: 1,
    lastExitedPid: null, lastExitSignal: null,
  });
  recorder.workerSample({
    pid: null, ready: false, recovering: true,
    restartCount: 0, audioEpoch: 'epoch-a', supervisorGeneration: 2,
    lastExitedPid: 500, lastExitSignal: 'SIGKILL',
  });
  recorder.workerSample({
    pid: 501, ready: true, recovering: false,
    restartCount: 1, audioEpoch: 'epoch-b', supervisorGeneration: 2,
    lastExitedPid: 500, lastExitSignal: 'SIGKILL',
  });

  assert.deepEqual(recorder.peekPendingWorkerRecovery(), {
    pid: 501, ready: true, recovering: false,
    restartCount: 1, audioEpoch: 'epoch-b', supervisorGeneration: 2,
    lastExitedPid: 500, lastExitSignal: 'SIGKILL',
  });
  assert.deepEqual(recorder.flush().map((value) => value.payload.ready),
    [true, false]);

  recorder.releasePendingWorkerRecovery();
  assert.deepEqual(recorder.flush().map((value) => value.payload.ready), [true]);
});

test('state snapshot is derived only from named server observations', () => {
  const recorder = recorderFixture({ maxEvents: 100 });
  for (let client = 1; client <= 4; client += 1) {
    const runtime = Object.freeze({
      ...runtimeClaim, client, generation: 1,
      clientIdentitySha256: String(client).repeat(64),
    });
    const audio = Object.freeze({
      ...runtime, socketKind: 'audio',
    });
    recorder.runtimeOpen(runtime, { mode: 'bootstrap' });
    recorder.runtimeReady(runtime, {
      worldGeneration: 'world-a', revision: client, eventSeq: client,
    });
    recorder.runtimeSnapshot(runtime, {
      worldGeneration: 'world-a', revision: client, eventSeq: client,
    });
    recorder.runtimeEgress(runtime, {
      capacityEntries: 256, queuedEntries: 0, inFlight: false,
      closed: false, closeCode: null, closeReason: null,
    });
    recorder.audioOpen(audio);
    recorder.audioReady(audio, {
      audioEpoch: 'epoch-a', streamRevision: 1, blockSeq: 0,
      resumeStartFrame: '0',
    });
    recorder.audioPcm(audio, {
      audioEpoch: 'epoch-a', streamRevision: 1, blockSeq: 0,
      startFrame: '0', frameCount: 4096,
    });
  }
  recorder.workerSample({
    pid: 500, ready: true, recovering: false,
    restartCount: 0, audioEpoch: 'epoch-a', supervisorGeneration: 1,
    lastExitedPid: null, lastExitSignal: null,
  });
  const state = recorder.snapshotState();
  assert.equal(state.runtimeClients.length, 4);
  assert.equal(state.audioClients[3].pcmCursorFrames, 4096);
  assert.equal(state.world.revision, 4);
  assert.equal(state.worker.pid, 500);
  assert.deepEqual(state.provider, { lastResult: null });
});
