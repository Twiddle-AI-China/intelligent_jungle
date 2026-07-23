import { randomUUID } from 'node:crypto';

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

export function createBootstrapHandler({
  getSession,
  allowedOrigin,
  clientIdFactory = randomUUID,
}) {
  if (typeof getSession !== 'function' || typeof allowedOrigin !== 'string') {
    throw new Error('BOOTSTRAP_DEPENDENCIES_REQUIRED');
  }

  return function bootstrapHandler(request, response) {
    const pathname = new URL(
      request.url ?? '/',
      'http://127.0.0.1',
    ).pathname;
    if (request.method !== 'GET' || pathname !== '/api/v1/bootstrap') {
      sendJson(response, 404, { error: 'NOT_FOUND' }, allowedOrigin);
      return true;
    }
    if (request.headers.origin !== allowedOrigin) {
      sendJson(response, 403, { error: 'ORIGIN_FORBIDDEN' }, allowedOrigin);
      return true;
    }

    Promise.resolve()
      .then(() => getSession('default'))
      .then((session) => session.readBootstrap({
        clientId: clientIdFactory(),
      }))
      .then((bootstrap) => {
        sendJson(response, 200, bootstrap, allowedOrigin);
      })
      .catch(() => {
        if (!response.headersSent) {
          sendJson(
            response,
            500,
            { error: 'BOOTSTRAP_FAILED' },
            allowedOrigin,
          );
        } else {
          response.destroy();
        }
      });
    return true;
  };
}
