import { createAgentComposition } from './agents/agent-composition.js';
import { loadAgentProviderConfig, loadRuntimeConfig } from './config.js';
import { loadReleaseInfo } from './release-info.js';
import { createRuntimeApp, PHASE_2_SHADOW_SEED } from './runtime-app.js';
import { createFrameClock } from './audio/frame-clock.js';
import { createAudioPlanner } from './audio/audio-planner.js';
import { createPublicAudioStatusStore } from './audio/public-audio-status.js';
import { createDiscardingSplitSink } from './audio/discarding-split-sink.js';
import { createWorkerSupervisor } from './audio/worker-supervisor.js';
import { createUnixWorkerConnection } from './audio/worker-protocol.js';
import { readTrustedReleaseManifest } from './audio/release-manifest.js';
import { projectAudioState } from './audio/audio-state-projector.js';
import { createPrimingMasterPcmPublisher } from './audio/priming-master-pcm-publisher.js';
import { createPcmRing } from './audio/pcm-ring.js';
import { createAudioWsGateway } from './api/audio-ws.js';

const runtimeConfig = loadRuntimeConfig();
const providerConfig = loadAgentProviderConfig();
const releaseInfo = loadReleaseInfo();
const trustedRelease = await readTrustedReleaseManifest({ path: '/release/release-manifest.json',
  digestPath: '/release/release-manifest.json.sha256' });
let app = null;
let lastReady = null;
let currentConnection = null;
const frameClock = createFrameClock({ sampleRate: trustedRelease.geometry.sampleRate,
  blockFrames: trustedRelease.geometry.blockFrames });
const statusSession = { runExclusive(kind, operation) {
  if (app === null) return operation();
  return app.registry.get('default').runExclusive(kind, operation);
} };
const audioStatusStore = createPublicAudioStatusStore({ session: statusSession,
  initialStatus: { runtimeOwner: runtimeConfig.runtimeOwner, audioOwner: runtimeConfig.audioOwner } });
function audioState(ready = lastReady) {
  if (ready) lastReady = ready;
  if (!lastReady || app === null) throw new Error('AUDIO_STATE_NOT_READY');
  const session = app.registry.get('default');
  return projectAudioState({ session, ready: lastReady, audioOwner: runtimeConfig.audioOwner });
}
let supervisor = null;
const planner = createAudioPlanner({ clock: { now: () => app === null ? 0
  : app.registry.get('default').kernel.getSnapshot().simTime * 1000 }, frameClock,
  enqueueBatch: (batch) => currentConnection?.enqueueBatch(batch)
    ?? { accepted: false, reason: 'WORKER_NOT_CONNECTED' }, getAudioState: audioState,
  onTransportFailure(reason) {
    queueMicrotask(() => supervisor?.rebuildStream(reason).catch(() => {}));
  } });
const masterPcmRing = createPcmRing({ sampleRate: trustedRelease.geometry.sampleRate,
  blockFrames: trustedRelease.geometry.blockFrames });
const masterPcmPublisher = createPrimingMasterPcmPublisher({ downstream: masterPcmRing });
const audioGateway = createAudioWsGateway({ ring: masterPcmRing,
  allowedOrigin: runtimeConfig.allowedOrigin,
  getAudioReady() {
    const status = audioStatusStore.get();
    if (!status.workerReady || status.recovering || status.degraded || !status.audio) {
      throw new Error('AUDIO_STREAM_NOT_READY');
    }
    return status.audio;
  } });
const connector = { async connect() {
  currentConnection = await createUnixWorkerConnection({ socketPath: '/run/flock-audio/audio.sock' });
  return currentConnection;
} };
supervisor = createWorkerSupervisor({ connector,
  trustedReleaseManifest: async () => trustedRelease, planner, getAudioState: audioState,
  getRecoveryCommands: () => app.registry.get('default').commit(
    'audio.preview.recovery', (session) => session.kernel.recoverAudioState(),
  ).then(() => []),
  masterPcmPublisher, splitPcmSink: createDiscardingSplitSink(), publicStatusStore: audioStatusStore });
const agents = createAgentComposition({
  providerConfig,
  getSpeciesTelemetry: () => supervisor.getAdmissionTelemetry(),
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
  audioPlanner: planner,
  audioStatusStore,
  audioSupervisor: supervisor,
  audioGateway,
});

await app.start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.stop();
    process.exitCode = 0;
  });
}
