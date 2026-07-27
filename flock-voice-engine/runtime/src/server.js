import { createServer } from 'node:http';

import { projectAgentStatus } from './agents/status-projector.js';

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function safeAgentProviders(getAgentState) {
  if (typeof getAgentState !== 'function') return undefined;
  try {
    const projected = projectAgentStatus(getAgentState());
    return { species: projected.species, master: projected.master };
  } catch {
    const projected = projectAgentStatus(null);
    return { species: projected.species, master: projected.master };
  }
}

export function createCandidateServer({
  releaseInfo, apiHandler, latentRoutes, upgradeHandler, audioUpgradeHandler = null,
  getAgentState, audioStatusStore = null,
  getAudioSupervisorStatus = null,
  phaseGate = audioStatusStore ? 'phase5-local' : 'shadow-no-audio',
}) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    if (request.method === 'GET' && pathname === '/healthz') {
      const audioStatus = audioStatusStore?.get?.();
      const worker = getAudioSupervisorStatus?.();
      sendJson(response, 200, {
        ...releaseInfo,
        workerReady: audioStatus?.workerReady === true,
        ...(worker ? { expectedWorkerIdentity: worker.expectedIdentity ?? null,
          reportedWorkerIdentity: worker.reportedIdentity ?? null,
          workerMismatchReason: worker.mismatchReason ?? null } : {}),
        ...(audioStatus ? { audioStatus } : {}),
        ...(getAgentState ? { agentProviders: safeAgentProviders(getAgentState) } : {}),
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/readyz') {
      const audioStatus = audioStatusStore?.get?.();
      const ready = audioStatus?.workerReady === true && audioStatus?.recovering === false
        && audioStatus?.degraded === false;
      sendJson(response, ready ? 200 : 503, {
        ...releaseInfo,
        workerReady: ready,
        phaseGate,
        ...(audioStatus ? { audioStatus } : {}),
        ...(getAgentState ? { agentProviders: safeAgentProviders(getAgentState) } : {}),
      });
      return;
    }

    if (pathname.startsWith('/api/v1/latent-maps/')) {
      if (latentRoutes) latentRoutes(request, response);
      else sendJson(response, 404, { error: 'NOT_FOUND' });
      return;
    }

    if (apiHandler && apiHandler(request, response) !== false) {
      return;
    }

    sendJson(response, 404, { error: 'NOT_FOUND' });
  });

  if (upgradeHandler || audioUpgradeHandler) server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/api/v1/audio' && audioUpgradeHandler) {
      audioUpgradeHandler(request, socket, head);
    } else if (upgradeHandler) upgradeHandler(request, socket, head);
    else socket.destroy?.();
  });
  return server;
}
