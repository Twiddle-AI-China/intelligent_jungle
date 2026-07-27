import { loadRuntimeConfig } from './config.js';
import { loadReleaseInfo } from './release-info.js';
import { createRuntimeApp, PHASE_2_SHADOW_SEED } from './runtime-app.js';

const runtimeConfig = loadRuntimeConfig();
const releaseInfo = loadReleaseInfo();
const app = createRuntimeApp({
  runtimeConfig,
  releaseInfo,
  seed: PHASE_2_SHADOW_SEED,
});

await app.start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.stop();
    process.exitCode = 0;
  });
}
