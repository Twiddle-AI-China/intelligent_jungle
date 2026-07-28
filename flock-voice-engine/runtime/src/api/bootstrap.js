import { randomUUID } from 'node:crypto';

import {
  parseCanonicalRawRequestTarget,
  writeOriginPolicyHttpFailure,
} from './origin-policy.js';

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

export function createBootstrapHandler({
  getSession,
  originPolicy,
  clientIdFactory = randomUUID,
  audioStatusStore = null,
  maintenanceAuth = null,
}) {
  if (typeof getSession !== 'function' || typeof originPolicy?.authorize !== 'function') {
    throw new Error('BOOTSTRAP_DEPENDENCIES_REQUIRED');
  }

  return function bootstrapHandler(request, response) {
    const target = parseCanonicalRawRequestTarget(request.url);
    if (request.method !== 'GET' || target?.pathname !== '/api/v1/bootstrap'
        || target.hasQuery) {
      sendJson(response, 404, { error: 'NOT_FOUND' });
      return true;
    }
    const decision = originPolicy.authorize('browserFetch', request);
    if (!decision.allowed) {
      writeOriginPolicyHttpFailure(response, decision);
      return true;
    }

    Promise.resolve()
      .then(() => getSession('default'))
      .then((session) => {
        const input = { clientId: clientIdFactory() };
        return audioStatusStore && typeof session.readBootstrapWithAudioStatus === 'function'
          ? session.readBootstrapWithAudioStatus({ ...input, audioStatusStore })
          : session.readBootstrap(input);
      })
      .then((bootstrap) => {
        const maintenanceCommands = maintenanceAuth?.enabled === true
          ? ['maintenance.authenticate', 'legacy.take', 'legacy.heartbeat', 'legacy.release'] : [];
        const capabilities = maintenanceCommands.length === 0 ? bootstrap.capabilities : {
          ...bootstrap.capabilities,
          commands: [...new Set([...(bootstrap.capabilities?.commands ?? []), ...maintenanceCommands])],
        };
        sendJson(response, 200, { ...bootstrap, ...(capabilities ? { capabilities } : {}),
          ...(audioStatusStore && !bootstrap.audioStatus
            ? { audioStatus: audioStatusStore.get() } : {}) });
      })
      .catch(() => {
        if (!response.headersSent) {
          sendJson(
            response,
            500,
            { error: 'BOOTSTRAP_FAILED' },
          );
        } else {
          response.destroy();
        }
      });
    return true;
  };
}
