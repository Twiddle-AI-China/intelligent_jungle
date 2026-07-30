import {
  lstatSync as fsLstatSync,
} from 'node:fs';
import {
  createConnection as netCreateConnection,
} from 'node:net';
import {
  clearTimeout as cancelScheduledTimeout,
  setTimeout as scheduleTimeout,
} from 'node:timers';
import { types } from 'node:util';

import {
  copyPhase5CaptureBytes,
} from './capture-wire.js';
import {
  createPhase5CaptureBootstrapProtocol,
  MAX_PHASE5_CAPTURE_BOOTSTRAP_ACK_BYTES,
  MAX_PHASE5_CAPTURE_BOOTSTRAP_REQUEST_BYTES,
} from './phase5-capture-bootstrap-protocol.js';
import {
  createPhase5CaptureChannelProtocol,
} from './phase5-capture-channel-protocol.js';
import {
  startPhase5CaptureChannelServer,
} from './phase5-capture-channel-server.js';
import {
  createPhase5CandidateCaptureFinalizer,
} from './phase5-capture-finalizer.js';
import {
  createPhase5FaultSessionAuthority,
} from '../acceptance/phase5-fault-session-authority.js';

export const PHASE5_CAPTURE_BOOTSTRAP_SOCKET_PATH =
  '/run/flock-phase5-bootstrap/bootstrap.sock';
export const PHASE5_CAPTURE_BOOTSTRAP_TIMEOUT_MS = 5_000;

const PUBLIC_OPTIONS_FIELDS = Object.freeze([
  'trustedRelease',
  'trustedGeometry',
  'onFaultSessionAuthority',
]);
const PRIVATE_OPTIONS_FIELDS = Object.freeze([
  'trustedRelease',
  'trustedGeometry',
  'connectBootstrap',
  'createBootstrapProtocol',
  'createFaultSessionAuthority',
  'onFaultSessionAuthority',
  'createFinalizer',
  'createCaptureProtocol',
  'startCaptureServer',
  'createAbortController',
  'scheduleTimeout',
  'cancelTimeout',
]);
const BOOTSTRAP_PROTOCOL_FIELDS = Object.freeze([
  'acceptBootstrapRequestBytes',
  'bindAdmissionBytes',
  'acceptAdmissionAckBytes',
  'abort',
]);
const CAPTURE_OWNER_FIELDS = Object.freeze([
  'getAdmissionBytes',
  'waitForTerminal',
  'close',
]);
const PEER_METHODS = Object.freeze([
  'on',
  'once',
  'pause',
  'resume',
  'write',
  'end',
  'destroy',
]);
const TYPE_MASK = 0o170000;
const DIRECTORY_TYPE = 0o040000;
const SOCKET_TYPE = 0o140000;

function fail() {
  throw new Phase5CandidateCaptureOwnerError();
}

function enumerableDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
}

function exactPlainDataObject(value, fields) {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length
    && keys.every((key) => typeof key === 'string')
    && fields.every((key) => (
      keys.includes(key) && enumerableDataProperty(value, key)
    ));
}

function exactFrozenOwner(value, fields) {
  return exactPlainDataObject(value, fields)
    && Object.isFrozen(value)
    && fields.every((field) => (
      typeof Object.getOwnPropertyDescriptor(value, field).value
        === 'function'
    ));
}

function dataPropertyValue(value, key) {
  return Object.getOwnPropertyDescriptor(value, key).value;
}

function callable(value) {
  return typeof value === 'function' && !types.isProxy(value);
}

function validPeer(value) {
  return value !== null
    && typeof value === 'object'
    && !types.isProxy(value)
    && PEER_METHODS.every(
      (method) => typeof value[method] === 'function',
    );
}

function fileType(mode) {
  return mode & TYPE_MASK;
}

function permissions(mode) {
  return mode & 0o7777;
}

function validateFixedBootstrapSocket(lstatSync, uid) {
  const ancestors = [
    '/',
    '/run',
    '/run/flock-phase5-bootstrap',
  ];
  for (const path of ancestors) {
    const state = Reflect.apply(lstatSync, undefined, [path]);
    if (!Number.isSafeInteger(state?.mode)
        || !Number.isSafeInteger(state?.uid)
        || fileType(state.mode) !== DIRECTORY_TYPE
        || (state.uid !== 0 && state.uid !== uid)
        || (
          (permissions(state.mode) & 0o022) !== 0
          && !(state.uid === 0 && (state.mode & 0o1000) !== 0)
        )) {
      fail();
    }
    if (path === '/run/flock-phase5-bootstrap'
        && (
          permissions(state.mode) !== 0o700
          || state.uid !== uid
        )) {
      fail();
    }
  }
  const socket = Reflect.apply(
    lstatSync,
    undefined,
    [PHASE5_CAPTURE_BOOTSTRAP_SOCKET_PATH],
  );
  if (!Number.isSafeInteger(socket?.mode)
      || !Number.isSafeInteger(socket?.uid)
      || fileType(socket.mode) !== SOCKET_TYPE
      || permissions(socket.mode) !== 0o600
      || socket.uid !== uid) {
    fail();
  }
}

