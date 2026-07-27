import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrameClock } from '../../src/audio/frame-clock.js';

test('frame clock projects world time with a two-block lead', () => {
  const clock = createFrameClock({ sampleRate: 48000, blockFrames: 2048 });
  clock.replace({ worldTimeSeconds: 10, renderFrame: 1000n });
  assert.equal(clock.targetFrame(10), 5096n);
  assert.equal(clock.targetFrame(11), 49000n);
});
