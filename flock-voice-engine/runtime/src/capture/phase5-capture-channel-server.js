import {
  chmodSync as fsChmodSync,
  lstatSync as fsLstatSync,
  unlinkSync as fsUnlinkSync,
} from 'node:fs';
import {
  createServer as netCreateServer,
} from 'node:net';
import {
  posix as pathPosix,
} from 'node:path';
import {
  clearTimeout as cancelScheduledTimeout,
  setTimeout as scheduleTimeout,
} from 'node:timers';
import {
  types,
} from 'node:util';

import {
  MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES,
} from './phase5-capture-channel-protocol.js';
import {
  copyPhase5CaptureBytes,
} from './capture-wire.js';

export const PHASE5_CAPTURE_CHANNEL_SOCKET_PATH =
  '/run/flock-phase5-candidate/capture.sock';

const PHASE5_CAPTURE_CHANNEL_SOCKET_PARENT_BASENAMES = Object.freeze([
  'flock-phase5-candidate',
  'run-flock-phase5-candidate',
]);
const PHASE5_CAPTURE_CHANNEL_SOCKET_BASENAME = 'capture.sock';
const MAX_LINUX_UNIX_SOCKET_PATH_BYTES = 107;
const PHASE5_CAPTURE_CHANNEL_SOCKET_MODE = 0o600;
const PHASE5_CAPTURE_CHANNEL_PARENT_MODE = 0o700;
const PHASE5_CAPTURE_CHANNEL_TIMEOUT_MS = 5000;
const MAX_PHASE5_CAPTURE_ADMISSION_BYTES = 4096;
const MAX_PHASE5_CAPTURE_RESPONSE_BYTES = 2 * 1024 * 1024;
const DIRECTORY_TYPE = 0o040000;
const SOCKET_TYPE = 0o140000;
const TYPE_MASK = 0o170000;
const PRIVATE_OPTIONS_FIELDS = Object.freeze([
  'protocol',
  'signal',
  'socketPath',
  'platform',
  'getuid',
  'createServer',
  'lstatSync',
  'unlinkSync',
  'chmodSync',
  'scheduleTimeout',
  'cancelTimeout',
]);
const PROTOCOL_FIELDS = Object.freeze([
  'getAdmissionBytes',
  'handleFinalizeRequestBytes',
]);

function fail(code = 'PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED') {
  throw new Phase5CaptureChannelServerError(code);
}

function enumerableDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
}

function exactPlainDataObject(value, expected) {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string')
    && expected.every((key) => (
      keys.includes(key) && enumerableDataProperty(value, key)
    ));
}

function exactPublicOptions(value) {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (keys.length === 1 || keys.length === 2)
    && keys.every((key) => (
      typeof key === 'string'
      && ['protocol', 'signal'].includes(key)
      && enumerableDataProperty(value, key)
    ))
    && keys.includes('protocol');
}

function dataPropertyValue(value, key) {
  return Object.getOwnPropertyDescriptor(value, key).value;
}

function ownedBuffer(value, maximum) {
  const prototype = (
    value !== null && typeof value === 'object' && !types.isProxy(value)
      ? Object.getPrototypeOf(value)
      : null
  );
  if (!Buffer.isBuffer(value)
      || prototype !== Buffer.prototype) {
    throw new Error('BYTES_INVALID');
  }
  return copyPhase5CaptureBytes(value, maximum);
}

function fileType(mode) {
  return mode & TYPE_MASK;
}

function permissions(mode) {
  return mode & 0o7777;
}

function canonicalSocketAuthority(socketPath) {
  if (typeof socketPath !== 'string'
      || socketPath.length === 0
      || socketPath.includes('\0')
      || !pathPosix.isAbsolute(socketPath)
      || pathPosix.normalize(socketPath) !== socketPath
      || pathPosix.basename(socketPath)
         !== PHASE5_CAPTURE_CHANNEL_SOCKET_BASENAME
      || !PHASE5_CAPTURE_CHANNEL_SOCKET_PARENT_BASENAMES.includes(
        pathPosix.basename(pathPosix.dirname(socketPath)),
      )
      || Buffer.byteLength(socketPath, 'utf8')
         > MAX_LINUX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error('SOCKET_PATH_INVALID');
  }
  const parent = pathPosix.dirname(socketPath);
  const segments = parent.slice(1).split('/');
  const ancestors = ['/'];
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    ancestors.push(current);
  }
  return { parent, ancestors };
}

function closePeer(peer) {
  try {
    peer.destroy();
  } catch {
    // The protocol state is already consumed before this cleanup.
  }
}

export class Phase5CaptureChannelServerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5CaptureChannelServerError';
    this.code = code;
  }
}

