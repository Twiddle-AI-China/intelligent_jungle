import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrameClock } from '../../src/audio/frame-clock.js';
import { createAudioPlanner } from '../../src/audio/audio-planner.js';

test('planner pauses incrementals, maps intents, and emits atomic replacement', () => {
  const batches = [];
  const frameClock = createFrameClock({ sampleRate: 44100, blockFrames: 4096 });
  frameClock.replace({ worldTimeSeconds: 0, renderFrame: 0n });
  const planner = createAudioPlanner({ clock: { now: () => 0 }, frameClock,
    enqueueBatch(batch) { batches.push(batch); return { accepted: true }; }, getAudioState: () => ({ stateRevision: 2 }) });
  planner.bindEpoch('epoch');
  assert.equal(planner.accept([{ type: 'note.on' }]).deferred, true);
  planner.resumeWorldWrites();
  planner.accept([{ type: 'note.release', row: 0 }, { type: 'latent.xy', voice: 'bass', xy: [0, 0] }]);
  assert.deepEqual(batches[0].commands.map((x) => x.type), ['note.off', 'latent.set']);
  planner.replace({ stateRevision: 2 }, 8192n);
  assert.equal(batches[1].commands[0].type, 'state.replace');
  assert.equal(batches[1].targetFrame, '8192');
});

test('planner latches outbound overflow', () => {
  const failures = [];
  const frameClock = createFrameClock({ sampleRate: 44100, blockFrames: 4096 });
  frameClock.replace({ worldTimeSeconds: 0, renderFrame: 0n });
  const planner = createAudioPlanner({ clock: { now: () => 0 }, frameClock,
    enqueueBatch: () => ({ accepted: false, reason: 'RUNTIME_AUDIO_OUTBOUND_OVERFLOW' }),
    getAudioState: () => ({}), onTransportFailure: (reason) => failures.push(reason) });
  planner.bindEpoch('e'); planner.resumeWorldWrites();
  assert.equal(planner.accept([{ type: 'note.on', row: 0 }]).accepted, false);
  assert.equal(planner.getStatus().degraded, true);
  assert.deepEqual(failures, ['RUNTIME_AUDIO_OUTBOUND_OVERFLOW']);
});

test('planner projects simulation time and emits worker-schema note edges', () => {
  const batches = [];
  const frameClock = createFrameClock({ sampleRate: 44100, blockFrames: 4096 });
  frameClock.replace({ worldTimeSeconds: 12, renderFrame: 0n });
  const planner = createAudioPlanner({ clock: { now: () => 12_000 }, frameClock,
    enqueueBatch: (batch) => { batches.push(batch); return { accepted: true }; }, getAudioState: () => ({}) });
  planner.bindEpoch('e');
  planner.bindGeometry({ rowVoices: ['bass', 'pad', 'lead', 'pluck', 'pad'] });
  planner.resumeWorldWrites();
  planner.accept([{ type: 'note.on', treeId: 'pad', birdId: 3, midi: 60, velocity: .7 },
    { type: 'note.release', treeId: 'pad', birdId: 3, midi: 60, durationSeconds: 2 }]);
  assert.equal(batches[0].targetFrame, '8192');
  assert.deepEqual(batches[0].commands, [
    { type: 'note.on', midi: 60, velocity: .7, row: 4 },
    { type: 'note.off', row: 4 },
  ]);
});

test('final replacement captures post-mutation state and buffers following incrementals', () => {
  const batches = [];
  let state = { stateRevision: 1 };
  const frameClock = createFrameClock({ sampleRate: 44100, blockFrames: 4096 });
  frameClock.replace({ worldTimeSeconds: 0, renderFrame: 0n });
  const planner = createAudioPlanner({ clock: { now: () => 0 }, frameClock,
    enqueueBatch: (batch) => { batches.push(batch); return { accepted: true }; },
    getAudioState: () => state });
  planner.bindEpoch('e'); planner.bindGeometry({ rowVoices: ['bass'] });
  planner.replace({ stateRevision: 0 }, 0n);
  planner.accept([{ type: 'note.on', row: 0, midi: 60, velocity: .5 }]);
  state = { stateRevision: 2 };
  const barrier = planner.replaceCurrentAndBufferFollowing(0n);
  planner.accept([{ type: 'note.on', row: 0, midi: 62, velocity: .5 }]);
  assert.equal(barrier.stateRevision, 2);
  assert.equal(batches.at(-1).commands[0].value.stateRevision, 2);
  assert.equal(planner.getStatus().deferredBatchCount, 1);
  planner.resumeWorldWrites();
  assert.deepEqual(batches.at(-1).commands, [{ type: 'note.on', row: 0, midi: 62, velocity: .5 }]);
  assert.equal(planner.getStatus().paused, false);
});

test('paused buffer overflow latches recovery and cannot resume with a dropped edge', () => {
  const frameClock = createFrameClock({ sampleRate: 44100, blockFrames: 4096 });
  frameClock.replace({ worldTimeSeconds: 0, renderFrame: 0n });
  const planner = createAudioPlanner({ clock: { now: () => 0 }, frameClock,
    enqueueBatch: () => ({ accepted: true }), getAudioState: () => ({ stateRevision: 4 }),
    outboundCapacity: 1 });
  planner.bindEpoch('e'); planner.bindGeometry({ rowVoices: ['bass'] });
  assert.equal(planner.replaceCurrentAndBufferFollowing(0n).accepted, true);
  assert.equal(planner.accept([{ type: 'note.on', row: 0 }]).accepted, true);
  assert.deepEqual(planner.accept([{ type: 'note.off', row: 0 }]), {
    accepted: false, reason: 'RUNTIME_AUDIO_OUTBOUND_OVERFLOW',
  });
  assert.deepEqual(planner.resumeWorldWrites(), {
    accepted: false, reason: 'RUNTIME_AUDIO_OUTBOUND_OVERFLOW',
  });
  assert.equal(planner.getStatus().paused, true);
});
