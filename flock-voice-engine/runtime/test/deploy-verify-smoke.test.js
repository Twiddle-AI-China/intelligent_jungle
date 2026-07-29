import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

const CANDIDATE_ORIGIN = 'http://127.0.0.1:18090';
const CANDIDATE_AUTHORITY = '127.0.0.1:18090';
const SMOKE_SCRIPT = fileURLToPath(
  new URL('../../deploy/verify-smoke.mjs', import.meta.url),
);

function json(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function runSmoke(env = process.env, timeoutMilliseconds = 12_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SMOKE_SCRIPT, CANDIDATE_ORIGIN], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('SMOKE_PROCESS_TIMEOUT'));
    }, timeoutMilliseconds);
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

test('candidate browser smoke uses one exact 18090 Host/Origin for HTTP and websocket surfaces',
  async () => {
    const observed = [];
    const proxyRequests = [];
    const sockets = new Set();
    const proxySockets = new Set();
    const webSocketServer = new WebSocketServer({ noServer: true });
    const proxyServer = createServer((request, response) => {
      proxyRequests.push(request.url);
      json(response, 502, { error: 'PROXY_MUST_NOT_BE_USED' });
    });
    proxyServer.on('connection', (socket) => {
      proxySockets.add(socket);
      socket.once('close', () => proxySockets.delete(socket));
    });
    const server = createServer((request, response) => {
      observed.push({
        kind: 'http',
        path: request.url,
        host: request.headers.host,
        origin: request.headers.origin,
      });
      if (request.headers.host !== CANDIDATE_AUTHORITY
          || request.headers.origin !== CANDIDATE_ORIGIN) {
        json(response, 403, { error: 'REQUEST_FORBIDDEN' });
        return;
      }
      if (request.url === '/api/v1/bootstrap') {
        json(response, 200, {
          clientId: 'client-7',
          bootstrapToken: 'bootstrap-7',
          worldGeneration: 'world-7',
          revision: 11,
          eventSeq: 13,
          snapshot: { worldGeneration: 'world-7' },
        });
        return;
      }
      if (request.url === '/api/decoder-status') {
        json(response, 200, { mode: 'backend-owned' });
        return;
      }
      json(response, 404, { error: 'NOT_FOUND' });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      observed.push({
        kind: 'websocket',
        path: request.url,
        host: request.headers.host,
        origin: request.headers.origin,
      });
      if (request.headers.host !== CANDIDATE_AUTHORITY
          || request.headers.origin !== CANDIDATE_ORIGIN) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    });
    webSocketServer.on('connection', (webSocket, request) => {
      if (request.url === '/api/v1/runtime') {
        webSocket.once('message', () => webSocket.send(JSON.stringify({ type: 'ready' })));
        return;
      }
      if (request.url === '/api/v1/audio') {
        const frame = Buffer.alloc(24);
        frame.writeUInt32LE(17, 12);
        frame.writeBigUInt64LE(23n, 16);
        webSocket.send(JSON.stringify({
          type: 'audio.ready',
          blockSeq: 17,
          resumeStartFrame: '23',
        }));
        webSocket.send(frame);
        return;
      }
      if (request.url === '/decoder') {
        webSocket.once('message', () => webSocket.send(JSON.stringify({
          type: 'error',
          code: 'LEGACY_LEASE_REQUIRED',
        })));
      }
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(18090, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => {
      proxyServer.once('error', reject);
      proxyServer.listen(0, '127.0.0.1', resolve);
    });

    try {
      const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;
      const result = await runSmoke({
        ...process.env,
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        NO_PROXY: '',
        NODE_USE_ENV_PROXY: '1',
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        no_proxy: '',
      });
      assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' });
      assert.deepEqual(proxyRequests, []);
      assert.deepEqual(
        observed.map(({ kind, path }) => [kind, path]),
        [
          ['http', '/api/v1/bootstrap'],
          ['http', '/api/decoder-status'],
          ['websocket', '/api/v1/runtime'],
          ['websocket', '/api/v1/audio'],
          ['websocket', '/decoder'],
        ],
      );
      for (const request of observed) {
        assert.equal(request.host, CANDIDATE_AUTHORITY);
        assert.equal(request.origin, CANDIDATE_ORIGIN);
      }
    } finally {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise((resolve) => webSocketServer.close(resolve));
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      for (const socket of proxySockets) socket.destroy();
      await new Promise((resolve) => proxyServer.close(resolve));
    }
  });

test('candidate browser smoke tears down an opened runtime socket after a bounded failure',
  async () => {
    const webSocketServer = new WebSocketServer({ noServer: true });
    const server = createServer((request, response) => {
      if (request.url === '/api/v1/bootstrap') {
        json(response, 200, {
          clientId: 'client-timeout',
          bootstrapToken: 'bootstrap-timeout',
          worldGeneration: 'world-timeout',
          revision: 0,
          eventSeq: 0,
          snapshot: { worldGeneration: 'world-timeout' },
        });
        return;
      }
      if (request.url === '/api/decoder-status') {
        json(response, 200, { mode: 'backend-owned' });
        return;
      }
      json(response, 404, { error: 'NOT_FOUND' });
    });
    server.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(18090, '127.0.0.1', resolve);
    });
    try {
      const result = await runSmoke(process.env, 9_000);
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /RUNTIME_WS_READY_TIMEOUT/);
    } finally {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise((resolve) => webSocketServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  });