function deferredPromise() {
  let resolve;
  let reject;
  const promise = new Promise((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

export class Phase5CandidateCaptureOwnerError extends Error {
  constructor() {
    super('PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED');
    this.name = 'Phase5CandidateCaptureOwnerError';
    this.code = 'PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED';
  }
}

export function _createPhase5CandidateCaptureOwner(options) {
  let trustedRelease;
  let trustedGeometry;
  let connectBootstrap;
  let createBootstrapProtocol;
  let createFaultSessionAuthority;
  let onFaultSessionAuthority;
  let createFinalizer;
  let createCaptureProtocol;
  let startCaptureServer;
  let createAbortController;
  let scheduleDeadline;
  let cancelDeadline;
  let initialBootstrapProtocol;
  try {
    if (arguments.length !== 1
        || !exactPlainDataObject(options, PRIVATE_OPTIONS_FIELDS)) {
      fail();
    }
    trustedRelease = dataPropertyValue(options, 'trustedRelease');
    trustedGeometry = dataPropertyValue(options, 'trustedGeometry');
    connectBootstrap = dataPropertyValue(
      options,
      'connectBootstrap',
    );
    createBootstrapProtocol = dataPropertyValue(
      options,
      'createBootstrapProtocol',
    );
    createFaultSessionAuthority = dataPropertyValue(
      options,
      'createFaultSessionAuthority',
    );
    onFaultSessionAuthority = dataPropertyValue(
      options,
      'onFaultSessionAuthority',
    );
    createFinalizer = dataPropertyValue(options, 'createFinalizer');
    createCaptureProtocol = dataPropertyValue(
      options,
      'createCaptureProtocol',
    );
    startCaptureServer = dataPropertyValue(
      options,
      'startCaptureServer',
    );
    createAbortController = dataPropertyValue(
      options,
      'createAbortController',
    );
    scheduleDeadline = dataPropertyValue(
      options,
      'scheduleTimeout',
    );
    cancelDeadline = dataPropertyValue(options, 'cancelTimeout');
    if (![
      connectBootstrap,
      createBootstrapProtocol,
      createFaultSessionAuthority,
      onFaultSessionAuthority,
      createFinalizer,
      createCaptureProtocol,
      startCaptureServer,
      createAbortController,
      scheduleDeadline,
      cancelDeadline,
    ].every(callable)) {
      fail();
    }
    initialBootstrapProtocol = Reflect.apply(
      createBootstrapProtocol,
      undefined,
      [{
        trustedRelease,
        trustedGeometry,
      }],
    );
    if (!exactFrozenOwner(
      initialBootstrapProtocol,
      BOOTSTRAP_PROTOCOL_FIELDS,
    )) {
      fail();
    }
  } catch {
    fail();
  }

  let startPromise = null;
  let resolveStart = null;
  let rejectStart = null;
  let closePromise = null;
  let stopped = false;
  let handshakeSettled = false;
  let terminationPromise = null;
  let phase = 'IDLE';
  let bootstrapProtocol = initialBootstrapProtocol;
  let captureProtocol = null;
  let captureOwner = null;
  let captureStartup = null;
  let captureClosePromise = null;
  let abortController = null;
  let peer = null;
  let deadlineToken = null;
  let admissionFlushed = false;
  let ackValidated = false;
  let receiptFlushed = false;
  const requestBuffer = Buffer.alloc(
    MAX_PHASE5_CAPTURE_BOOTSTRAP_REQUEST_BYTES,
  );
  const ackBuffer = Buffer.alloc(
    MAX_PHASE5_CAPTURE_BOOTSTRAP_ACK_BYTES,
  );
  let requestSize = 0;
  let ackSize = 0;
  let captureFailureSettled = false;
  const captureFailure = deferredPromise();
  void captureFailure.promise.catch(() => {
    // The process lifecycle may subscribe after construction.
  });

  function settleCaptureFailure(error = null) {
    if (captureFailureSettled) return;
    captureFailureSettled = true;
    if (error === null) {
      captureFailure.resolve(false);
      return;
    }
    captureFailure.reject(
      new Phase5CandidateCaptureOwnerError(),
    );
  }

  function clearDeadline() {
    if (deadlineToken === null) return;
    const token = deadlineToken;
    deadlineToken = null;
    try {
      Reflect.apply(cancelDeadline, undefined, [token]);
    } catch {
      // Terminal state remains authoritative.
    }
  }

  function destroyPeer() {
    const active = peer;
    peer = null;
    if (active === null) return;
    try {
      Reflect.apply(active.destroy, active, []);
    } catch {
      // The handshake is already terminal.
    }
  }

  function sealCaptureProtocol() {
    if (captureProtocol === null) return;
    try {
      Reflect.apply(
        captureProtocol.handleFinalizeRequestBytes,
        captureProtocol,
        [Buffer.alloc(0)],
      );
    } catch {
      // Empty input deliberately consumes an unused finalizer.
    }
  }

  function claimedStartup(operation) {
    const claimed = deferredPromise();
    captureStartup = claimed.promise;
    try {
      const pending = Reflect.apply(
        startCaptureServer,
        undefined,
        [operation],
      );
      void Promise.resolve(pending).then(
        claimed.resolve,
        claimed.reject,
      );
    } catch (error) {
      claimed.reject(error);
    }
    return captureStartup;
  }

  function closeCaptureAuthority() {
    if (captureClosePromise !== null) return captureClosePromise;
    const claimed = deferredPromise();
    captureClosePromise = claimed.promise;
    void (async () => {
      try {
        abortController?.abort();
      } catch {
        // The concrete controller is internal and close still continues.
      }
      let owner = captureOwner;
      if (owner === null && captureStartup !== null) {
        try {
          owner = await captureStartup;
        } catch {
          owner = null;
        }
      }
      if (owner !== null) {
        if (!exactFrozenOwner(owner, CAPTURE_OWNER_FIELDS)) fail();
        captureOwner = owner;
        await Reflect.apply(owner.close, owner, []);
      } else {
        sealCaptureProtocol();
      }
      settleCaptureFailure();
      return true;
    })().then(claimed.resolve, claimed.reject);
    return captureClosePromise;
  }

  function terminateHandshake() {
    if (terminationPromise !== null) return terminationPromise;
    if (handshakeSettled) return Promise.resolve(false);
    handshakeSettled = true;
    phase = 'TERMINAL';
    clearDeadline();
    try {
      bootstrapProtocol?.abort();
    } catch {
      // The generic owner error remains the public failure.
    }
    destroyPeer();
    const claimed = deferredPromise();
    terminationPromise = claimed.promise;
    void closeCaptureAuthority().then(
      () => {
        rejectStart?.(new Phase5CandidateCaptureOwnerError());
        claimed.resolve(true);
      },
      () => {
        rejectStart?.(new Phase5CandidateCaptureOwnerError());
        claimed.resolve(true);
      },
    );
    return terminationPromise;
  }

  function failHandshake() {
    void terminateHandshake();
  }

  function finishHandshake() {
    if (handshakeSettled || stopped) {
      failHandshake();
      return;
    }
    handshakeSettled = true;
    phase = 'COMPLETE';
    clearDeadline();
    peer = null;
    resolveStart(true);
  }

  function observeCaptureTerminal(value, failed) {
    if (stopped || phase === 'TERMINAL') {
      settleCaptureFailure();
      return;
    }
    if (!handshakeSettled || phase !== 'COMPLETE') {
      failHandshake();
      return;
    }
    if (failed || value !== 'completed') {
      settleCaptureFailure(
        new Phase5CandidateCaptureOwnerError(),
      );
      return;
    }
    settleCaptureFailure();
  }

  async function beginCapture(requestBytes) {
    try {
      const accepted = Reflect.apply(
        bootstrapProtocol.acceptBootstrapRequestBytes,
        bootstrapProtocol,
        [requestBytes],
      );
      const faultSessionAuthority = Reflect.apply(
        createFaultSessionAuthority,
        undefined,
        [{
          identity: accepted.identity,
          captureNonceBytes: Buffer.from(
            accepted.captureNonce,
            'hex',
          ),
        }],
      );
      Reflect.apply(onFaultSessionAuthority, undefined, [{
        authority: faultSessionAuthority,
        identity: accepted.identity,
      }]);
      const finalizer = Reflect.apply(createFinalizer, undefined, [{
        faultSessionAuthority,
      }]);
      captureProtocol = Reflect.apply(
        createCaptureProtocol,
        undefined,
        [{ finalizer }],
      );
      abortController = Reflect.apply(
        createAbortController,
        undefined,
        [],
      );
      if (abortController === null
          || typeof abortController !== 'object'
          || types.isProxy(abortController)
          || abortController.signal === null
          || typeof abortController.signal !== 'object'
          || typeof abortController.abort !== 'function') {
        throw new Error('ABORT_CONTROLLER_INVALID');
      }
      const owner = await claimedStartup({
        protocol: captureProtocol,
        signal: abortController.signal,
      });
      if (!exactFrozenOwner(owner, CAPTURE_OWNER_FIELDS)) {
        throw new Error('CAPTURE_OWNER_INVALID');
      }
      captureOwner = owner;
      const terminal = Reflect.apply(
        owner.waitForTerminal,
        owner,
        [],
      );
      if (!types.isPromise(terminal)) {
        throw new Error('CAPTURE_TERMINAL_INVALID');
      }
      Reflect.apply(Promise.prototype.then, terminal, [
        (value) => observeCaptureTerminal(value, false),
        () => observeCaptureTerminal(null, true),
      ]);
      if (handshakeSettled || stopped) {
        await closeCaptureAuthority();
        return;
      }
      const admissionBytes = copyPhase5CaptureBytes(
        Reflect.apply(
          owner.getAdmissionBytes,
          owner,
          [],
        ),
        4096,
      );
      Reflect.apply(
        bootstrapProtocol.bindAdmissionBytes,
        bootstrapProtocol,
        [admissionBytes],
      );
      phase = 'ACK';
      const active = peer;
      if (active === null) throw new Error('PEER_CLOSED');
      Reflect.apply(active.write, active, [
        admissionBytes,
        () => {
          if (handshakeSettled || phase !== 'ACK') return;
          admissionFlushed = true;
          try {
            Reflect.apply(active.resume, active, []);
          } catch {
            failHandshake();
          }
        },
      ]);
    } catch {
      failHandshake();
    }
  }

  function onData(chunk) {
    if (handshakeSettled) return;
    try {
      if (phase === 'REQUEST') {
        const owned = copyPhase5CaptureBytes(
          chunk,
          MAX_PHASE5_CAPTURE_BOOTSTRAP_REQUEST_BYTES,
        );
        if (owned.byteLength
            > MAX_PHASE5_CAPTURE_BOOTSTRAP_REQUEST_BYTES
              - requestSize) {
          failHandshake();
          return;
        }
        owned.copy(requestBuffer, requestSize);
        requestSize += owned.byteLength;
        const newline = requestBuffer.indexOf(0x0a, 0);
        if (newline === -1) {
          if (requestSize
              === MAX_PHASE5_CAPTURE_BOOTSTRAP_REQUEST_BYTES) {
            failHandshake();
          }
          return;
        }
        if (newline !== requestSize - 1) {
          failHandshake();
          return;
        }
        phase = 'STARTING';
        Reflect.apply(peer.pause, peer, []);
        const requestBytes = Buffer.from(
          requestBuffer.subarray(0, requestSize),
        );
        void beginCapture(requestBytes);
        return;
      }
      if (phase === 'ACK') {
        if (!admissionFlushed) {
          failHandshake();
          return;
        }
        const owned = copyPhase5CaptureBytes(
          chunk,
          MAX_PHASE5_CAPTURE_BOOTSTRAP_ACK_BYTES,
        );
        if (owned.byteLength
            > MAX_PHASE5_CAPTURE_BOOTSTRAP_ACK_BYTES - ackSize) {
          failHandshake();
          return;
        }
        owned.copy(ackBuffer, ackSize);
        ackSize += owned.byteLength;
        const newline = ackBuffer.indexOf(0x0a, 0);
        if (newline === -1) {
          if (ackSize === MAX_PHASE5_CAPTURE_BOOTSTRAP_ACK_BYTES) {
            failHandshake();
          }
          return;
        }
        if (newline !== ackSize - 1) {
          failHandshake();
          return;
        }
        const receiptBytes = copyPhase5CaptureBytes(
          Reflect.apply(
            bootstrapProtocol.acceptAdmissionAckBytes,
            bootstrapProtocol,
            [Buffer.from(ackBuffer.subarray(0, ackSize))],
          ),
          256,
        );
        ackValidated = true;
        phase = 'WAIT_CLOSE';
        const active = peer;
        if (active === null) {
          failHandshake();
          return;
        }
        Reflect.apply(active.end, active, [
          receiptBytes,
          () => {
            if (handshakeSettled || phase !== 'WAIT_CLOSE') return;
            receiptFlushed = true;
            try {
              Reflect.apply(active.destroy, active, []);
            } catch {
              failHandshake();
            }
          },
        ]);
        return;
      }
      failHandshake();
    } catch {
      failHandshake();
    }
  }

  function onEnd() {
    if (handshakeSettled) return;
    failHandshake();
  }

  function onClose(hadError) {
    if (handshakeSettled) return;
    if (
      phase === 'WAIT_CLOSE'
      && admissionFlushed
      && ackValidated
      && receiptFlushed
      && hadError === false
    ) {
      phase = 'COMPLETING';
      queueMicrotask(finishHandshake);
      return;
    }
    failHandshake();
  }

  function start(...args) {
    if (args.length !== 0
        || startPromise !== null
        || stopped) {
      fail();
    }
    const claimed = deferredPromise();
    startPromise = claimed.promise;
    resolveStart = claimed.resolve;
    rejectStart = claimed.reject;
    phase = 'REQUEST';
    try {
      const token = Reflect.apply(
        scheduleDeadline,
        undefined,
        [failHandshake, PHASE5_CAPTURE_BOOTSTRAP_TIMEOUT_MS],
      );
      deadlineToken = token;
      if (handshakeSettled || stopped) {
        clearDeadline();
        return startPromise;
      }
      const connected = Reflect.apply(
        connectBootstrap,
        undefined,
        [],
      );
      if (!validPeer(connected)) {
        throw new Error('BOOTSTRAP_PEER_INVALID');
      }
      if (stopped || handshakeSettled) {
        try {
          Reflect.apply(connected.destroy, connected, []);
        } catch {
          // The handshake is already terminal.
        }
        return startPromise;
      }
      peer = connected;
      connected.on('data', onData);
      connected.once('end', onEnd);
      connected.once('error', failHandshake);
      connected.once('close', onClose);
    } catch {
      failHandshake();
    }
    return startPromise;
  }

  function close(...args) {
    if (args.length !== 0) fail();
    if (closePromise !== null) return closePromise;
    const claimed = deferredPromise();
    closePromise = claimed.promise;
    stopped = true;
    void (async () => {
      if (startPromise !== null && !handshakeSettled) {
        await terminateHandshake();
      } else {
        clearDeadline();
        try {
          bootstrapProtocol?.abort();
        } catch {
          // Capture close below is still authoritative.
        }
        destroyPeer();
      }
      try {
        await closeCaptureAuthority();
      } catch {
        fail();
      }
      settleCaptureFailure();
      return true;
    })().then(claimed.resolve, claimed.reject);
    return closePromise;
  }

  function waitForFailure(...args) {
    if (args.length !== 0) fail();
    return captureFailure.promise;
  }

  return Object.freeze({
    start,
    close,
    waitForFailure,
  });
}

export function createPhase5CandidateCaptureOwner(options) {
  try {
    if (arguments.length !== 1
        || !exactPlainDataObject(options, PUBLIC_OPTIONS_FIELDS)
        || process.platform !== 'linux'
        || typeof process.getuid !== 'function') {
      fail();
    }
    const uid = process.getuid();
    if (!Number.isSafeInteger(uid) || uid < 0) fail();
    return _createPhase5CandidateCaptureOwner({
      trustedRelease: dataPropertyValue(
        options,
        'trustedRelease',
      ),
      trustedGeometry: dataPropertyValue(
        options,
        'trustedGeometry',
      ),
      connectBootstrap() {
        validateFixedBootstrapSocket(fsLstatSync, uid);
        return netCreateConnection({
          path: PHASE5_CAPTURE_BOOTSTRAP_SOCKET_PATH,
          allowHalfOpen: true,
        });
      },
      createBootstrapProtocol:
        (value) => createPhase5CaptureBootstrapProtocol(value),
      createFaultSessionAuthority:
        (value) => createPhase5FaultSessionAuthority(value),
      onFaultSessionAuthority: dataPropertyValue(
        options,
        'onFaultSessionAuthority',
      ),
      createFinalizer:
        (value) => createPhase5CandidateCaptureFinalizer(value),
      createCaptureProtocol:
        (value) => createPhase5CaptureChannelProtocol(value),
      startCaptureServer:
        (value) => startPhase5CaptureChannelServer(value),
      createAbortController: () => new AbortController(),
      scheduleTimeout:
        (handler, milliseconds) => scheduleTimeout(
          handler,
          milliseconds,
        ),
      cancelTimeout:
        (token) => cancelScheduledTimeout(token),
    });
  } catch {
    fail();
  }
}
