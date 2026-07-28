#!/usr/bin/env node
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { readFile as nodeReadFile } from 'node:fs/promises';
import {
  Agent as NodeHttpAgent,
  request as nodeHttpRequest,
} from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import NodeWebSocket from 'ws';

const LOOPBACK_ADDRESS = '127.0.0.1';
const INTERNAL_PORT = 8090;
const BROWSER_AUTHORITY = '127.0.0.1:18090';
const CANDIDATE_ORIGIN = `http://${BROWSER_AUTHORITY}`;
const BOOTSTRAP_PATH = '/api/v1/bootstrap';
const RUNTIME_SOCKET_URL = `ws://${LOOPBACK_ADDRESS}:${INTERNAL_PORT}/api/v1/runtime`;
const SECRET_PATH = '/run/secrets/flock-maintenance-token';
const BOOTSTRAP_TIMEOUT_MILLISECONDS = 5_000;
const BOOTSTRAP_MAX_BYTES = 65_536;
const SOCKET_OPEN_TIMEOUT_MILLISECONDS = 5_000;
const SOCKET_READY_TIMEOUT_MILLISECONDS = 5_000;
const COMMAND_TIMEOUT_MILLISECONDS = 10_000;
const RELEASE_TIMEOUT_MILLISECONDS = 2_000;
const STDOUT_TIMEOUT_MILLISECONDS = 2_000;
const SOCKET_CLOSE_TIMEOUT_MILLISECONDS = 250;
const HEARTBEAT_INTERVAL_MILLISECONDS = 750;
const DECODER_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const FORBIDDEN_AUTHORITY_OVERRIDES = Object.freeze([
  'FLOCK_RUNTIME_URL',
  'FLOCK_RUNTIME_ORIGIN',
]);
const HOLDING_STATUS = '{"status":"holding"}\n';
const USAGE = 'usage: legacy-lease.mjs hold <decoderSessionId>\n';
const protectedOutputStreams = new WeakSet();

function retainOutputErrorSink(stream) {
  if ((typeof stream !== 'object' && typeof stream !== 'function')
      || stream === null || typeof stream.on !== 'function'
      || protectedOutputStreams.has(stream)) return;
  stream.on('error', () => {});
  protectedOutputStreams.add(stream);
}

function assertNoAuthorityOverrides(env) {
  for (const name of FORBIDDEN_AUTHORITY_OVERRIDES) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      throw new Error(`MAINTENANCE_AUTHORITY_OVERRIDE_FORBIDDEN:${name}`);
    }
  }
}

function parseArguments(argv) {
  const [action, decoderSessionId] = argv;
  if (argv.length !== 2 || action !== 'hold'
      || typeof decoderSessionId !== 'string' || !DECODER_SESSION_ID.test(decoderSessionId)) {
    return null;
  }
  return { decoderSessionId };
}

function parseFrame(data) {
  try {
    return JSON.parse(typeof data === 'string' ? data : data.toString());
  } catch {
    return null;
  }
}

function validNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validCursor(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseBootstrapBody(body) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('BOOTSTRAP_JSON_INVALID');
  }
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || !validNonemptyString(value.clientId)
    || !validNonemptyString(value.bootstrapToken)
    || !validNonemptyString(value.worldGeneration)
    || !validCursor(value.revision)
    || !validCursor(value.eventSeq)
  ) {
    throw new Error('BOOTSTRAP_SCHEMA_INVALID');
  }
  return value;
}

