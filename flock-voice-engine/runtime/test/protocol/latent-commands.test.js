import assert from 'node:assert/strict';
import test from 'node:test';

import { LATENT_COMMANDS, normalizeLatentCommandPayload } from '../../src/protocol/v1.js';

test('latent command allowlist accepts exact normalized payloads', () => {
  assert.deepEqual(LATENT_COMMANDS, [
    'control.take', 'control.release', 'control.heartbeat',
    'latent.setCursor', 'latent.setMode', 'preview.start', 'preview.stop',
  ]);
  assert.deepEqual(normalizeLatentCommandPayload('control.take', {
    voice: 'melody', ttlMs: 3_000,
  }), { voice: 'melody', ttlMs: 3_000 });
  assert.deepEqual(normalizeLatentCommandPayload('latent.setCursor', {
    voice: 'pad', leaseToken: 'lease-1', eventSeq: 4,
    cursor: { x: 0.25, y: -0.5, pca: [] },
  }), {
    voice: 'pad', leaseToken: 'lease-1', eventSeq: 4,
    cursor: { x: 0.25, y: -0.5, pca: [] },
  });
});

test('browser cannot forge socket generation or send malformed latent values', () => {
  for (const [name, payload] of [
    ['control.take', { voice: 'pad', connectionGeneration: 9 }],
    ['control.release', { voice: 'pad', leaseToken: 'x', generation: 9 }],
    ['latent.setCursor', { voice: 'pad', leaseToken: 'x', eventSeq: 1, cursor: { x: NaN, y: 0, pca: [] } }],
    ['latent.setCursor', { voice: 'pad', leaseToken: 'x', eventSeq: 1, cursor: { x: 0, y: Infinity, pca: [] } }],
    ['latent.setMode', { voice: 'pad', leaseToken: 'x', mode: 'knn' }],
    ['preview.start', { voice: '../pad', leaseToken: 'x' }],
  ]) assert.equal(normalizeLatentCommandPayload(name, payload), null, name);
});
