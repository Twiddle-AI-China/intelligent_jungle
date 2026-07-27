import assert from 'node:assert/strict';
import test from 'node:test';
import { createAudioControlBarrier } from '../../src/audio/audio-control-barrier.js';
import { createPublicAudioStatusStore } from '../../src/audio/public-audio-status.js';

function harness({ failReplace = false, failValidate = false } = {}) {
  const trace = [];
  const store = createPublicAudioStatusStore({ initialStatus: { audioOwner: 'world' } });
  const planner = { pauseWorldWrites: () => trace.push('worldWrites.pause'),
    resumeWorldWrites: () => { trace.push('worldWrites.resume'); return { accepted: true }; } };
  const barrier = createAudioControlBarrier({
    runExclusive: async (name, operation) => { trace.push(name); return operation(); }, planner,
    workerControl: { async apply(commands) { trace.push(...commands.map((x) => x.type)); },
      async replaceWorld() { trace.push('audio.state.replace');
        if (failReplace) throw new Error('AUDIO_REPLACE_TIMEOUT'); trace.push('audio.state.applied');
        return { validate() { if (failValidate) throw new Error('WORKER_SUPERVISOR_CANCELLED'); },
          commitStream: () => trace.push('audio.discontinuity') }; } },
    publicStatusStore: store,
    legacyAccess: { rejectWrites: () => trace.push('legacy.rejectWrites'),
      allowExactGeneration: () => trace.push('legacy.allowExactGeneration') },
    streamTimeline: { discontinuity: () => trace.push('audio.discontinuity') },
  });
  return { barrier, trace, store };
}

test('take commits legacy owner before public discontinuity and controls bypass pause', async () => {
  const h = harness();
  await h.barrier.enterLegacy({ decoderSessionId: 'decoder-a' });
  assert.equal(h.store.get().audioOwner, 'legacy');
  assert.ok(h.trace.indexOf('preview.allOff') > h.trace.indexOf('worldWrites.pause'));
  assert.ok(h.trace.indexOf('audio.discontinuity') < h.trace.indexOf('legacy.allowExactGeneration'));
});

test('worker generation loss before mailbox commit publishes no half owner', async () => {
  const h = harness({ failValidate: true });
  await h.barrier.enterLegacy({ decoderSessionId: 'decoder-a' }); h.trace.length = 0;
  await assert.rejects(h.barrier.restoreWorld(), /WORKER_SUPERVISOR_CANCELLED/);
  assert.equal(h.store.get().audioOwner, 'legacy');
  assert.equal(h.trace.includes('audio.discontinuity'), false);
  assert.equal(h.store.get().recovering, true);
});

test('restore replaces and primes before owner world and resumes writes', async () => {
  const h = harness();
  await h.barrier.enterLegacy({ decoderSessionId: 'decoder-a' }); h.trace.length = 0;
  await h.barrier.restoreWorld('legacy-release');
  assert.equal(h.store.get().audioOwner, 'world');
  assert.ok(h.trace.indexOf('audio.state.applied') < h.trace.indexOf('audio.discontinuity'));
  assert.ok(h.trace.indexOf('audio.discontinuity') < h.trace.indexOf('worldWrites.resume'));
});

test('replace timeout remains recovering and rejects both sides', async () => {
  const h = harness({ failReplace: true });
  await assert.rejects(h.barrier.restoreWorld(), /AUDIO_REPLACE_TIMEOUT/);
  assert.equal(h.store.get().recovering, true);
  assert.equal(h.store.get().degraded, true);
  assert.equal(h.trace.at(-2), 'worldWrites.pause');
  assert.equal(h.trace.at(-1), 'legacy.rejectWrites');
});
