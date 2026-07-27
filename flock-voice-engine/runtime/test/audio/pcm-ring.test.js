import assert from 'node:assert/strict';
import test from 'node:test';
import { blocksForWindow, createPcmRing } from '../../src/audio/pcm-ring.js';

function block(startFrame, frames = 2048) {
  return { startFrame, frameCount: frames, channels: 2, format: 1,
    payload: Buffer.alloc(frames * 2 * 4) };
}

test('ring derives history capacity from ready geometry and keeps a monotonic cursor', () => {
  assert.equal(blocksForWindow(3000, 44100, 2048), 65);
  const ring = createPcmRing({ sampleRate: 44100, blockFrames: 2048, historyMs: 100 });
  ring.beginStream({ audioEpoch: 'e1', minStartFrame: 0n });
  for (let index = 0; index < 4; index += 1) ring.publish(block(BigInt(index * 2048)));
  assert.equal(ring.getStatus().capacity, 3);
  assert.equal(ring.snapshot().length, 3);
  assert.deepEqual(ring.getCursor(), { streamRevision: 1, blockSeq: 1, startFrame: 2048n });
  assert.deepEqual(ring.getLiveCursor(), { streamRevision: 1, blockSeq: 4, startFrame: 8192n });
});

test('worker restart and same-epoch rebuild each advance global stream revision', () => {
  const ring = createPcmRing({ sampleRate: 44100, blockFrames: 2048 });
  const seen = []; ring.subscribe((value) => { if (value.type === 'audio.discontinuity') seen.push(value); });
  ring.beginStream({ audioEpoch: 'e1', minStartFrame: 0n });
  ring.publish(block(0n));
  ring.beginStream({ audioEpoch: 'e1', minStartFrame: 2048n });
  ring.beginStream({ audioEpoch: 'e2', minStartFrame: 0n });
  assert.deepEqual(seen.map((value) => [value.streamRevision, value.resumeStartFrame]),
    [[1, '0'], [2, '2048'], [3, '0']]);
});

test('epoch and same-epoch rebuild cursors cannot begin off-origin or roll back', () => {
  const ring = createPcmRing({ sampleRate: 44100, blockFrames: 2048 });
  assert.throws(() => ring.beginStream({ audioEpoch: 'e1', minStartFrame: 1n }),
    /PCM_EPOCH_MUST_START_AT_ZERO/);
  ring.beginStream({ audioEpoch: 'e1', minStartFrame: 0n });
  ring.publish(block(0n));
  assert.throws(() => ring.beginStream({ audioEpoch: 'e1', minStartFrame: 0n }),
    /PCM_CURSOR_ROLLBACK/);
  assert.throws(() => ring.beginStream({ audioEpoch: 'e2', minStartFrame: 2048n }),
    /PCM_EPOCH_MUST_START_AT_ZERO/);
});