function loadBootstrap({
  httpRequest,
  agent,
  setTimeout,
  clearTimeout,
}) {
  return new Promise((resolveBootstrap, rejectBootstrap) => {
    let request;
    let response;
    let settled = false;
    let receivedBytes = 0;
    let timer;
    const chunks = [];
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation(value);
    };
    const fail = (error) => finish(rejectBootstrap,
      error instanceof Error ? error : new Error(String(error)));
    timer = setTimeout(() => {
      const error = new Error('BOOTSTRAP_TIMEOUT');
      fail(error);
      try {
        request?.destroy(error);
      } catch {
        // A timeout is already authoritative; request teardown is best effort.
      }
    }, BOOTSTRAP_TIMEOUT_MILLISECONDS);

    try {
      request = httpRequest({
        protocol: 'http:',
        hostname: LOOPBACK_ADDRESS,
        port: INTERNAL_PORT,
        method: 'GET',
        path: BOOTSTRAP_PATH,
        headers: {
          Host: BROWSER_AUTHORITY,
          Origin: CANDIDATE_ORIGIN,
          Accept: 'application/json',
        },
        agent,
        localAddress: LOOPBACK_ADDRESS,
        setHost: false,
      }, (incoming) => {
        response = incoming;
        // Keep an error sink attached even if destroying an invalid response
        // schedules an error after the bootstrap promise has settled.
        response.on('error', fail);
        response.on('aborted', () => fail(new Error('BOOTSTRAP_RESPONSE_ABORTED')));

        if (response.statusCode !== 200) {
          fail(new Error(`BOOTSTRAP_HTTP_${response.statusCode ?? 'UNKNOWN'}`));
          try {
            response.destroy();
          } catch {
            // The exact status failure remains authoritative.
          }
          return;
        }

        const declaredLength = Number(response.headers?.['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > BOOTSTRAP_MAX_BYTES) {
          fail(new Error('BOOTSTRAP_BODY_TOO_LARGE'));
          try {
            response.destroy();
          } catch {
            // The bounded-body failure remains authoritative.
          }
          return;
        }

        response.on('data', (chunk) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += bytes.length;
          if (receivedBytes > BOOTSTRAP_MAX_BYTES) {
            fail(new Error('BOOTSTRAP_BODY_TOO_LARGE'));
            try {
              response.destroy();
            } catch {
              // The bounded-body failure remains authoritative.
            }
            return;
          }
          chunks.push(bytes);
        });
        response.on('end', () => {
          if (settled) return;
          try {
            finish(resolveBootstrap, parseBootstrapBody(
              Buffer.concat(chunks, receivedBytes).toString('utf8'),
            ));
          } catch (error) {
            fail(error);
          }
        });
      });
      // This listener deliberately remains until the request becomes
      // unreachable, so a destroy-induced late error can never be uncaught.
      request.on('error', fail);
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}

function createSocketRouter(socket, { setTimeout, clearTimeout }) {
  const pending = new Map();

  function settle(commandId, operation, value) {
    const entry = pending.get(commandId);
    if (!entry) return;
    pending.delete(commandId);
    clearTimeout(entry.timer);
    entry[operation](value);
  }

  function failPending(error) {
    for (const commandId of [...pending.keys()]) settle(commandId, 'reject', error);
  }

  function onMessage(data) {
    const frame = parseFrame(data);
    if (frame?.type === 'command.result' && typeof frame.commandId === 'string') {
      settle(frame.commandId, 'resolve', frame);
    }
  }
  function onError(error) {
    failPending(error instanceof Error ? error : new Error('RUNTIME_SOCKET_ERROR'));
  }
  function onClose() {
    failPending(new Error('RUNTIME_SOCKET_CLOSED'));
  }

  socket.on('message', onMessage);
  socket.on('error', onError);
  socket.on('close', onClose);

  return {
    command(frame, timeoutMilliseconds = COMMAND_TIMEOUT_MILLISECONDS) {
      return new Promise((resolveCommand, rejectCommand) => {
        const { commandId } = frame;
        const timer = setTimeout(() => {
          settle(commandId, 'reject', new Error('COMMAND_TIMEOUT'));
        }, timeoutMilliseconds);
        pending.set(commandId, { resolve: resolveCommand, reject: rejectCommand, timer });
        try {
          socket.send(JSON.stringify(frame));
        } catch (error) {
          settle(commandId, 'reject', error);
        }
      });
    },
    dispose() {
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
      failPending(new Error('RUNTIME_SOCKET_DISPOSED'));
    },
  };
}

function waitForOpen(socket, { setTimeout, clearTimeout }) {
  return new Promise((resolveOpen, rejectOpen) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (operation, value) => {
      cleanup();
      operation(value);
    };
    const onOpen = () => finish(resolveOpen);
    const onError = (error) => finish(rejectOpen,
      error instanceof Error ? error : new Error('RUNTIME_SOCKET_ERROR'));
    const onClose = () => finish(rejectOpen, new Error('RUNTIME_SOCKET_CLOSED_BEFORE_OPEN'));
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
    timer = setTimeout(
      () => finish(rejectOpen, new Error('OPEN_TIMEOUT')),
      SOCKET_OPEN_TIMEOUT_MILLISECONDS,
    );
  });
}

function waitForReady(socket, { setTimeout, clearTimeout }) {
  return new Promise((resolveReady, rejectReady) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (operation, value) => {
      cleanup();
      operation(value);
    };
    const onMessage = (data) => {
      const frame = parseFrame(data);
      if (frame?.type === 'ready') finish(resolveReady, frame);
    };
    const onError = (error) => finish(rejectReady,
      error instanceof Error ? error : new Error('RUNTIME_SOCKET_ERROR'));
    const onClose = () => finish(rejectReady, new Error('RUNTIME_SOCKET_CLOSED_BEFORE_READY'));
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
    timer = setTimeout(
      () => finish(rejectReady, new Error('READY_TIMEOUT')),
      SOCKET_READY_TIMEOUT_MILLISECONDS,
    );
  });
}

