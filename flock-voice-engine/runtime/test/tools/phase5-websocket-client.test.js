import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WebSocketServer } from 'ws';

import Phase5WebSocket from '../../tools/lib/phase5-websocket-client.mjs';

test('closure-owned websocket client presents capability and preserves frame kinds', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const observed = {};
  server.on('connection', (socket, request) => {
    observed.origin = request.headers.origin;
    observed.capability = request.headers['x-flock-phase5-client-capability'];
    socket.send('ready');
    socket.send(Buffer.from([1, 2, 3]));
    socket.once('message', (body, binary) => {
      observed.message = body.toString();
      observed.binary = binary;
      socket.close(1000, 'complete');
    });
  });

  try {
    const { port } = server.address();
    const client = new Phase5WebSocket(
      `ws://127.0.0.1:${port}/api/v1/runtime`,
      {
        origin: 'http://127.0.0.1:18090',
        headers: { 'x-flock-phase5-client-capability': 'opaque-capability' },
      },
    );
    const frames = [];
    client.on('message', (body, binary) => {
      frames.push([Buffer.from(body), binary]);
      if (frames.length === 2) client.send('hello');
    });
    const closed = await new Promise((resolve, reject) => {
      client.once('error', reject);
      client.once('close', (code, reason) => resolve([code, reason.toString()]));
    });

    assert.deepEqual(frames, [
      [Buffer.from('ready'), false],
      [Buffer.from([1, 2, 3]), true],
    ]);
    assert.deepEqual(closed, [1000, 'complete']);
    assert.deepEqual(observed, {
      origin: 'http://127.0.0.1:18090',
      capability: 'opaque-capability',
      message: 'hello',
      binary: false,
    });
    assert.equal(typeof client._socket.pause, 'function');
    assert.equal(typeof client._socket.resume, 'function');
    assert.equal(typeof client._socket.isPaused, 'function');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
