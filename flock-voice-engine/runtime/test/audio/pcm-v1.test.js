import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodeAudioFrameV1 } from '../../src/audio/pcm-v1.js';

const golden = readFileSync(new URL('../fixtures/audio-ws-v1-golden.hex', import.meta.url), 'utf8').trim();

test('server encoder matches the independent fixed golden', () => {
  const actual = encodeAudioFrameV1({ streamRevision: 2, blockSeq: 3,
    startFrame: 0x0102030405060708n, frameCount: 2, channels: 2, format: 1 },
  Float32Array.of(0, .5, -.5, 1));
  assert.equal(actual.toString('hex'), golden);
});
test('encoder rejects payload and cursor overflow', () => {
  assert.throws(() => encodeAudioFrameV1({ streamRevision: 1, blockSeq: 0,
    startFrame: 0n, frameCount: 2, channels: 2, format: 1 }, Float32Array.of(0)),
  /AUDIO_LENGTH_MISMATCH/);
  assert.throws(() => encodeAudioFrameV1({ streamRevision: 1, blockSeq: 0,
    startFrame: (1n << 64n) - 1n, frameCount: 2, channels: 2, format: 1 },
  Float32Array.of(0, 0, 0, 0)), /AUDIO_CURSOR_OVERFLOW/);
});