function createSignalController(signals, { setTimeout, clearTimeout }) {
  let receivedSignal = null;
  let wake = null;
  const listeners = [];
  const requestStop = (signal) => {
    if (receivedSignal === null) receivedSignal = signal;
    wake?.(receivedSignal);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const listener = () => requestStop(signal);
    signals.on(signal, listener);
    listeners.push([signal, listener]);
  }
  return {
    get signal() {
      return receivedSignal;
    },
    wait() {
      if (receivedSignal !== null) return Promise.resolve(receivedSignal);
      return new Promise((resolveWait) => {
        let timer;
        let settled = false;
        const finish = (outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (wake === finish) wake = null;
          resolveWait(outcome);
        };
        wake = finish;
        timer = setTimeout(
          () => finish('heartbeat'),
          HEARTBEAT_INTERVAL_MILLISECONDS,
        );
        if (receivedSignal !== null) finish(receivedSignal);
      });
    },
    dispose() {
      for (const [signal, listener] of listeners) signals.off(signal, listener);
      wake?.(receivedSignal ?? 'SIGTERM');
    },
  };
}

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143;
}

function expectAccepted(frame, fallbackCode) {
  if (frame?.accepted !== true) throw new Error(fallbackCode);
  return frame;
}

function writeStdout(stdout, value, { setTimeout, clearTimeout }) {
  return new Promise((resolveWrite, rejectWrite) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      stdout.off?.('error', onError);
    };
    const finish = (operation, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation(result);
    };
    const onError = (error) => finish(rejectWrite,
      error instanceof Error ? error : new Error('STDOUT_WRITE_FAILED'));
    stdout.once?.('error', onError);
    timer = setTimeout(
      () => finish(rejectWrite, new Error('STDOUT_FLUSH_TIMEOUT')),
      STDOUT_TIMEOUT_MILLISECONDS,
    );
    try {
      stdout.write(value, (error) => {
        if (error) onError(error);
        else finish(resolveWrite);
      });
    } catch (error) {
      onError(error);
    }
  });
}

async function shutdownSocket(socket, { setTimeout, clearTimeout }) {
  if (!socket) return;
  await new Promise((resolveClose) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('close', finish);
      resolveClose();
    };
    socket.once('close', finish);
    timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // The close deadline is authoritative; termination is best effort.
      }
      finish();
    }, SOCKET_CLOSE_TIMEOUT_MILLISECONDS);
    try {
      if (socket.readyState === 0) socket.terminate();
      else if (socket.readyState === 1) socket.close();
      else finish();
    } catch {
      finish();
    }
  });
}

/**
 * Run one maintenance lease action against the fixed candidate runtime.
 *
 * Dependencies are injectable so this protocol client can be tested without
 * reading a host secret or opening a network connection.
 */
