import { createAgentComposition } from './agents/agent-composition.js';
import { loadAgentProviderConfig, loadRuntimeConfig } from './config.js';
import {
  bindReleaseInfoToWorkerIdentity,
  loadReleaseInfo,
} from './release-info.js';
import { createRuntimeApp, PHASE_2_SHADOW_SEED } from './runtime-app.js';
import { createFrameClock } from './audio/frame-clock.js';
import { createAudioPlanner } from './audio/audio-planner.js';
import { createPublicAudioStatusStore } from './audio/public-audio-status.js';
import { createSplitRing } from './audio/split-ring.js';
import { createWorkerSupervisor } from './audio/worker-supervisor.js';
import { createUnixWorkerConnection } from './audio/worker-protocol.js';
import { readTrustedReleaseBundle } from './audio/release-manifest.js';
import { projectAudioState } from './audio/audio-state-projector.js';
import { createPrimingMasterPcmPublisher } from './audio/priming-master-pcm-publisher.js';
import { createPcmRing } from './audio/pcm-ring.js';
import { createAudioWsGateway } from './api/audio-ws.js';
import {
  authorizeExactIpv4LoopbackTransport,
  createOriginPolicy,
} from './api/origin-policy.js';
import { createLeaseManager } from './control/lease-manager.js';
import { createMaintenanceAuth } from './control/maintenance-auth.js';
import { createDecoderSessionRegistry } from './legacy/decoder-session-registry.js';
import { createAudioOwnerController } from './legacy/audio-owner.js';
import { createLegacyWriteAccess } from './legacy/write-access.js';
import { createAudioControlBarrier } from './audio/audio-control-barrier.js';
import { createLegacyRoutes } from './api/legacy-routes.js';
import { loadStaticUi } from './api/static-ui.js';
import {
  createPhase5CandidateCaptureOwner,
} from './capture/phase5-candidate-capture-owner.js';
import {
  createRuntimeProcessLifecycle,
} from './runtime-process-lifecycle.js';
import {
  createPhase5ClientRegistry,
} from './acceptance/phase5-client-registry.js';
import {
  createPhase5TransportRecorder,
} from './acceptance/phase5-transport-recorder.js';
import {
  createPhase5ClientActuator,
} from './acceptance/phase5-client-actuator.js';
import {
  createPhase5AgentFaultProbe,
} from './acceptance/phase5-agent-fault-probe.js';
import {
  createPhase5FaultActuator,
} from './acceptance/phase5-fault-actuator.js';
import {
  createPhase5FaultBridge,
} from './acceptance/phase5-fault-bridge.js';
import {
  createPhase5FaultInstructionChannel,
} from './acceptance/phase5-fault-instruction-channel.js';
import {
  createPhase5FaultControlRuntime,
} from './acceptance/phase5-fault-control-runtime.js';

