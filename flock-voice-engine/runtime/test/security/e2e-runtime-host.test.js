import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import test from 'node:test';

import { createBootstrapHandler } from '../../src/api/bootstrap.js';
import {
  authorizeExactIpv4LoopbackTransport,
  createOriginPolicy,
} from '../../src/api/origin-policy.js';
import { createCandidateServer } from '../../src/server.js';
import { listenLoopbackPortMap } from '../fixtures/e2e-runtime-host.mjs';

const BROWSER_ORIGIN = 'http://127.0.0.1:18090';
const OPS_AUTHORITY = '127.0.0.1:8090';

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((done) => server.close(done));
}

function rawHttp(port, headers) {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    socket.on('connect', () => {
      socket.write([
        ...headers,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const boundary = raw.indexOf('\r\n\r\n');
      const head = boundary === -1 ? raw : raw.slice(0, boundary);
      const body = boundary === -1 ? '' : raw.slice(boundary + 4);
      const match = /^HTTP\/1\.1 ([0-9]{3}) /.exec(head);
      if (!match) {
        rejectResponse(new Error('RAW_HTTP_RESPONSE_INVALID'));
        return;
      }
      resolveResponse({
        status: Number(match[1]),
        body: body.length === 0 ? null : JSON.parse(body),
      });
    });
    socket.on('error', rejectResponse);
  });
}

test('public loopback map cannot forge exact internal ops transport', async (context) => {
  const originPolicy = createOriginPolicy({
    canonicalOrigin: BROWSER_ORIGIN,
    opsAuthorities: [OPS_AUTHORITY],
    authorizeOperationalTransport: authorizeExactIpv4LoopbackTransport,
  });
  const bootstrapHandler = createBootstrapHandler({
    originPolicy,
    clientIdFactory: () => 'fixture-client',
    getSession: async () => ({
      readBootstrap: () => ({
        clientId: 'fixture-client',
        bootstrapToken: 'fixture-bootstrap-token',
        worldGeneration: 'fixture-world',
        revision: 0,
        eventSeq: 0,
      }),
    }),
  });
  const server = createCandidateServer({
    releaseInfo: Object.freeze({
      releaseRevision: 'fixture',
      runtimeOwner: 'server',
      audioOwner: 'world',
    }),
    apiHandler: bootstrapHandler,
    originPolicy,
  });
  let portMap = null;
  await listen(server, 0);
  const internalPort = server.address().port;
  portMap = await listenLoopbackPortMap({
    publicPort: 0,
    internalPort,
  });
  context.after(async () => {
    await portMap.close();
    await closeServer(server);
  });
  assert.equal(Number.isSafeInteger(portMap.publicPort), true);
  assert.equal(portMap.publicPort > 0, true);

  const directOps = await rawHttp(internalPort, [
    'GET /healthz HTTP/1.1',
    `Host: ${OPS_AUTHORITY}`,
  ]);
  assert.equal(directOps.status, 200);

  const forgedPublicOps = await rawHttp(portMap.publicPort, [
    'GET /healthz HTTP/1.1',
    `Host: ${OPS_AUTHORITY}`,
  ]);
  assert.equal(forgedPublicOps.status, 403);

  const browserBootstrap = await rawHttp(portMap.publicPort, [
    'GET /api/v1/bootstrap HTTP/1.1',
    'Host: 127.0.0.1:18090',
    `Origin: ${BROWSER_ORIGIN}`,
  ]);
  assert.equal(browserBootstrap.status, 200);
  assert.equal(browserBootstrap.body.clientId, 'fixture-client');
});
