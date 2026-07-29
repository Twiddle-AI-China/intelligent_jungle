import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  CANDIDATE_BROWSER_ORIGIN,
  openCandidateRuntimeSocket,
  readCandidateBootstrap,
} from '../../tools/lib/candidate-browser-transport.mjs';

const PROXY_ENVIRONMENT_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
  'NO_PROXY', 'no_proxy',
];

function createAgentHarness() {
  const instances = [];
  class FakeAgent {
    constructor(options) {
      this.options = options;
      this.destroyCalls = 0;
      instances.push(this);
    }

    destroy() {
      this.destroyCalls += 1;
    }
  }
  return { FakeAgent, instances };
}

function createTimerHarness() {
  const timers = [];
  return {
    timers,
    setTimeoutImpl(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      if (timer) timer.cleared = true;
    },
    fire(index = 0) {
      const timer = timers[index];
      assert.ok(timer, `timer ${index} was not scheduled`);
      timer.callback();
    },
  };
}

function createResponse({
  statusCode = 200,
  headers = {},
} = {}) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.headers = headers;
  response.destroyCalls = 0;
  response.destroy = () => {
    response.destroyCalls += 1;
  };
  return response;
}

function createHttpHarness() {
  const request = new EventEmitter();
  request.destroyCalls = 0;
  request.endCalls = 0;
  request.destroy = () => {
    request.destroyCalls += 1;
  };
  request.end = () => {
    request.endCalls += 1;
  };
  const calls = [];
  let respond;
  const httpRequest = (options, onResponse) => {
    calls.push(options);
    respond = (response) => onResponse(response);
    return request;
  };
  return {
    calls,
    httpRequest,
    request,
    respond(response) {
      assert.equal(typeof respond, 'function', 'HTTP request was not created');
      respond(response);
    },
  };
}

function createWebSocketHarness() {
  const instances = [];
  class FakeWebSocket extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.readyState = FakeWebSocket.CONNECTING;
      this.closeCalls = [];
      this.terminateCalls = 0;
      instances.push(this);
    }

    close(...args) {
      this.closeCalls.push(args);
      this.readyState = FakeWebSocket.CLOSING;
    }

    terminate() {
      this.terminateCalls += 1;
      this.readyState = FakeWebSocket.CLOSED;
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  return { FakeWebSocket, instances };
}

