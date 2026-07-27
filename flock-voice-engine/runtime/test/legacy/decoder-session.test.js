import assert from 'node:assert/strict';
import test from 'node:test';
import { createDecoderSessionRegistry } from '../../src/legacy/decoder-session-registry.js';

test('decoder generations are single-use and detach invalidates exact session', () => {
  let id = 0; const registry = createDecoderSessionRegistry({ tokenFactory: () => `id-${++id}` });
  const socket = {};
  const first = registry.attach(socket);
  assert.equal(registry.isActive(first.decoderSessionId), true);
  registry.detach(socket);
  const second = registry.attach(socket);
  assert.notEqual(first.decoderSessionId, second.decoderSessionId);
  assert.equal(registry.isActive(first.decoderSessionId), false);
});

test('generation stays single-use even when the entropy source repeats', () => {
  const registry = createDecoderSessionRegistry({ tokenFactory: () => 'same' });
  const first = registry.attach({}); registry.detach(first.decoderSessionId);
  const second = registry.attach({});
  assert.notEqual(first.decoderSessionId, second.decoderSessionId);
});
