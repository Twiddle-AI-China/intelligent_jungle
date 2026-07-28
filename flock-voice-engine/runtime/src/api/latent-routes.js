import {
  parseCanonicalRawRequestTarget,
  writeOriginPolicyHttpFailure,
} from './origin-policy.js';

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function createLatentRoutes({ getPublicMap, mapRepository, latentRuntime, originPolicy } = {}) {
  const read = getPublicMap ?? ((voice) => mapRepository.getPublicMap(
    voice,
    latentRuntime.getPublicState()[voice],
  ));
  if (typeof read !== 'function' || typeof originPolicy?.authorize !== 'function') {
    throw new Error('LATENT_ROUTES_CONFIG_INVALID');
  }
  return function latentRoutes(request, response) {
    const target = parseCanonicalRawRequestTarget(request.url);
    const match = target !== null && !target.hasQuery
      ? /^\/api\/v1\/latent-maps\/(bass|pad|melody)$/.exec(target.pathname)
      : null;
    if (request.method !== 'GET' || !match) {
      sendJson(response, 404, { error: 'NOT_FOUND' });
      return true;
    }
    const decision = originPolicy.authorize('browserFetch', request);
    if (!decision.allowed) {
      writeOriginPolicyHttpFailure(response, decision);
      return true;
    }
    Promise.resolve()
      .then(() => read(match[1]))
      .then((dto) => sendJson(response, 200, dto))
      .catch(() => {
        if (!response.headersSent) sendJson(response, 404, { error: 'LATENT_MAP_NOT_FOUND' });
        else response.destroy();
      });
    return true;
  };
}