async function withPoisonedProxyEnvironment(operation) {
  const priorEnvironment = Object.fromEntries(
    PROXY_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    process.env[key] = key.toLowerCase().includes('no_proxy')
      ? ''
      : 'http://192.0.2.1:9';
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertFixedFailure(code) {
  return (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.message, code);
    return true;
  };
}

test('direct exact-origin transports ignore proxy environment and disposer is idempotent',
  async () => {
    const agents = createAgentHarness();
    const http = createHttpHarness();
    const httpTimers = createTimerHarness();
    const sockets = createWebSocketHarness();
    const socketTimers = createTimerHarness();

    await withPoisonedProxyEnvironment(async () => {
      const bootstrapPending = readCandidateBootstrap({
        httpRequest: http.httpRequest,
        HttpAgent: agents.FakeAgent,
        setTimeoutImpl: httpTimers.setTimeoutImpl,
        clearTimeoutImpl: httpTimers.clearTimeoutImpl,
      });
      const body = JSON.stringify({
        clientId: 'client-1',
        bootstrapToken: 'bootstrap-secret',
        worldGeneration: 'world-1',
        revision: 1,
        eventSeq: 2,
      });
      const response = createResponse({
        headers: { 'content-length': String(Buffer.byteLength(body)) },
      });
      http.respond(response);
      response.emit('data', Buffer.from(body));
      response.emit('end');
      const bootstrap = await bootstrapPending;

      assert.equal(bootstrap.bootstrapToken, 'bootstrap-secret');
      assert.deepEqual(http.calls, [{
        protocol: 'http:',
        hostname: '127.0.0.1',
        port: 18090,
        method: 'GET',
        path: '/api/v1/bootstrap',
        headers: {
          Host: '127.0.0.1:18090',
          Origin: CANDIDATE_BROWSER_ORIGIN,
          Accept: 'application/json',
        },
        agent: agents.instances[0],
        localAddress: '127.0.0.1',
        setHost: false,
      }]);
      assert.deepEqual(agents.instances[0].options, {
        keepAlive: false,
        localAddress: '127.0.0.1',
      });
      assert.equal(agents.instances[0].destroyCalls, 1);
      assert.equal(http.request.endCalls, 1);
      assert.equal(http.request.destroyCalls, 0);
      assert.equal(response.destroyCalls, 0);
      assert.equal(httpTimers.timers[0].cleared, true);

      const socketPending = openCandidateRuntimeSocket({
        WebSocket: sockets.FakeWebSocket,
        HttpAgent: agents.FakeAgent,
        setTimeoutImpl: socketTimers.setTimeoutImpl,
        clearTimeoutImpl: socketTimers.clearTimeoutImpl,
      });
      const socket = sockets.instances[0];
      socket.readyState = sockets.FakeWebSocket.OPEN;
      socket.emit('open');
      const transport = await socketPending;

      assert.equal(transport.socket, socket);
      assert.equal(socket.url, 'ws://127.0.0.1:18090/api/v1/runtime');
      assert.deepEqual(socket.options, {
        origin: CANDIDATE_BROWSER_ORIGIN,
        agent: agents.instances[1],
        followRedirects: false,
        handshakeTimeout: 5_000,
      });
      assert.deepEqual(agents.instances[1].options, {
        keepAlive: false,
        localAddress: '127.0.0.1',
      });

      transport.closeTransport();
      transport.closeTransport();

      assert.equal(socket.terminateCalls, 1);
      assert.equal(agents.instances[1].destroyCalls, 1);
      assert.equal(socketTimers.timers[0].cleared, true);
    });
  });

test('bootstrap redirect rejects without following and closes every owned resource',
  async () => {
    const agents = createAgentHarness();
    const http = createHttpHarness();
    const timers = createTimerHarness();
    const pending = readCandidateBootstrap({
      httpRequest: http.httpRequest,
      HttpAgent: agents.FakeAgent,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const response = createResponse({
      statusCode: 302,
      headers: { location: 'http://example.invalid/redirected' },
    });

    http.respond(response);

    await assert.rejects(
      pending,
      assertFixedFailure('CANDIDATE_BOOTSTRAP_FAILED'),
    );
    assert.equal(http.calls.length, 1);
    assert.equal(response.destroyCalls, 1);
    assert.equal(http.request.destroyCalls, 1);
    assert.equal(agents.instances[0].destroyCalls, 1);
    assert.equal(timers.timers[0].cleared, true);
  });

test('bootstrap timeout aborts request and destroys agent before rejecting', async () => {
  const agents = createAgentHarness();
  const http = createHttpHarness();
  const timers = createTimerHarness();
  const pending = readCandidateBootstrap({
    httpRequest: http.httpRequest,
    HttpAgent: agents.FakeAgent,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  assert.equal(timers.timers[0].delay, 5_000);
  timers.fire();

  await assert.rejects(
    pending,
    assertFixedFailure('CANDIDATE_BOOTSTRAP_FAILED'),
  );
  assert.equal(http.request.destroyCalls, 1);
  assert.equal(agents.instances[0].destroyCalls, 1);
  assert.equal(timers.timers[0].cleared, true);
});

test('bootstrap destroys a response delivered after timeout cleanup', async () => {
  const agents = createAgentHarness();
  const http = createHttpHarness();
  const timers = createTimerHarness();
  const pending = readCandidateBootstrap({
    httpRequest: http.httpRequest,
    HttpAgent: agents.FakeAgent,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  timers.fire();
  await assert.rejects(
    pending,
    assertFixedFailure('CANDIDATE_BOOTSTRAP_FAILED'),
  );
  const lateResponse = createResponse();
  http.respond(lateResponse);

  assert.equal(lateResponse.destroyCalls, 1);
  assert.equal(http.request.destroyCalls, 1);
  assert.equal(agents.instances[0].destroyCalls, 1);
});

test('bootstrap streaming body over 64 KiB aborts response request and agent', async () => {
  const agents = createAgentHarness();
  const http = createHttpHarness();
  const timers = createTimerHarness();
  const pending = readCandidateBootstrap({
    httpRequest: http.httpRequest,
    HttpAgent: agents.FakeAgent,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const response = createResponse();

  http.respond(response);
  response.emit('data', Buffer.alloc(65_537));

  await assert.rejects(
    pending,
    assertFixedFailure('CANDIDATE_BOOTSTRAP_FAILED'),
  );
  assert.equal(response.destroyCalls, 1);
  assert.equal(http.request.destroyCalls, 1);
  assert.equal(agents.instances[0].destroyCalls, 1);
});

test('bootstrap request error aborts request and agent exactly once', async () => {
  const agents = createAgentHarness();
  const http = createHttpHarness();
  const timers = createTimerHarness();
  const pending = readCandidateBootstrap({
    httpRequest: http.httpRequest,
    HttpAgent: agents.FakeAgent,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  http.request.emit('error', new Error('ECONNRESET'));
  http.request.emit('error', new Error('late duplicate error'));

  await assert.rejects(
    pending,
    assertFixedFailure('CANDIDATE_BOOTSTRAP_FAILED'),
  );
  assert.equal(http.request.destroyCalls, 1);
  assert.equal(agents.instances[0].destroyCalls, 1);
});

test('runtime socket redirect closes response socket and agent without following',
  async () => {
    const agents = createAgentHarness();
    const sockets = createWebSocketHarness();
    const timers = createTimerHarness();
    const pending = openCandidateRuntimeSocket({
      WebSocket: sockets.FakeWebSocket,
      HttpAgent: agents.FakeAgent,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    const socket = sockets.instances[0];
    const response = createResponse({
      statusCode: 302,
      headers: { location: 'ws://example.invalid/redirected' },
    });

    socket.emit('unexpected-response', {}, response);

    await assert.rejects(
      Promise.race([
        pending,
        new Promise((_, reject) => {
          setImmediate(() => reject(new Error('redirect was not rejected immediately')));
        }),
      ]),
      assertFixedFailure('CANDIDATE_RUNTIME_SOCKET_FAILED'),
    );
    assert.equal(response.destroyCalls, 1);
    assert.equal(socket.terminateCalls, 1);
    assert.equal(agents.instances[0].destroyCalls, 1);
    assert.equal(timers.timers[0].cleared, true);
  });

test('runtime socket error terminates socket and agent exactly once', async () => {
  const agents = createAgentHarness();
  const sockets = createWebSocketHarness();
  const timers = createTimerHarness();
  const pending = openCandidateRuntimeSocket({
    WebSocket: sockets.FakeWebSocket,
    HttpAgent: agents.FakeAgent,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const socket = sockets.instances[0];

  socket.emit('error', new Error('ECONNRESET'));
  socket.emit('error', new Error('late duplicate error'));

  await assert.rejects(
    pending,
    assertFixedFailure('CANDIDATE_RUNTIME_SOCKET_FAILED'),
  );
  assert.equal(socket.terminateCalls, 1);
  assert.equal(agents.instances[0].destroyCalls, 1);
  assert.equal(timers.timers[0].cleared, true);
});

test('runtime socket timeout terminates socket and agent before rejecting', async () => {
  const agents = createAgentHarness();
  const sockets = createWebSocketHarness();
  const timers = createTimerHarness();
  const pending = openCandidateRuntimeSocket({
    WebSocket: sockets.FakeWebSocket,
    HttpAgent: agents.FakeAgent,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  assert.equal(timers.timers[0].delay, 5_000);
  timers.fire();

  await assert.rejects(
    pending,
    assertFixedFailure('CANDIDATE_RUNTIME_SOCKET_FAILED'),
  );
  assert.equal(sockets.instances[0].terminateCalls, 1);
  assert.equal(agents.instances[0].destroyCalls, 1);
  assert.equal(timers.timers[0].cleared, true);
});

test('agent constructor failures are always fixed asynchronous transport failures',
  async () => {
    class ThrowingAgent {
      constructor() {
        throw new Error('sensitive agent constructor detail');
      }
    }
    let bootstrapPending;
    let socketPending;

    assert.doesNotThrow(() => {
      bootstrapPending = readCandidateBootstrap({ HttpAgent: ThrowingAgent });
      socketPending = openCandidateRuntimeSocket({ HttpAgent: ThrowingAgent });
    });
    await assert.rejects(
      bootstrapPending,
      assertFixedFailure('CANDIDATE_BOOTSTRAP_FAILED'),
    );
    await assert.rejects(
      socketPending,
      assertFixedFailure('CANDIDATE_RUNTIME_SOCKET_FAILED'),
    );
  });

test('websocket constructor and throwing agent cleanup preserve the fixed failure',
  async () => {
    class ThrowingCleanupAgent {
      destroy() {
        throw new Error('sensitive agent cleanup detail');
      }
    }
    class ThrowingWebSocket {
      constructor() {
        throw new Error('sensitive websocket constructor detail');
      }
    }
    let pending;

    assert.doesNotThrow(() => {
      pending = openCandidateRuntimeSocket({
        WebSocket: ThrowingWebSocket,
        HttpAgent: ThrowingCleanupAgent,
      });
    });
    await assert.rejects(
      pending,
      assertFixedFailure('CANDIDATE_RUNTIME_SOCKET_FAILED'),
    );
  });

test('maintenance direct transports reject injected capability seams before network',
  async () => {
    await assert.rejects(
      readCandidateBootstrap({ httpRequest: null }),
      assertFixedFailure('CANDIDATE_BOOTSTRAP_FAILED'),
    );
    await assert.rejects(
      openCandidateRuntimeSocket({ WebSocket: null }),
      assertFixedFailure('CANDIDATE_RUNTIME_SOCKET_FAILED'),
    );
  });
