function sendJson(response, statusCode, body, allowedOrigin) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'access-control-allow-origin': allowedOrigin,
    vary: 'Origin',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function createLatentRoutes({ getPublicMap, mapRepository, latentRuntime, allowedOrigin } = {}) {
  const read = getPublicMap ?? ((voice) => mapRepository.getPublicMap(
    voice,
    latentRuntime.getPublicState()[voice],
  ));
  if (typeof read !== 'function' || typeof allowedOrigin !== 'string') {
    throw new Error('LATENT_ROUTES_CONFIG_INVALID');
  }
  return function latentRoutes(request, response) {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const match = /^\/api\/v1\/latent-maps\/(bass|pad|melody)$/.exec(pathname);
    if (request.method !== 'GET' || !match) {
      sendJson(response, 404, { error: 'NOT_FOUND' }, allowedOrigin);
      return true;
    }
    if (request.headers.origin !== allowedOrigin) {
      sendJson(response, 403, { error: 'ORIGIN_FORBIDDEN' }, allowedOrigin);
      return true;
    }
    Promise.resolve()
      .then(() => read(match[1]))
      .then((dto) => sendJson(response, 200, dto, allowedOrigin))
      .catch(() => {
        if (!response.headersSent) sendJson(response, 404, { error: 'LATENT_MAP_NOT_FOUND' }, allowedOrigin);
        else response.destroy();
      });
    return true;
  };
}
