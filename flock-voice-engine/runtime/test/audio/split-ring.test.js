import assert from 'node:assert/strict';
import test from 'node:test';
import { createSplitRing } from '../../src/audio/split-ring.js';

test('split ring derives a bounded history and keeps draining without readers', () => {
  const ring = createSplitRing({ geometry: { sampleRate: 6400, blockFrames: 64, poolSize: 4 },
    historyMs: 50 });
  for (let index = 0; index < 10; index += 1) ring.publish({ startFrame: BigInt(index * 64),
    frameCount: 64, channels: 4, format: 1, payload: Buffer.alloc(64 * 4 * 4, index) });
  assert.equal(ring.getStatus().capacity, 5);
  assert.equal(ring.snapshot().length, 5);
  assert.equal(ring.snapshot()[0].startFrame, 320n);
  assert.throws(() => ring.publish({ startFrame: 999n, frameCount: 64, channels: 4,
    format: 1, payload: Buffer.alloc(1024) }), /SPLIT_CURSOR_DISCONTINUITY/);
});

test('split listener receives independent payload copies', () => {
  const ring = createSplitRing({ geometry: { sampleRate: 6400, blockFrames: 64, poolSize: 2 } });
  const source = Buffer.alloc(512, 7); const seen = [];
  const attached = ring.attach((record) => seen.push(record));
  ring.publish({ startFrame: 0n, frameCount: 64, channels: 2, format: 1, payload: source });
  source.fill(0); attached.unsubscribe();
  assert.equal(seen[0].payload[0], 7);
});
