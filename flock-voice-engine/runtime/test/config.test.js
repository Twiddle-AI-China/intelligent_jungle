import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PHASE_CONFIG,
  RUNTIME_PROFILES,
  loadAgentProviderConfig,
  loadRuntimeConfig,
} from '../src/config.js';

test('defaults to the fixed localhost Phase 5 direct-local configuration', () => {
  assert.deepEqual(loadRuntimeConfig({}), {
    host: '127.0.0.1',
    port: 18090,
    runtimeOwner: 'server',
    audioOwner: 'world',
    canonicalOrigin: 'http://127.0.0.1:18090',
    opsAuthorities: ['127.0.0.1:18090'],
    phaseGate: 'phase5-local',
  });
  assert.equal(Object.isFrozen(PHASE_CONFIG), true);
  assert.equal(Object.isFrozen(PHASE_CONFIG.opsAuthorities), true);
  assert.deepEqual(RUNTIME_PROFILES, {
    'direct-local': {
      host: '127.0.0.1',
      port: 18090,
      canonicalOrigin: 'http://127.0.0.1:18090',
      opsAuthorities: ['127.0.0.1:18090'],
      phaseGate: 'phase5-local',
    },
    'container-local': {
      host: '0.0.0.0',
      port: 8090,
      canonicalOrigin: 'http://127.0.0.1:18090',
      opsAuthorities: ['127.0.0.1:8090'],
      phaseGate: 'phase5-local',
    },
    production: {
      host: '0.0.0.0',
      port: 8090,
      canonicalOrigin: 'http://localhost:8090',
      opsAuthorities: ['127.0.0.1:8090'],
      phaseGate: 'phase5-production',
    },
  });
  for (const profile of Object.values(RUNTIME_PROFILES)) {
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.opsAuthorities), true);
  }
});

test('rejects configuration that would leave the Phase 5 direct-local gate', () => {
  for (const env of [
    { FLOCK_RUNTIME_HOST: '0.0.0.0' },
    { FLOCK_RUNTIME_HOST: '192.168.9.140' },
    { FLOCK_RUNTIME_PORT: '8090' },
    { FLOCK_RUNTIME_OWNER: 'browser' },
    { FLOCK_AUDIO_OWNER: 'server' },
    { FLOCK_ALLOWED_ORIGIN: 'https://example.test' },
    { FLOCK_CANONICAL_ORIGIN: 'http://localhost:8090' },
    { FLOCK_OPS_AUTHORITIES: '127.0.0.1:8090' },
    { FLOCK_PHASE_GATE: 'production' },
  ]) {
    assert.throws(() => loadRuntimeConfig(env), /PHASE_5_LOCAL_CONFIG_REJECTED/);
  }
});

test('production profile is explicit and keeps fixed ownership and origin', () => {
  assert.deepEqual(loadRuntimeConfig({ FLOCK_RUNTIME_PROFILE: 'production' }), {
    host: '0.0.0.0',
    port: 8090,
    runtimeOwner: 'server',
    audioOwner: 'world',
    canonicalOrigin: 'http://localhost:8090',
    opsAuthorities: ['127.0.0.1:8090'],
    phaseGate: 'phase5-production',
  });
});

test('container-local keeps the fixed candidate origin and separate ops authority', () => {
  assert.deepEqual(loadRuntimeConfig({ FLOCK_RUNTIME_PROFILE: 'container-local' }), {
    host: '0.0.0.0',
    port: 8090,
    runtimeOwner: 'server',
    audioOwner: 'world',
    canonicalOrigin: 'http://127.0.0.1:18090',
    opsAuthorities: ['127.0.0.1:8090'],
    phaseGate: 'phase5-local',
  });
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