export async function _startPhase5CaptureChannelServer(options) {
  let protocol;
  let signal;
  let socketPath;
  let socketParent;
  let socketAncestors;
  let platform;
  let getuid;
  let createServer;
  let lstatSync;
  let unlinkSync;
  let chmodSync;
  let scheduleDeadline;
  let cancelDeadline;
  let getAdmissionBytes;
  let handleFinalizeRequestBytes;
  let admissionBytes;
  let uid;
  try {
    if (!exactPlainDataObject(options, PRIVATE_OPTIONS_FIELDS)) {
      throw new Error('OPTIONS_INVALID');
    }
    protocol = dataPropertyValue(options, 'protocol');
    signal = dataPropertyValue(options, 'signal');
    socketPath = dataPropertyValue(options, 'socketPath');
    platform = dataPropertyValue(options, 'platform');
    getuid = dataPropertyValue(options, 'getuid');
    createServer = dataPropertyValue(options, 'createServer');
    lstatSync = dataPropertyValue(options, 'lstatSync');
    unlinkSync = dataPropertyValue(options, 'unlinkSync');
    chmodSync = dataPropertyValue(options, 'chmodSync');
    scheduleDeadline = dataPropertyValue(
      options,
      'scheduleTimeout',
    );
    cancelDeadline = dataPropertyValue(
      options,
      'cancelTimeout',
    );
    ({
      parent: socketParent,
      ancestors: socketAncestors,
    } = canonicalSocketAuthority(socketPath));
    if (!exactPlainDataObject(protocol, PROTOCOL_FIELDS)
        || typeof dataPropertyValue(
          protocol,
          'getAdmissionBytes',
        ) !== 'function'
        || typeof dataPropertyValue(
          protocol,
          'handleFinalizeRequestBytes',
        ) !== 'function'
        || platform !== 'linux'
        || typeof getuid !== 'function'
        || typeof createServer !== 'function'
        || typeof lstatSync !== 'function'
        || typeof unlinkSync !== 'function'
        || typeof chmodSync !== 'function'
        || typeof scheduleDeadline !== 'function'
        || typeof cancelDeadline !== 'function'
        || !(
          signal === null
          || (
            typeof signal === 'object'
            && !types.isProxy(signal)
            && typeof signal.aborted === 'boolean'
            && typeof signal.addEventListener === 'function'
            && typeof signal.removeEventListener === 'function'
          )
        )) {
      throw new Error('INPUT_INVALID');
    }
    getAdmissionBytes = dataPropertyValue(
      protocol,
      'getAdmissionBytes',
    );
    handleFinalizeRequestBytes = dataPropertyValue(
      protocol,
      'handleFinalizeRequestBytes',
    );
    uid = Reflect.apply(getuid, undefined, []);
    if (!Number.isSafeInteger(uid) || uid < 0) {
      throw new Error('UID_INVALID');
    }
    for (const path of socketAncestors) {
      const state = Reflect.apply(lstatSync, undefined, [path]);
      if (!Number.isSafeInteger(state?.mode)
          || !Number.isSafeInteger(state?.uid)
          || fileType(state.mode) !== DIRECTORY_TYPE
          || (state.uid !== 0 && state.uid !== uid)
          || (
            (permissions(state.mode) & 0o022) !== 0
            && !(state.uid === 0 && (state.mode & 0o1000) !== 0)
          )) {
        throw new Error('ANCESTOR_INVALID');
      }
      if (path === socketParent
          && (permissions(state.mode)
                !== PHASE5_CAPTURE_CHANNEL_PARENT_MODE
              || state.uid !== uid)) {
        throw new Error('PARENT_INVALID');
      }
    }
    try {
      Reflect.apply(
        lstatSync,
        undefined,
        [socketPath],
      );
      throw new Error('SOCKET_PATH_OCCUPIED');
    } catch (error) {
      if (error?.message === 'SOCKET_PATH_OCCUPIED'
          || error?.code !== 'ENOENT') {
        throw error;
      }
    }
    admissionBytes = ownedBuffer(
      Reflect.apply(getAdmissionBytes, protocol, []),
      MAX_PHASE5_CAPTURE_ADMISSION_BYTES,
    );
  } catch {
    fail();
  }

  let accepted = false;
  let listenerClosePromise = null;
  let listenerCloseError = null;
  let protocolConsumed = false;
  let server;
  let activePeer = null;
  let activeFailPeer = null;
  let removeStartupAbort = () => {};
  let terminalSettled = false;
  let resolveTerminal;
  let rejectTerminal;
  let closing = false;
  const terminalPromise = new Promise((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  void terminalPromise.catch(() => {
    // The owner may not subscribe until after startup returns.
  });

  function completeTerminal(value) {
    if (terminalSettled) return;
    terminalSettled = true;
    resolveTerminal(value);
  }

  function failTerminal() {
    if (terminalSettled) return;
    terminalSettled = true;
    rejectTerminal(new Phase5CaptureChannelServerError(
      'PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED',
    ));
  }

  function consumeProtocol(requestBytes) {
    if (protocolConsumed) {
      throw new Error('PROTOCOL_ALREADY_CONSUMED');
    }
    protocolConsumed = true;
    return Reflect.apply(
      handleFinalizeRequestBytes,
      protocol,
      [requestBytes],
    );
  }

  function abortProtocol() {
    if (protocolConsumed) return;
    try {
      consumeProtocol(Buffer.alloc(0));
    } catch {
      // Invalid empty input is the deliberate once-only seal operation.
    }
  }

  function safeUnlink() {
    try {
      Reflect.apply(
        unlinkSync,
        undefined,
        [socketPath],
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  function beginCloseListener() {
    if (listenerClosePromise !== null) {
      return listenerClosePromise;
    }
    listenerClosePromise = new Promise((resolve) => {
      try {
        server.close((error) => {
          if (error !== undefined
              && error !== null
              && error?.code !== 'ERR_SERVER_NOT_RUNNING') {
            listenerCloseError = error;
            failTerminal();
          }
          resolve();
        });
      } catch (error) {
        if (error?.code !== 'ERR_SERVER_NOT_RUNNING') {
          listenerCloseError = error;
          failTerminal();
        }
        resolve();
      }
    });
    return listenerClosePromise;
  }

  function onConnection(peer) {
    if (accepted) {
      closePeer(peer);
      return;
    }
    accepted = true;
    activePeer = peer;
    void beginCloseListener();
    try {
      peer.pause();
      safeUnlink();
    } catch {
      failTerminal();
      abortProtocol();
      closePeer(peer);
      activePeer = null;
      return;
    }

    const requestBuffer = Buffer.alloc(
      MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES,
    );
    let requestSize = 0;
    let terminal = false;
    let responseFlushed = false;
    let deadlineToken = null;

    function clearDeadline() {
      if (deadlineToken === null) return;
      const token = deadlineToken;
      deadlineToken = null;
      try {
        Reflect.apply(cancelDeadline, undefined, [token]);
      } catch {
        // Protocol consumption remains authoritative on cleanup failure.
      }
    }

    function failPeer() {
      if (terminal) return;
      terminal = true;
      if (!closing) failTerminal();
      clearDeadline();
      abortProtocol();
      closePeer(peer);
      if (activePeer === peer) activePeer = null;
      if (activeFailPeer === failPeer) activeFailPeer = null;
    }

    activeFailPeer = failPeer;
    peer.on('data', (chunk) => {
      if (terminal) return;
      try {
        const owned = ownedBuffer(
          chunk,
          MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES,
        );
        if (owned.byteLength
            > MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES
              - requestSize) {
          failPeer();
          return;
        }
        owned.copy(requestBuffer, requestSize);
        requestSize += owned.byteLength;
      } catch {
        failPeer();
      }
    });
    peer.once('end', () => {
      if (terminal) return;
      try {
        const requestBytes = Buffer.from(
          requestBuffer.subarray(0, requestSize),
        );
        const responseBytes = ownedBuffer(
          consumeProtocol(requestBytes),
          MAX_PHASE5_CAPTURE_RESPONSE_BYTES,
        );
        peer.end(responseBytes, () => {
          if (terminal) return;
          responseFlushed = true;
        });
      } catch {
        terminal = true;
        failTerminal();
        clearDeadline();
        closePeer(peer);
        if (activePeer === peer) activePeer = null;
        if (activeFailPeer === failPeer) activeFailPeer = null;
      }
    });
    peer.once('error', failPeer);
    peer.once('close', () => {
      if (!terminal) {
        if (!responseFlushed) {
          failPeer();
          return;
        }
        terminal = true;
        completeTerminal('completed');
      }
      clearDeadline();
      if (activePeer === peer) activePeer = null;
      if (activeFailPeer === failPeer) activeFailPeer = null;
    });
    try {
      const token = Reflect.apply(
        scheduleDeadline,
        undefined,
        [failPeer, PHASE5_CAPTURE_CHANNEL_TIMEOUT_MS],
      );
      deadlineToken = token;
      if (terminal) clearDeadline();
      peer.resume();
    } catch {
      failPeer();
    }
  }

  function handleServerFailure() {
    failTerminal();
    abortProtocol();
    activeFailPeer?.();
    if (activePeer !== null) {
      closePeer(activePeer);
      activePeer = null;
      activeFailPeer = null;
    }
    void beginCloseListener();
    try {
      safeUnlink();
    } catch {
      // The channel is already terminal.
    }
  }

  try {
    if (signal?.aborted) throw new Error('STARTUP_ABORTED');
    server = Reflect.apply(createServer, undefined, [onConnection]);
    await new Promise((resolve, reject) => {
      let settled = false;
      let startupAborted = false;
      const finish = (operation, value) => {
        if (settled) return;
        settled = true;
        operation(value);
      };
      const serverError = (error) => {
        if (!settled) {
          finish(reject, error);
          return;
        }
        handleServerFailure();
      };
      const startupAbort = () => {
        startupAborted = true;
        abortProtocol();
        activeFailPeer?.();
        if (activePeer !== null) {
          closePeer(activePeer);
          activePeer = null;
          activeFailPeer = null;
        }
        void beginCloseListener();
        try {
          safeUnlink();
        } catch {
          // The outer startup failure remains authoritative.
        }
        finish(reject, new Error('STARTUP_ABORTED'));
      };
      if (signal !== null) {
        signal.addEventListener('abort', startupAbort, {
          once: true,
        });
        removeStartupAbort = () => {
          signal.removeEventListener('abort', startupAbort);
        };
      }
      server.on('error', serverError);
      try {
        if (signal?.aborted) {
          startupAbort();
          return;
        }
        server.listen(
          socketPath,
          () => {
            if (startupAborted || signal?.aborted) {
              startupAbort();
              void beginCloseListener();
              try {
                safeUnlink();
              } catch {
                // The startup is already terminal.
              }
              return;
            }
            try {
              Reflect.apply(
                chmodSync,
                undefined,
                [
                  socketPath,
                  PHASE5_CAPTURE_CHANNEL_SOCKET_MODE,
                ],
              );
              const state = Reflect.apply(
                lstatSync,
                undefined,
                [socketPath],
              );
              if (fileType(state.mode) !== SOCKET_TYPE
                  || permissions(state.mode)
                     !== PHASE5_CAPTURE_CHANNEL_SOCKET_MODE
                  || state.uid !== uid) {
                throw new Error('SOCKET_INODE_INVALID');
              }
              queueMicrotask(() => {
                if (startupAborted || signal?.aborted) {
                  startupAbort();
                  return;
                }
                finish(resolve);
              });
            } catch (error) {
              finish(reject, error);
            }
          },
        );
      } catch (error) {
        finish(reject, error);
      }
    });
    removeStartupAbort();
    removeStartupAbort = () => {};
  } catch {
    removeStartupAbort();
    removeStartupAbort = () => {};
    abortProtocol();
    try {
      server?.close(() => {});
    } catch {
      // Startup is already failing closed.
    }
    try {
      safeUnlink();
    } catch {
      // Startup is already failing closed.
    }
    fail();
  }

  function getOwnedAdmissionBytes(...args) {
    if (args.length !== 0) fail();
    return Buffer.from(admissionBytes);
  }

  function waitForTerminal(...args) {
    if (args.length !== 0) fail();
    return terminalPromise;
  }

  async function close(...args) {
    if (args.length !== 0) fail();
    closing = true;
    abortProtocol();
    activeFailPeer?.();
    if (activePeer !== null) {
      closePeer(activePeer);
      activePeer = null;
      activeFailPeer = null;
    }
    await beginCloseListener();
    try {
      safeUnlink();
    } catch {
      failTerminal();
      fail();
    }
    if (listenerCloseError !== null) {
      failTerminal();
      fail();
    }
    completeTerminal('closed');
  }

  return Object.freeze({
    getAdmissionBytes: getOwnedAdmissionBytes,
    waitForTerminal,
    close,
  });
}

export async function startPhase5CaptureChannelServer(options) {
  if (!exactPublicOptions(options)) {
    fail();
  }
  return _startPhase5CaptureChannelServer({
    protocol: dataPropertyValue(options, 'protocol'),
    signal: Object.hasOwn(options, 'signal')
      ? dataPropertyValue(options, 'signal')
      : null,
    socketPath: PHASE5_CAPTURE_CHANNEL_SOCKET_PATH,
    platform: process.platform,
    getuid: () => process.getuid(),
    createServer: (handler) => netCreateServer(
      { allowHalfOpen: true },
      handler,
    ),
    lstatSync: fsLstatSync,
    unlinkSync: fsUnlinkSync,
    chmodSync: fsChmodSync,
    scheduleTimeout: (handler, milliseconds) => scheduleTimeout(
      handler,
      milliseconds,
    ),
    cancelTimeout: (token) => cancelScheduledTimeout(token),
  });
}
