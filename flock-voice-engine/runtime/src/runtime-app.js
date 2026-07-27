import { WebSocketServer } from 'ws';

import { createBootstrapHandler } from './api/bootstrap.js';
import { createLatentRoutes } from './api/latent-routes.js';
import { createRuntimeWsGateway } from './api/runtime-ws.js';
import { PHASE_CONFIG } from './config.js';
import { DOMAIN_CONFIG } from './domain/config.js';
import {
  SIMULATION_CONFIG_REVISION,
} from './domain/simulation-checkpoint.js';
import { createSimulationKernelFactory, validateRuntimeCheckpoint } from './simulation-runtime.js';
import { createCandidateServer } from './server.js';
import { WorldSessionRegistry } from './world-session/session-registry.js';
import { WorldSession } from './world-session/world-session.js';

export const PHASE_2_SHADOW_SEED = 0x4c4353;

function closeWithCallback(target, method = 'close') {
  return new Promise((resolve) => {
    try {
      target[method](() => resolve());
    } catch {
      resolve();
    }
  });
}

export function createRuntimeApp({
  runtimeConfig = PHASE_CONFIG,
  releaseInfo,
  seed = PHASE_2_SHADOW_SEED,
  restoredSnapshot = null,
  agents = null,
  createKernel = null,
  createSession = (options) => new WorldSession(options),
  createRegistry = (options) => new WorldSessionRegistry(options),
  createBootstrap = createBootstrapHandler,
  createLatentMapRoutes = createLatentRoutes,
  createGateway = createRuntimeWsGateway,
  createWebSocketServer = () => new WebSocketServer({
    noServer: true,
    clientTracking: true,
  }),
  createServer = createCandidateServer,
  scheduleInterval = setInterval,
  clearScheduledInterval = clearInterval,
  audioPlanner = null,
  audioStatusStore = null,
  audioSupervisor = null,
  audioGateway = null,
  leaseManager = null,
  maintenanceAuth = null,
  audioOwnerController = null,
  legacyRoutes = null,
} = {}) {
  if (!releaseInfo || runtimeConfig.host !== '127.0.0.1'
    || !(agents === null || (
      typeof agents.close === 'function'
      && typeof agents.getPublicState === 'function'
    ))) {
    throw new Error('RUNTIME_APP_DEPENDENCIES_INVALID');
  }
  let defaultSession = null;
  const kernelFactory = createKernel ?? createSimulationKernelFactory({ agents, enableLatent: true,
    sharedLeaseManager: leaseManager,
    createAudioSink: () => audioPlanner ?? { accept() {}, getStatus: () => ({ mode: 'null' }) } });
  const registry = createRegistry({
    createSession: () => {
      defaultSession = createSession({
        seed,
        createKernel: kernelFactory,
        validateRestoredSnapshot: (snapshot) => validateRuntimeCheckpoint(snapshot, {
          seed,
          configRevision: SIMULATION_CONFIG_REVISION,
        }),
        restoredSnapshot,
        releaseRevision: releaseInfo.releaseRevision,
        getAgentState: agents?.getPublicState ?? null,
      });
      return defaultSession;
    },
  });
  const apiHandler = createBootstrap({
    getSession: (worldId) => registry.get(worldId),
    allowedOrigin: runtimeConfig.allowedOrigin,
    audioStatusStore,
    maintenanceAuth,
    audioOwner: audioOwnerController,
  });
  const latentRoutes = createLatentMapRoutes({
    getPublicMap: (voice) => Promise.resolve(registry.get('default'))
      .then((session) => session.runExclusive(
        'latent.map.read',
        (owner) => owner.kernel.getLatentMap(voice),
      )),
    allowedOrigin: runtimeConfig.allowedOrigin,
  });
  const webSocketServer = createWebSocketServer();
  const gateway = createGateway({
    getSession: (worldId) => registry.get(worldId),
    allowedOrigin: runtimeConfig.allowedOrigin,
    webSocketServer,
    audioStatusStore,
    maintenanceAuth,
    audioOwner: audioOwnerController,
  });
  let stopping = false;
  let started = false;
  let intervalHandle = null;
  let stopPromise = null;
  let cancelPendingStart = null;
  let pendingStartErrorHandler = null;

  function upgradeHandler(request, socket, head) {
    if (stopping) {
      socket.destroy?.();
      return;
    }
    gateway.handleUpgrade(request, socket, head);
  }

  const server = createServer({
    releaseInfo,
    apiHandler,
    latentRoutes,
    upgradeHandler,
    audioUpgradeHandler: audioGateway?.handleUpgrade,
    getAgentState: agents?.getPublicState,
    audioStatusStore,
    getAudioSupervisorStatus: audioSupervisor?.getStatus,
    phaseGate: runtimeConfig.phaseGate,
    legacyRoutes,
  });

  function start() {
    if (started) throw new Error('RUNTIME_APP_ALREADY_STARTED');
    if (stopping) throw new Error('RUNTIME_APP_STOPPING');
    started = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const onError = (error) => {
        if (settled) return;
        settled = true;
        server.off?.('error', onError);
        pendingStartErrorHandler = null;
        cancelPendingStart = null;
        started = false;
        reject(error);
      };
      const settleStoppedStart = () => {
        if (settled) return;
        settled = true;
        cancelPendingStart = null;
        resolve(false);
      };
      cancelPendingStart = settleStoppedStart;
      pendingStartErrorHandler = onError;
      server.once?.('error', onError);
      try {
        server.listen(runtimeConfig.port, runtimeConfig.host, () => {
          server.off?.('error', onError);
          pendingStartErrorHandler = null;
          if (settled) return;
          settled = true;
          cancelPendingStart = null;
          if (stopping) {
            resolve(false);
            return;
          }
          intervalHandle = scheduleInterval(() => {
            if (stopping) return;
            Promise.resolve()
              .then(() => registry.get('default'))
              .then((session) => session.commit(
                'fixed.tick',
                (owner) => {
                  owner.kernel.setAgentContext?.({
                    worldGeneration: owner.worldGeneration,
                    currentWorldRevision: owner.revision,
                  });
                  return owner.kernel.tick(1 / DOMAIN_CONFIG.sim.tickHz);
                },
              ))
              .then(() => Promise.resolve(audioOwnerController?.expire?.()).catch(() => false))
              .catch(() => stop());
          }, 1000 / DOMAIN_CONFIG.sim.tickHz);
          Promise.resolve(audioSupervisor?.start?.()).catch(() => {});
          resolve(true);
        });
      } catch (error) {
        settled = true;
        server.off?.('error', onError);
        pendingStartErrorHandler = null;
        cancelPendingStart = null;
        started = false;
        reject(error);
      }
    });
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    cancelPendingStart?.();
    if (intervalHandle !== null) {
      clearScheduledInterval(intervalHandle);
      intervalHandle = null;
    }
    stopPromise = (async () => {
      await agents?.close();
      await audioSupervisor?.stop?.();
      await audioGateway?.close?.();
      await legacyRoutes?.close?.();
      const serverClosing = started
        ? closeWithCallback(server)
        : Promise.resolve();
      for (const socket of webSocketServer.clients ?? []) {
        try { socket.close?.(1001, 'RUNTIME_STOPPING'); } catch { /* continue */ }
        try { socket.terminate?.(); } catch { /* continue */ }
      }
      const socketsClosing = closeWithCallback(webSocketServer);
      await socketsClosing;
      if (defaultSession !== null) {
        await defaultSession.runExclusive('runtime.shutdown', (owner) => (
          owner.kernel.dispose()
        ));
      }
      await serverClosing;
      if (pendingStartErrorHandler !== null) {
        server.off?.('error', pendingStartErrorHandler);
        pendingStartErrorHandler = null;
      }
      return true;
    })();
    return stopPromise;
  }

  return Object.freeze({ server, registry, start, stop });
}
