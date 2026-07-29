import {
  Agent as NodeHttpAgent,
  request as nodeHttpRequest,
} from 'node:http';
import NodeWebSocket from 'ws';

export const CANDIDATE_BROWSER_ORIGIN = 'http://127.0.0.1:18090';
const CANDIDATE_BROWSER_AUTHORITY = '127.0.0.1:18090';
const LOOPBACK_ADDRESS = '127.0.0.1';
const CANDIDATE_BROWSER_PORT = 18090;
const BOOTSTRAP_PATH = '/api/v1/bootstrap';
const RUNTIME_SOCKET_PATH = '/api/v1/runtime';
const MAX_JSON_BYTES = 65_536;
const TIMEOUT_MILLISECONDS = 5_000;

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function readCandidateBootstrap({
  httpRequest = nodeHttpRequest,
  HttpAgent = NodeHttpAgent,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof httpRequest !== 'function' || typeof HttpAgent !== 'function') {
    return Promise.reject(fixedError('CANDIDATE_BOOTSTRAP_FAILED'));
  }
  let agent;
  try {
    agent = new HttpAgent({
      keepAlive: false,
      localAddress: LOOPBACK_ADDRESS,
    });
  } catch {
    return Promise.reject(fixedError('CANDIDATE_BOOTSTRAP_FAILED'));
  }
  return new Promise((resolveBootstrap, rejectBootstrap) => {
    let request;
    let response;
    let settled = false;
    let receivedBytes = 0;
    const chunks = [];
    let timer;
    let abortRequested = false;
    let requestDestroyed = false;
    let responseDestroyed = false;
    let agentDestroyed = false;
    const destroyRequest = () => {
      if (requestDestroyed || !request) return;
      requestDestroyed = true;
      try { request.destroy?.(); } catch { /* fixed failure remains authoritative */ }
    };
    const destroyResponse = () => {
      if (responseDestroyed || !response) return;
      responseDestroyed = true;
      try { response.destroy?.(); } catch { /* fixed failure remains authoritative */ }
    };
    const destroyAgent = () => {
      if (agentDestroyed) return;
      agentDestroyed = true;
      try { agent.destroy?.(); } catch { /* fixed result remains authoritative */ }
    };
    const abortOwnedResources = () => {
      destroyResponse();
      destroyRequest();
      destroyAgent();
    };
    const finish = (operation, value, { abort = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      if (abort) {
        abortRequested = true;
        abortOwnedResources();
      } else {
        destroyAgent();
      }
      operation(value);
    };
    const fail = () => finish(
      rejectBootstrap,
      fixedError('CANDIDATE_BOOTSTRAP_FAILED'),
      { abort: true },
    );
    timer = setTimeoutImpl(fail, TIMEOUT_MILLISECONDS);
    try {
      request = httpRequest({
        protocol: 'http:',
        hostname: LOOPBACK_ADDRESS,
        port: CANDIDATE_BROWSER_PORT,
        method: 'GET',
        path: BOOTSTRAP_PATH,
        headers: {
          Host: CANDIDATE_BROWSER_AUTHORITY,
          Origin: CANDIDATE_BROWSER_ORIGIN,
          Accept: 'application/json',
        },
        agent,
        localAddress: LOOPBACK_ADDRESS,
        setHost: false,
      }, (incomingResponse) => {
        response = incomingResponse;
        if (abortRequested) {
          destroyResponse();
          return;
        }
        response.on('error', fail);
        response.on('aborted', fail);
        if (response.statusCode !== 200) {
          fail();
          return;
        }
        const declaredLength = Number(response.headers?.['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
          fail();
          return;
        }
        response.on('data', (chunk) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += bytes.length;
          if (receivedBytes > MAX_JSON_BYTES) {
            fail();
            return;
          }
          chunks.push(bytes);
        });
        response.on('end', () => {
          if (settled) return;
          try {
            const value = JSON.parse(Buffer.concat(chunks, receivedBytes).toString('utf8'));
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
              fail();
              return;
            }
            finish(resolveBootstrap, value);
          } catch {
            fail();
          }
        });
      });
      if (abortRequested) {
        destroyRequest();
        return;
      }
      request.on('error', fail);
      request.end();
    } catch {
      fail();
    }
  });
}

export function openCandidateRuntimeSocket({
  WebSocket = NodeWebSocket,
  HttpAgent = NodeHttpAgent,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof WebSocket !== 'function' || typeof HttpAgent !== 'function') {
    return Promise.reject(fixedError('CANDIDATE_RUNTIME_SOCKET_FAILED'));
  }
  let agent;
  try {
    agent = new HttpAgent({
      keepAlive: false,
      localAddress: LOOPBACK_ADDRESS,
    });
  } catch {
    return Promise.reject(fixedError('CANDIDATE_RUNTIME_SOCKET_FAILED'));
  }
  let socket;
  try {
    socket = new WebSocket(`ws://${CANDIDATE_BROWSER_AUTHORITY}${RUNTIME_SOCKET_PATH}`, {
      origin: CANDIDATE_BROWSER_ORIGIN,
      agent,
      followRedirects: false,
      handshakeTimeout: TIMEOUT_MILLISECONDS,
    });
  } catch {
    try { agent.destroy?.(); } catch { /* fixed failure remains authoritative */ }
    return Promise.reject(fixedError('CANDIDATE_RUNTIME_SOCKET_FAILED'));
  }
  socket.on('error', () => {});
  return new Promise((resolveSocket, rejectSocket) => {
    let settled = false;
    let disposed = false;
    let timer;
    const closeTransport = () => {
      if (disposed) return;
      disposed = true;
      try {
        if (typeof socket.terminate === 'function') {
          socket.terminate();
        } else {
          socket.close?.(1000);
        }
      } catch {
        try { socket.close?.(1000); } catch { /* disposer is best-effort and idempotent */ }
      } finally {
        try { agent.destroy?.(); } catch { /* disposer is best-effort and idempotent */ }
      }
    };
    const finish = (operation, value, { dispose = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      socket.off('open', opened);
      socket.off('error', failed);
      socket.off('unexpected-response', unexpectedResponse);
      if (dispose) closeTransport();
      operation(value);
    };
    const opened = () => finish(resolveSocket, Object.freeze({
      socket,
      closeTransport,
    }));
    const failed = () => finish(
      rejectSocket,
      fixedError('CANDIDATE_RUNTIME_SOCKET_FAILED'),
      { dispose: true },
    );
    const unexpectedResponse = (_request, response) => {
      try { response?.destroy?.(); } catch { /* fixed failure remains authoritative */ }
      failed();
    };
    timer = setTimeoutImpl(failed, TIMEOUT_MILLISECONDS);
    socket.once('open', opened);
    socket.once('error', failed);
    socket.once('unexpected-response', unexpectedResponse);
  });
}