const runtimeConfig = loadRuntimeConfig();
const originPolicy = createOriginPolicy({
  canonicalOrigin: runtimeConfig.canonicalOrigin,
  opsAuthorities: runtimeConfig.opsAuthorities,
  authorizeOperationalTransport: authorizeExactIpv4LoopbackTransport,
});
const providerConfig = loadAgentProviderConfig();
const releaseInfo = loadReleaseInfo();
const trustedReleaseBundle = await readTrustedReleaseBundle({
  path: '/release/release-manifest.json',
  digestPath: '/release/release-manifest.json.sha256',
});
const trustedRelease = trustedReleaseBundle.manifest;
bindReleaseInfoToWorkerIdentity(
  releaseInfo,
  trustedRelease.workerIdentity,
);
const trustedCaptureRelease = Object.freeze({
  releaseManifestSha256:
    trustedReleaseBundle.releaseManifestSha256,
  releaseRevision:
    trustedRelease.workerIdentity.releaseRevision,
  sourceManifestSha256:
    trustedRelease.workerIdentity.sourceManifestSha256,
  audioArtifactSha256:
    trustedRelease.workerIdentity.audioArtifactSha256,
});
const staticUi = await loadStaticUi({
  repoRoot: '/app',
  graphPath: '/release/production-graph.json',
  releaseManifest: trustedRelease,
  originPolicy,
});
let app = null;
let faultSessionAuthority = null;
let faultClientRegistry = null;
let faultClientActuator = null;
let faultControlRuntime = null;
let faultTransportRecorder = null;
let faultObservationsEnabled = false;
let lastReady = null;
let currentConnection = null;
const faultTransportObserver = Object.freeze(Object.fromEntries([
  'runtimeOpen', 'runtimeReady', 'runtimeSnapshot', 'runtimeEgress',
  'runtimeClose', 'audioOpen', 'audioReady', 'audioPcm',
  'audioDiscontinuity', 'audioPause', 'audioResume', 'audioClose',
  'workerSample', 'agentStart', 'agentSettle', 'failObserver',
].map((name) => [name, (...args) => {
  if (!faultObservationsEnabled || faultTransportRecorder === null) {
    return undefined;
  }
  return faultTransportRecorder[name](...args);
}])));
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
  return projectAudioState({ session, ready: lastReady,
    audioOwner: audioStatusStore.get().audioOwner });
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
const splitPcmRing = createSplitRing({ geometry: trustedRelease.geometry });
const masterPcmPublisher = createPrimingMasterPcmPublisher({ downstream: masterPcmRing });
const audioGateway = createAudioWsGateway({ ring: masterPcmRing,
  originPolicy,
  getFaultClientRegistry: () => faultClientRegistry,
  faultTransportRecorder: faultTransportObserver,
  getFaultClientActuator: () => faultClientActuator,
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
const leaseManager = createLeaseManager({ clock: { now: () => Date.now() } });
const maintenanceAuth = createMaintenanceAuth();
const decoderSessions = createDecoderSessionRegistry();
const legacyAccess = createLegacyWriteAccess();
const controlBarrier = createAudioControlBarrier({
  runExclusive: (kind, operation) => statusSession.runExclusive(kind, operation),
  planner,
  workerControl: { apply: (...args) => supervisor.barrierControl.apply(...args),
    replaceWorld: (...args) => supervisor.barrierControl.replaceWorld(...args) },
  publicStatusStore: audioStatusStore,
  legacyAccess,
  streamTimeline: { discontinuity: () => masterPcmRing.discontinuity() },
});
const audioOwnerController = createAudioOwnerController({ leaseManager, maintenanceAuth,
  sessionRegistry: decoderSessions, controlBarrier, legacyAccess, clock: { now: () => Date.now() } });
const legacyRoutes = createLegacyRoutes({ sessionRegistry: decoderSessions,
  audioOwner: audioOwnerController, planner, masterRing: masterPcmRing, splitRing: splitPcmRing,
  geometry: trustedRelease.geometry, originPolicy,
  getPublicAudioStatus: () => audioStatusStore.get(),
});
supervisor = createWorkerSupervisor({ connector,
  trustedReleaseManifest: async () => trustedRelease, planner, getAudioState: audioState,
  getRecoveryCommands: () => app.registry.get('default').commit(
    'audio.preview.recovery', (session) => session.kernel.recoverAudioState(),
  ).then(() => []),
  masterPcmPublisher, splitPcmSink: splitPcmRing, publicStatusStore: audioStatusStore,
  legacyAccess,
  onWorkerSample: (value) => faultTransportObserver.workerSample(value),
  getAudioControlState: () => ({ ...audioOwnerController.getStatus(),
    publicAudioOwner: audioStatusStore.get().audioOwner,
    transitioning: controlBarrier.getStatus().transitioning }) });
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
let lifecycle = null;
app = createRuntimeApp({
  runtimeConfig,
  originPolicy,
  releaseInfo,
  seed: PHASE_2_SHADOW_SEED,
  agents,
  audioPlanner: planner,
  audioStatusStore,
  audioSupervisor: supervisor,
  audioGateway,
  leaseManager,
  maintenanceAuth,
  audioOwnerController,
  legacyRoutes,
  staticUi,
  getFaultClientRegistry: () => faultClientRegistry,
  faultTransportRecorder: faultTransportObserver,
  getFaultClientActuator: () => faultClientActuator,
  onFaultReconnectGrant(grant) {
    if (grant.client === 4 && grant.socketKind === 'runtime') {
      faultClientActuator?.acceptReconnectGrant(grant);
    }
  },
  onFatal() {
    lifecycle.fail();
  },
});

const capture = createPhase5CandidateCaptureOwner({
  trustedRelease: trustedCaptureRelease,
  trustedGeometry: trustedRelease.geometry,
  onFaultSessionAuthority(context) {
    if (faultSessionAuthority !== null
        || faultClientRegistry !== null) {
      throw new Error('PHASE5_FAULT_SESSION_ALREADY_INSTALLED');
    }
    faultSessionAuthority = context.authority;
    faultClientRegistry = createPhase5ClientRegistry({
      runId: context.identity.runId,
    });
    faultTransportRecorder = createPhase5TransportRecorder();
    faultClientActuator = createPhase5ClientActuator({
      recorder: faultTransportRecorder,
    });
    const instructionChannel = createPhase5FaultInstructionChannel({
      clientActuator: faultClientActuator,
    });
    const agentProbe = createPhase5AgentFaultProbe({
      authority: faultSessionAuthority,
      recorder: faultTransportRecorder,
    });
    const actuator = createPhase5FaultActuator({
      identity: context.identity,
      agentProbe,
      instructionSink: instructionChannel.instructionSink,
      monotonicNow: () => performance.now(),
      setTimer: globalThis.setTimeout,
      clearTimer: globalThis.clearTimeout,
      workerRecovery: faultTransportRecorder,
    });
    const bridge = createPhase5FaultBridge({
      recorder: faultTransportRecorder,
      actuator,
      monotonicNow: () => performance.now(),
      unixNow: () => Date.now(),
    });
    faultControlRuntime = createPhase5FaultControlRuntime({
      authority: faultSessionAuthority,
      clientRegistry: faultClientRegistry,
      bridge,
      instructionChannel,
      onActivated() {
        if (faultObservationsEnabled) {
          throw new Error('PHASE5_FAULT_OBSERVER_ALREADY_ACTIVE');
        }
        faultObservationsEnabled = true;
        const status = supervisor.getStatus();
        if (!status.workerReady || status.recovering
            || !status.launcher || !status.audio) {
          throw new Error('PHASE5_FAULT_WORKER_BASELINE_UNAVAILABLE');
        }
        faultTransportRecorder.workerSample({
          pid: status.launcher.pid,
          ready: true,
          recovering: false,
          restartCount: status.launcher.restartCount,
          audioEpoch: status.audio.audioEpoch,
          supervisorGeneration: status.launcher.supervisorGeneration,
          lastExitedPid: status.launcher.lastExitedPid,
          lastExitSignal: status.launcher.lastExitSignal,
        });
      },
    });
    faultControlRuntime.start();
  },
});
const runtimeService = Object.freeze({
  async start() {
    await agents.initialize();
    return app.start();
  },
  stop() {
    faultControlRuntime?.close();
    return app.stop();
  },
});
lifecycle = createRuntimeProcessLifecycle({
  capture,
  app: runtimeService,
  signalSource: process,
  setExitCode(value) {
    if (value === 1 || process.exitCode !== 1) {
      process.exitCode = value;
    }
  },
});

await lifecycle.start();
