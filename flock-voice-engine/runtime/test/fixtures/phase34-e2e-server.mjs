import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authorizeExactIpv4LoopbackTransport,
  createOriginPolicy,
} from '../../src/api/origin-policy.js';
import { createRuntimeApp, PHASE_2_SHADOW_SEED } from '../../src/runtime-app.js';
import { createPublicAudioStatusStore } from '../../src/audio/public-audio-status.js';
import {
  createFixtureStaticUi,
  listenLoopbackPortMap,
} from './e2e-runtime-host.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const opsAuthorities = Object.freeze(['127.0.0.1:8090']);
const runtimeConfig = Object.freeze({
  host: '127.0.0.1',
  port: 8090,
  canonicalOrigin: 'http://127.0.0.1:18090',
  opsAuthorities,
  runtimeOwner: 'browser',
  audioOwner: 'legacy',
  phaseGate: 'shadow-no-audio',
});
const originPolicy = createOriginPolicy({
  canonicalOrigin: runtimeConfig.canonicalOrigin,
  opsAuthorities,
  authorizeOperationalTransport: authorizeExactIpv4LoopbackTransport,
});
const staticUi = await createFixtureStaticUi({
  repoRoot,
  entryPath: 'flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html',
  publicDirectories: [
    'flock-voice-engine/runtime/test/fixtures/candidate-ui',
    'mvp/src',
    'mvp/assets',
  ],
  originPolicy,
});
const app = createRuntimeApp({
  runtimeConfig,
  originPolicy,
  releaseInfo: Object.freeze({
    releaseRevision: 'unknown',
    sourceManifestSha256: 'unknown',
    runtimeOwner: 'browser',
    audioOwner: 'legacy',
  }),
  seed: PHASE_2_SHADOW_SEED,
  audioStatusStore: createPublicAudioStatusStore({
    initialStatus: { runtimeOwner: 'browser', audioOwner: 'legacy' },
  }),
  agents: Object.freeze({
    close() {},
    getPublicState: () => Object.freeze({}),
    scheduleReview() {},
    acceptEnvelope: () => false,
    takeForBoundary: () => null,
    resetGeneration() {},
  }),
  staticUi,
});

const portMap = await listenLoopbackPortMap();
try {
  await app.start();
} catch (error) {
  await portMap.close();
  throw error;
}
let stopping = null;
function stop() {
  if (stopping === null) {
    stopping = Promise.allSettled([
      portMap.close(),
      app.stop(),
    ]);
  }
  return stopping;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await stop();
    process.exitCode = 0;
  });
}
