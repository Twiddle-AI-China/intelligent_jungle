import assert from 'node:assert/strict';
import test from 'node:test';
import { createPcmRing } from '../../src/audio/pcm-ring.js';

test('unexpected worker cursor is rejected without inventing a new stream revision', () => {
  const ring = createPcmRing({ sampleRate: 44100, blockFrames: 64 });
  const seen = []; ring.subscribe((value) => { if (value.type === 'audio.discontinuity') seen.push(value); });
  ring.beginStream({ audioEpoch: 'e', minStartFrame: 0n });
  assert.throws(() => ring.publish({ startFrame: 128n, frameCount: 64, channels: 2, format: 1,
    payload: Buffer.alloc(512) }), /PCM_CURSOR_DISCONTINUITY/);
  assert.equal(ring.getStatus().streamRevision, 1);
  assert.equal(seen.length, 1);
  assert.equal(ring.getLiveCursor().startFrame, 0n);
});
