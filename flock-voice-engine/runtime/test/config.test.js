import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PHASE_CONFIG,
  loadAgentProviderConfig,
  loadRuntimeConfig,
} from '../src/config.js';

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

test('Phase 3-4 agent config keeps species fail-closed and master opt-in', () => {
  assert.deepEqual(loadAgentProviderConfig({}), {
    speciesEnabled: false,
    masterEnabled: false,
    masterBaseUrl: 'https://api.deepseek.com/v1',
    masterModel: 'deepseek-v4-flash',
    masterApiKey: null,
  });
  assert.throws(
    () => loadAgentProviderConfig({ FLOCK_AGENT_SPECIES_ENABLED: 'true' }),
    /SPECIES_ADMISSION_UNAVAILABLE_PHASE_3_4/,
  );
  assert.throws(
    () => loadAgentProviderConfig({ FLOCK_AGENT_MASTER_ENABLED: 'true' }),
    /DEEPSEEK_API_KEY_REQUIRED/,
  );
  assert.deepEqual(loadAgentProviderConfig({
    FLOCK_AGENT_MASTER_ENABLED: 'true', DEEPSEEK_API_KEY: ' server-only ',
  }), {
    speciesEnabled: false,
    masterEnabled: true,
    masterBaseUrl: 'https://api.deepseek.com/v1',
    masterModel: 'deepseek-v4-flash',
    masterApiKey: 'server-only',
  });
});
