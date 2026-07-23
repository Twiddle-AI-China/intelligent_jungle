import assert from 'node:assert/strict';
import test from 'node:test';

import { PHASE_CONFIG, loadRuntimeConfig } from '../src/config.js';

test('defaults to the fixed localhost Phase 1-2 configuration', () => {
  assert.deepEqual(loadRuntimeConfig({}), {
    host: '127.0.0.1',
    port: 18090,
    runtimeOwner: 'browser',
    audioOwner: 'legacy',
    allowedOrigin: 'http://127.0.0.1:4193',
  });
  assert.equal(Object.isFrozen(PHASE_CONFIG), true);
});

test('rejects configuration that would leave the Phase 1-2 gate', () => {
  for (const env of [
    { FLOCK_RUNTIME_HOST: '0.0.0.0' },
    { FLOCK_RUNTIME_HOST: '192.168.9.140' },
    { FLOCK_RUNTIME_PORT: '8090' },
    { FLOCK_RUNTIME_OWNER: 'server' },
    { FLOCK_AUDIO_OWNER: 'server' },
    { FLOCK_ALLOWED_ORIGIN: 'https://example.test' },
  ]) {
    assert.throws(() => loadRuntimeConfig(env), /PHASE_1_2_CONFIG_REJECTED/);
  }
});
