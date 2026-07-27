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
  releaseInfo, apiHandler, upgradeHandler, getAgentState,
}) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    if (request.method === 'GET' && pathname === '/healthz') {
      sendJson(response, 200, {
        ...releaseInfo,
        workerReady: false,
        ...(getAgentState ? { agentProviders: safeAgentProviders(getAgentState) } : {}),
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/readyz') {
      sendJson(response, 503, {
        ...releaseInfo,
        workerReady: false,
        phaseGate: 'shadow-no-audio',
        ...(getAgentState ? { agentProviders: safeAgentProviders(getAgentState) } : {}),
      });
      return;
    }

    if (apiHandler && apiHandler(request, response) !== false) {
      return;
    }

    sendJson(response, 404, { error: 'NOT_FOUND' });
  });

  if (upgradeHandler) server.on('upgrade', upgradeHandler);
  return server;
}
