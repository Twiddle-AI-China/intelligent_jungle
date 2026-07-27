import { createAgentComposition } from './agents/agent-composition.js';
import { loadAgentProviderConfig, loadRuntimeConfig } from './config.js';
import { loadReleaseInfo } from './release-info.js';
import { createRuntimeApp, PHASE_2_SHADOW_SEED } from './runtime-app.js';

const runtimeConfig = loadRuntimeConfig();
const providerConfig = loadAgentProviderConfig();
const releaseInfo = loadReleaseInfo();
let app = null;
const agents = createAgentComposition({
  providerConfig,
  publishEnvelope(envelope) {
    if (app === null) return;
    Promise.resolve()
      .then(() => app.registry.get(envelope.worldId))
      .then((session) => session.acceptAgentEnvelope(envelope))
      .catch(() => {});
  },
});
await agents.initialize();
app = createRuntimeApp({
  runtimeConfig,
  releaseInfo,
  seed: PHASE_2_SHADOW_SEED,
  agents,
});

await app.start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.stop();
    process.exitCode = 0;
  });
}
