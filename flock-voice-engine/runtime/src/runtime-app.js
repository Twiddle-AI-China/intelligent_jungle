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
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error !== undefined
          && error !== null
          && error?.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    };
    try {
      target[method](finish);
    } catch (error) {
      finish(error);
    }
  });
}

function settledOperation(operation) {
  return Promise.resolve()
    .then(operation)
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
}

function throwCleanupFailures(failures) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'RUNTIME_APP_STOP_FAILED',
    );
  }
}

function exactFrozenOriginSeam(candidate, originPolicy, requiredMethods) {
  if (candidate === null) return true;
  try {
    if (!Object.isFrozen(candidate)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    if (descriptors.originPolicy?.value !== originPolicy) return false;
    return requiredMethods.every((name) => typeof descriptors[name]?.value === 'function');
  } catch {
    return false;
  }
}

export function createRuntimeApp({
  runtimeConfig = PHASE_CONFIG,
  originPolicy,
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
    // Runtime frames are repetitive JSON snapshots.  Compress them at the WS
    // boundary so they do not compete with PCM for tunnel bandwidth.
    perMessageDeflate: {
      threshold: 1_024,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
    },
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
  staticUi = null,
  getFaultClientRegistry = null,
  faultTransportRecorder = null,
  onFaultReconnectGrant = null,
  getFaultClientActuator = null,
  onFatal = null,
  onStopping = null,
} = {}) {
  const fixedLocalBinding = runtimeConfig.host === '127.0.0.1'
    || (runtimeConfig.host === '0.0.0.0' && runtimeConfig.port === 8090
      && ['phase5-local', 'phase5-production'].includes(
        runtimeConfig.phaseGate,
      ));
  if (!releaseInfo || !fixedLocalBinding
    || typeof originPolicy?.authorize !== 'function'
    || !Object.isFrozen(originPolicy)
    || !(agents === null || (
      typeof agents.close === 'function'
      && typeof agents.getPublicState === 'function'
    ))
    || !exactFrozenOriginSeam(staticUi, originPolicy, ['handleHttp'])
    || !exactFrozenOriginSeam(audioGateway, originPolicy, ['handleUpgrade', 'close'])
    || !exactFrozenOriginSeam(legacyRoutes, originPolicy, ['handleHttp', 'handleUpgrade', 'close'])
    || !(onFatal === null || typeof onFatal === 'function')
    || !(getFaultClientRegistry === null
      || typeof getFaultClientRegistry === 'function')
    || !(faultTransportRecorder === null
      || typeof faultTransportRecorder === 'object')
    || !(onFaultReconnectGrant === null
      || typeof onFaultReconnectGrant === 'function')
    || !(getFaultClientActuator === null
      || typeof getFaultClientActuator === 'function')
    || !(onStopping === null || typeof onStopping === 'function')) {
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
    originPolicy,
    audioStatusStore,
    maintenanceAuth,
    audioOwner: audioOwnerController,
    getFaultClientRegistry,
    faultTransportRecorder,
    onFaultReconnectGrant,
    getFaultClientActuator,
  });
  const latentRoutes = createLatentMapRoutes({
    getPublicMap: (voice) => Promise.resolve(registry.get('default'))
      .then((session) => session.runExclusive(
        'latent.map.read',
        (owner) => owner.kernel.getLatentMap(voice),
      )),
    originPolicy,
  });
  const webSocketServer = createWebSocketServer();
  const gateway = createGateway({
    getSession: (worldId) => registry.get(worldId),
    originPolicy,
    webSocketServer,
    audioStatusStore,
    maintenanceAuth,
    audioOwner: audioOwnerController,
    getFaultClientRegistry,
    faultTransportRecorder,
    onFaultReconnectGrant,
    getFaultClientActuator,
    normalDeliveryBatchSize: 3,
  });
  let stopping = false;
  let started = false;
  let intervalHandle = null;
  let stopPromise = null;
  let cancelPendingStart = null;
  let pendingStartErrorHandler = null;
  let serverErrorHandlerInstalled = false;
  let stoppingHookResult = null;
  let fatalObserved = false;

  function beginStoppingHook() {
    if (stoppingHookResult !== null) return stoppingHookResult;
    let settleHook;
    stoppingHookResult = new Promise((resolve) => {
      settleHook = resolve;
    });
    if (onStopping === null) {
      settleHook({ ok: true });
      return stoppingHookResult;
    }
    try {
      const pending = onStopping();
      void Promise.resolve(pending).then(
        () => settleHook({ ok: true }),
        (error) => settleHook({ ok: false, error }),
      );
    } catch (error) {
      settleHook({
        ok: false,
        error,
      });
    }
    return stoppingHookResult;
  }

  function upgradeHandler(request, socket, head) {
    if (stopping) {
      socket.destroy?.();
      return;
    }
    gateway.handleUpgrade(request, socket, head);
  }

  function reportFatal(error) {
    if (fatalObserved) return;
    fatalObserved = true;
    try {
      const notification = onFatal?.(error);
      void Promise.resolve(notification).catch(() => {});
    } catch {
      // The runtime still has to close every owner after a fatal sink bug.
    }
    void stop().catch(() => {
      // The fatal sink owns process status; stop() retains the cleanup error.
    });
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
    staticUi,
    originPolicy,
  });

  function onServerError(error) {
    const pending = pendingStartErrorHandler;
    if (pending !== null) {
      pending(error);
      return;
    }
    if (started && !stopping) reportFatal(error);
  }

  function start() {
    if (started) throw new Error('RUNTIME_APP_ALREADY_STARTED');
    if (stopping) throw new Error('RUNTIME_APP_STOPPING');
    started = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const onError = (error) => {
        if (settled) return;
        settled = true;
        pendingStartErrorHandler = null;
        cancelPendingStart = null;
        started = false;
        reject(error);
      };
      const settleStoppedStart = () => {
        if (settled) return;
        settled = true;
        pendingStartErrorHandler = null;
        cancelPendingStart = null;
        resolve(false);
      };
      cancelPendingStart = settleStoppedStart;
      pendingStartErrorHandler = onError;
      try {
        if (!serverErrorHandlerInstalled) {
          if (typeof server.on !== 'function'
              || typeof server.off !== 'function') {
            throw new Error('RUNTIME_HTTP_SERVER_INVALID');
          }
          server.on('error', onServerError);
          serverErrorHandlerInstalled = true;
        }
        server.listen(runtimeConfig.port, runtimeConfig.host, () => {
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
              .catch(reportFatal);
          }, 1000 / DOMAIN_CONFIG.sim.tickHz);
          Promise.resolve(audioSupervisor?.start?.()).catch(() => {});
          resolve(true);
        });
      } catch (error) {
        settled = true;
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
    let resolveStop;
    let rejectStop;
    stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    const hookResult = beginStoppingHook();
    cancelPendingStart?.();
    if (intervalHandle !== null) {
      clearScheduledInterval(intervalHandle);
      intervalHandle = null;
    }
    const serverClosing = settledOperation(() => (
      started ? closeWithCallback(server) : undefined
    ));
    const socketsClosing = settledOperation(() => {
      for (const socket of webSocketServer.clients ?? []) {
        try { socket.close?.(1001, 'RUNTIME_STOPPING'); } catch { /* continue */ }
        try { socket.terminate?.(); } catch { /* continue */ }
      }
      return closeWithCallback(webSocketServer);
    });
    void (async () => {
      const failures = [];
      for (const operation of [
        () => agents?.close(),
        () => audioSupervisor?.stop?.(),
        () => audioGateway?.close?.(),
        () => legacyRoutes?.close?.(),
      ]) {
        const result = await settledOperation(operation);
        if (!result.ok) failures.push(result.error);
      }
      const socketResult = await socketsClosing;
      if (!socketResult.ok) failures.push(socketResult.error);
      if (defaultSession !== null) {
        const sessionResult = await settledOperation(
          () => defaultSession.runExclusive(
            'runtime.shutdown',
            (owner) => owner.kernel.dispose(),
          ),
        );
        if (!sessionResult.ok) failures.push(sessionResult.error);
      }
      const serverResult = await serverClosing;
      if (!serverResult.ok) failures.push(serverResult.error);
      if (pendingStartErrorHandler !== null) {
        pendingStartErrorHandler = null;
      }
      if (serverErrorHandlerInstalled) {
        server.off('error', onServerError);
        serverErrorHandlerInstalled = false;
      }
      const stoppingHook = await hookResult;
      if (!stoppingHook.ok) failures.push(stoppingHook.error);
      throwCleanupFailures(failures);
      return true;
    })().then(resolveStop, rejectStop);
    return stopPromise;
  }

  return Object.freeze({ server, registry, start, stop });
}