export async function runLegacyLease({
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = {},
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  assertNoAuthorityOverrides(env);
  const parsed = parseArguments(argv);
  if (!parsed) {
    stderr.write(USAGE);
    return { exitCode: 2 };
  }
  retainOutputErrorSink(stdout);

  const {
    readFile = nodeReadFile,
    httpRequest = nodeHttpRequest,
    HttpAgent = NodeHttpAgent,
    WebSocket = NodeWebSocket,
    randomUUID = nodeRandomUUID,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    signals = process,
  } = dependencies;

  const credential = await readFile(SECRET_PATH, 'utf8');
  const httpAgent = new HttpAgent({
    keepAlive: false,
    localAddress: LOOPBACK_ADDRESS,
  });
  let bootstrap;
  try {
    bootstrap = await loadBootstrap({
      httpRequest,
      agent: httpAgent,
      setTimeout: setTimer,
      clearTimeout: clearTimer,
    });
  } finally {
    httpAgent.destroy();
  }

  const websocketAgent = new HttpAgent({
    keepAlive: false,
    localAddress: LOOPBACK_ADDRESS,
  });
  let socket;
  let router;
  let signalController;
  let releaseOnce = null;
  try {
    socket = new WebSocket(RUNTIME_SOCKET_URL, {
      agent: websocketAgent,
      followRedirects: false,
      handshakeTimeout: SOCKET_OPEN_TIMEOUT_MILLISECONDS,
      headers: { Host: BROWSER_AUTHORITY },
      localAddress: LOOPBACK_ADDRESS,
      origin: CANDIDATE_ORIGIN,
    });
    // This sink intentionally outlives all temporary routers/waits and remains
    // through close/terminate. In particular, ws can emit an abortHandshake
    // error after a CONNECTING socket has already timed out.
    socket.on('error', () => {});
    router = createSocketRouter(socket, { setTimeout: setTimer, clearTimeout: clearTimer });
    await waitForOpen(socket, { setTimeout: setTimer, clearTimeout: clearTimer });

    const ready = waitForReady(socket, { setTimeout: setTimer, clearTimeout: clearTimer });
    socket.send(JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      clientId: bootstrap.clientId,
      bootstrapToken: bootstrap.bootstrapToken,
      worldGeneration: bootstrap.worldGeneration,
      lastRevision: bootstrap.revision,
      lastEventSeq: bootstrap.eventSeq,
    }));
    await ready;

    const command = (name, payload, timeoutMilliseconds) => {
      const commandId = randomUUID();
      return router.command({
        type: 'command',
        protocolVersion: 1,
        commandId,
        name,
        payload,
        worldGeneration: bootstrap.worldGeneration,
        baseRevision: bootstrap.revision,
      }, timeoutMilliseconds);
    };
    const authenticated = expectAccepted(
      await command('maintenance.authenticate', { credential }),
      'MAINTENANCE_AUTHENTICATION_REJECTED',
    );
    if (!validNonemptyString(authenticated.maintenanceToken)) {
      throw new Error('MAINTENANCE_TOKEN_REQUIRED');
    }

    // Install both persistent listeners before sending legacy.take. A signal
    // that arrives while the command is in flight is remembered, then the
    // acquired lease is released as soon as its token is known.
    signalController = createSignalController(signals, {
      setTimeout: setTimer,
      clearTimeout: clearTimer,
    });

    const result = expectAccepted(await command('legacy.take', {
      maintenanceToken: authenticated.maintenanceToken,
      decoderSessionId: parsed.decoderSessionId,
    }), 'LEGACY_TAKE_REJECTED');

    if (!validNonemptyString(result.leaseToken)) {
      throw new Error('LEGACY_TAKE_LEASE_TOKEN_REQUIRED');
    }
    let releaseAttempt = null;
    releaseOnce = () => {
      if (releaseAttempt === null) {
        releaseAttempt = (async () => expectAccepted(
          await command('legacy.release', {
            maintenanceToken: authenticated.maintenanceToken,
            decoderSessionId: parsed.decoderSessionId,
            leaseToken: result.leaseToken,
          }, RELEASE_TIMEOUT_MILLISECONDS),
          'LEGACY_RELEASE_REJECTED',
        ))();
      }
      return releaseAttempt;
    };

    if (signalController.signal !== null) {
      try {
        await releaseOnce();
      } catch {
        // Signal shutdown is bounded; the first signal remains authoritative.
      }
      return { exitCode: signalExitCode(signalController.signal) };
    }

    await writeStdout(stdout, HOLDING_STATUS, {
      setTimeout: setTimer,
      clearTimeout: clearTimer,
    });

    if (signalController.signal !== null) {
      try {
        await releaseOnce();
      } catch {
        // Signal shutdown is bounded; the first signal remains authoritative.
      }
      return { exitCode: signalExitCode(signalController.signal) };
    }

    while (signalController.signal === null) {
      const outcome = await signalController.wait();
      if (outcome !== 'heartbeat') break;
      expectAccepted(await command('legacy.heartbeat', {
        maintenanceToken: authenticated.maintenanceToken,
        decoderSessionId: parsed.decoderSessionId,
        leaseToken: result.leaseToken,
      }), 'LEGACY_HEARTBEAT_REJECTED');
    }
    try {
      await releaseOnce();
    } catch {
      // A bounded release was attempted exactly once. The operator signal,
      // not a cleanup outcome, remains the authoritative process result.
    }
    return {
      exitCode: signalExitCode(signalController.signal),
    };
  } catch (error) {
    if (releaseOnce !== null) {
      try {
        await releaseOnce();
      } catch {
        // Preserve the original catchable failure after one bounded attempt.
      }
    }
    if (signalController?.signal === 'SIGINT'
        || signalController?.signal === 'SIGTERM') {
      return { exitCode: signalExitCode(signalController.signal) };
    }
    throw error;
  } finally {
    signalController?.dispose();
    await shutdownSocket(socket, { setTimeout: setTimer, clearTimeout: clearTimer });
    router?.dispose();
    websocketAgent.destroy();
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  runLegacyLease().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch(() => {
    // CLI diagnostics are deliberately constant: protocol responses and
    // dependency errors must never turn credentials or lease tokens into logs.
    process.stderr.write('LEGACY_LEASE_HOLD_FAILED\n');
    process.exitCode = 1;
  });
}
