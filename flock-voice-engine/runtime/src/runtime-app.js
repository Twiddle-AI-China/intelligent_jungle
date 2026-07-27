import { WebSocketServer } from 'ws';

import { createBootstrapHandler } from './api/bootstrap.js';
import { createRuntimeWsGateway } from './api/runtime-ws.js';
import { PHASE_CONFIG } from './config.js';
import { DOMAIN_CONFIG } from './domain/config.js';
import {
  SIMULATION_CONFIG_REVISION,
  validateSimulationCheckpoint,
} from './domain/simulation-checkpoint.js';
import { createSimulationKernelFactory } from './simulation-runtime.js';
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
  createKernel = createSimulationKernelFactory(),
  createSession = (options) => new WorldSession(options),
  createRegistry = (options) => new WorldSessionRegistry(options),
  createBootstrap = createBootstrapHandler,
  createGateway = createRuntimeWsGateway,
  createWebSocketServer = () => new WebSocketServer({
    noServer: true,
    clientTracking: true,
  }),
  createServer = createCandidateServer,
  scheduleInterval = setInterval,
  clearScheduledInterval = clearInterval,
} = {}) {
  if (!releaseInfo || runtimeConfig.host !== '127.0.0.1') {
    throw new Error('RUNTIME_APP_DEPENDENCIES_INVALID');
  }
  let defaultSession = null;
  const registry = createRegistry({
    createSession: () => {
      defaultSession = createSession({
        seed,
        createKernel,
        validateRestoredSnapshot: (snapshot) => validateSimulationCheckpoint(snapshot, {
          seed,
          configRevision: SIMULATION_CONFIG_REVISION,
        }),
        restoredSnapshot,
        releaseRevision: releaseInfo.releaseRevision,
      });
      return defaultSession;
    },
  });
  const apiHandler = createBootstrap({
    getSession: (worldId) => registry.get(worldId),
    allowedOrigin: runtimeConfig.allowedOrigin,
  });
  const webSocketServer = createWebSocketServer();
  const gateway = createGateway({
    getSession: (worldId) => registry.get(worldId),
    allowedOrigin: runtimeConfig.allowedOrigin,
    webSocketServer,
  });
  let stopping = false;
  let started = false;
  let intervalHandle = null;
  let stopPromise = null;

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
    upgradeHandler,
  });

  function start() {
    if (started) throw new Error('RUNTIME_APP_ALREADY_STARTED');
    if (stopping) throw new Error('RUNTIME_APP_STOPPING');
    started = true;
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off?.('error', onError);
        started = false;
        reject(error);
      };
      server.once?.('error', onError);
      try {
        server.listen(runtimeConfig.port, runtimeConfig.host, () => {
          server.off?.('error', onError);
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
                (owner) => owner.kernel.tick(1 / DOMAIN_CONFIG.sim.tickHz),
              ))
              .catch(() => stop());
          }, 1000 / DOMAIN_CONFIG.sim.tickHz);
          resolve(true);
        });
      } catch (error) {
        server.off?.('error', onError);
        started = false;
        reject(error);
      }
    });
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    if (intervalHandle !== null) {
      clearScheduledInterval(intervalHandle);
      intervalHandle = null;
    }
    stopPromise = (async () => {
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
      return true;
    })();
    return stopPromise;
  }

  return Object.freeze({ server, registry, start, stop });
}
