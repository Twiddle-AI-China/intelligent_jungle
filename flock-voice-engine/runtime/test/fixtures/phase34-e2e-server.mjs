import { createRuntimeApp, PHASE_2_SHADOW_SEED } from '../../src/runtime-app.js';

const app = createRuntimeApp({
  runtimeConfig: Object.freeze({
    host: '127.0.0.1',
    port: 18090,
    runtimeOwner: 'browser',
    audioOwner: 'legacy',
    allowedOrigin: 'http://127.0.0.1:4193',
    phaseGate: 'shadow-no-audio',
  }),
  releaseInfo: Object.freeze({
    releaseRevision: 'unknown',
    sourceManifestSha256: 'unknown',
    runtimeOwner: 'browser',
    audioOwner: 'legacy',
  }),
  seed: PHASE_2_SHADOW_SEED,
  agents: Object.freeze({
    close() {},
    getPublicState: () => Object.freeze({}),
    scheduleReview() {},
    acceptEnvelope: () => false,
    takeForBoundary: () => null,
    resetGeneration() {},
  }),
});

await app.start();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.stop();
    process.exitCode = 0;
  });
}
