export const PHASE_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: 18090,
  runtimeOwner: 'server',
  audioOwner: 'world',
  allowedOrigin: 'http://127.0.0.1:4193',
  phaseGate: 'phase5-local',
});

export function loadRuntimeConfig(env = process.env) {
  const candidate = {
    host: env.FLOCK_RUNTIME_HOST ?? PHASE_CONFIG.host,
    port: Number(env.FLOCK_RUNTIME_PORT ?? PHASE_CONFIG.port),
    runtimeOwner: env.FLOCK_RUNTIME_OWNER ?? PHASE_CONFIG.runtimeOwner,
    audioOwner: env.FLOCK_AUDIO_OWNER ?? PHASE_CONFIG.audioOwner,
    allowedOrigin: env.FLOCK_ALLOWED_ORIGIN ?? PHASE_CONFIG.allowedOrigin,
    phaseGate: env.FLOCK_PHASE_GATE ?? PHASE_CONFIG.phaseGate,
  };
  if (JSON.stringify(candidate) !== JSON.stringify(PHASE_CONFIG)) {
    throw new Error('PHASE_5_LOCAL_CONFIG_REJECTED');
  }
  return candidate;
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
