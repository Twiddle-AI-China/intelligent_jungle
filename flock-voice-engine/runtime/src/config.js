const DIRECT_LOCAL_OPS_AUTHORITIES = Object.freeze(['127.0.0.1:18090']);
const CONTAINER_OPS_AUTHORITIES = Object.freeze(['127.0.0.1:8090']);

export const RUNTIME_PROFILES = Object.freeze({
  'direct-local': Object.freeze({
    host: '127.0.0.1',
    port: 18090,
    canonicalOrigin: 'http://127.0.0.1:18090',
    opsAuthorities: DIRECT_LOCAL_OPS_AUTHORITIES,
    phaseGate: 'phase5-local',
  }),
  'container-local': Object.freeze({
    host: '0.0.0.0',
    port: 8090,
    canonicalOrigin: 'http://127.0.0.1:18090',
    opsAuthorities: CONTAINER_OPS_AUTHORITIES,
    phaseGate: 'phase5-local',
  }),
  production: Object.freeze({
    host: '0.0.0.0',
    port: 8090,
    canonicalOrigin: 'http://localhost:8090',
    opsAuthorities: CONTAINER_OPS_AUTHORITIES,
    phaseGate: 'phase5-production',
  }),
});

export const PHASE_CONFIG = Object.freeze({
  ...RUNTIME_PROFILES['direct-local'],
  runtimeOwner: 'server',
  audioOwner: 'world',
  phaseGate: 'phase5-local',
});

export function loadRuntimeConfig(env = process.env) {
  const profileName = env.FLOCK_RUNTIME_PROFILE ?? 'direct-local';
  const profile = RUNTIME_PROFILES[profileName];
  if (!profile) {
    throw new Error('RUNTIME_PROFILE_REJECTED');
  }
  const candidate = {
    ...profile,
    runtimeOwner: env.FLOCK_RUNTIME_OWNER ?? PHASE_CONFIG.runtimeOwner,
    audioOwner: env.FLOCK_AUDIO_OWNER ?? PHASE_CONFIG.audioOwner,
  };
  if (env.HOST !== undefined || env.PORT !== undefined || env.FLOCK_RUNTIME_HOST !== undefined
      || env.FLOCK_RUNTIME_PORT !== undefined || env.FLOCK_PHASE_GATE !== undefined
      || env.FLOCK_RUNTIME_OWNER !== undefined || env.FLOCK_AUDIO_OWNER !== undefined
      || env.FLOCK_ALLOWED_ORIGIN !== undefined || env.FLOCK_CANONICAL_ORIGIN !== undefined
      || env.FLOCK_OPS_AUTHORITIES !== undefined) {
    throw new Error('PHASE_5_LOCAL_CONFIG_REJECTED');
  }
  return Object.freeze(candidate);
}

export function loadAgentProviderConfig(env = process.env) {
  if (env.FLOCK_AGENT_SPECIES_ENABLED === 'true') {
    throw new Error('SPECIES_ADMISSION_UNAVAILABLE_PHASE_3_4');
  }
  const masterEnabled = env.FLOCK_AGENT_MASTER_ENABLED === 'true';
  const masterApiKey = env.DEEPSEEK_API_KEY?.trim() || null;
  if (masterEnabled && !masterApiKey) throw new Error('DEEPSEEK_API_KEY_REQUIRED');
  return Object.freeze({
    speciesEnabled: false,
    masterEnabled,
    masterBaseUrl: 'https://api.deepseek.com/v1',
    masterModel: 'deepseek-v4-flash',
    masterApiKey,
  });
}
