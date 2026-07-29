import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { types } from 'node:util';

import {
  MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES,
} from '../../tools/lib/phase5-capture-channel-protocol.mjs';
import {
  PHASE5_CAPTURE_CHANNEL_SOCKET_PATH,
  Phase5CaptureChannelServerError,
  _startPhase5CaptureChannelServer,
  startPhase5CaptureChannelServer,
} from '../../tools/lib/phase5-capture-channel-server.mjs';

const UID = 1000;
const ADMISSION_BYTES = Buffer.from(
  '{"kind":"admission","schemaVersion":1}\n',
  'utf8',
);
const REQUEST_BYTES = Buffer.from(
  '{"kind":"request","schemaVersion":1}\n',
  'utf8',
);
const RESPONSE_BYTES = Buffer.from(
  '{"kind":"response","schemaVersion":1}\n',
  'utf8',
);
const PRIVATE_SOCKET_PATH =
  '/tmp/flock-phase5-probe/run-flock-phase5-candidate/capture.sock';

function mode(kind, permissions, uid = UID) {
  return {
    mode: kind | permissions,
    uid,
  };
}

function fixture(overrides = {}) {
  const socketPath = overrides.socketPath
    ?? PHASE5_CAPTURE_CHANNEL_SOCKET_PATH;
  const calls = [];
  const state = {
    socketExists: false,
    socketMode: 0o777,
  };
  const timers = [];
  const protocol = {
    getAdmissionBytes() {
      calls.push(['admission']);
      return Buffer.from(ADMISSION_BYTES);
    },
    handleFinalizeRequestBytes(value) {
      calls.push(['finalize', Buffer.from(value)]);
      if (!Buffer.from(value).equals(REQUEST_BYTES)) {
        throw new Error('request rejected');
      }
      return Buffer.from(RESPONSE_BYTES);
    },
  };
  const server = new FakeServer({
    onListen() {
      state.socketExists = true;
    },
  });
  const lstatSync = (path) => {
    if (path === '/') return mode(0o040000, 0o755, 0);
    if (path === '/tmp') return mode(0o040000, 0o1777, 0);
    if (path === '/tmp/flock-phase5-probe') {
      return mode(0o040000, 0o700);
    }
    if (path === '/run') return mode(0o040000, 0o755, 0);
    if (path === '/run/flock-phase5-candidate'
        || path === '/tmp/flock-phase5-probe/run-flock-phase5-candidate') {
      return mode(0o040000, 0o700);
    }
    if (path === socketPath) {
      if (!state.socketExists) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return mode(0o140000, state.socketMode);
    }
    throw new Error(`unexpected path: ${path}`);
  };
  const unlinkSync = (path) => {
    assert.equal(path, socketPath);
    if (!state.socketExists) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    state.socketExists = false;
    calls.push(['unlink']);
  };
  const chmodSync = (path, permissions) => {
    assert.equal(path, socketPath);
    state.socketMode = permissions;
    calls.push(['chmod', permissions]);
  };
  return {
    calls,
    protocol,
    server,
    state,
    options: {
      protocol,
      signal: null,
      socketPath,
      platform: 'linux',
      getuid: () => UID,
      createServer: (handler) => {
        server.connectionHandler = handler;
        return server;
      },
      lstatSync,
      unlinkSync,
      chmodSync,
      scheduleTimeout: (handler, milliseconds) => {
        const token = {
          handler,
          milliseconds,
          cancelled: false,
        };
        timers.push(token);
        return token;
      },
      cancelTimeout: (token) => {
        token.cancelled = true;
      },
      ...overrides,
    },
    timers,
  };
}

class FakeServer extends EventEmitter {
  constructor({ onListen }) {
    super();
    this.onListen = onListen;
    this.afterListenCallback = null;
    this.connectionHandler = null;
    this.listenCalls = [];
    this.closeCalls = 0;
  }

  listen(path, callback) {
    this.listenCalls.push(path);
    this.onListen();
    callback();
    this.afterListenCallback?.();
  }

  close(callback = () => {}) {
    this.closeCalls += 1;
    callback();
  }

  connect(socket) {
    this.connectionHandler(socket);
  }
}

class FakeSocket extends EventEmitter {
  constructor({ flushImmediately = true } = {}) {
    super();
    this.flushImmediately = flushImmediately;
    this.pauses = 0;
    this.resumes = 0;
    this.timeout = null;
    this.timeoutHandler = null;
    this.endedWith = [];
    this.endCallbacks = [];
    this.destroyed = false;
  }

  pause() {
    this.pauses += 1;
  }

  resume() {
    this.resumes += 1;
  }

  setTimeout(timeout, handler) {
    this.timeout = timeout;
    this.timeoutHandler = handler;
  }

  end(value, callback = () => {}) {
    this.endedWith.push(Buffer.from(value));
    this.endCallbacks.push(callback);
    if (this.flushImmediately) callback();
  }

  flushEnd() {
    this.endCallbacks.shift()?.();
  }

  destroy() {
    this.destroyed = true;
  }
}

function errorCode(code) {
  return (error) => (
    error instanceof Phase5CaptureChannelServerError
    && error.code === code
  );
}

test('public server exposes no dependency or path substitution seams', async () => {
  assert.equal(startPhase5CaptureChannelServer.length, 1);
  assert.match(
    startPhase5CaptureChannelServer.toString(),
    /socketPath:\s*PHASE5_CAPTURE_CHANNEL_SOCKET_PATH/u,
  );
  assert.deepEqual(
    Object.keys({ protocol: null }),
    ['protocol'],
  );
  await assert.rejects(
    startPhase5CaptureChannelServer({
      protocol: {},
      socketPath: PRIVATE_SOCKET_PATH,
    }),
    errorCode('PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED'),
  );
});

test('listens once on the fixed socket and returns owned admission bytes', async () => {
  const value = fixture();
  const service = await _startPhase5CaptureChannelServer(
    value.options,
  );

  assert.deepEqual(
    value.server.listenCalls,
    [PHASE5_CAPTURE_CHANNEL_SOCKET_PATH],
  );
  assert.deepEqual(
    value.calls.slice(0, 2),
    [['admission'], ['chmod', 0o600]],
  );
  const first = service.getAdmissionBytes();
  first.fill(0);
  assert.deepEqual(service.getAdmissionBytes(), ADMISSION_BYTES);
  assert.deepEqual(Object.keys(service).sort(), [
    'close',
    'getAdmissionBytes',
    'waitForTerminal',
  ]);
});

test('private kernel accepts a canonical controller bind-source socket path',
    async () => {
      const value = fixture({ socketPath: PRIVATE_SOCKET_PATH });
      const service = await _startPhase5CaptureChannelServer(
        value.options,
      );

      assert.deepEqual(value.server.listenCalls, [PRIVATE_SOCKET_PATH]);
      await service.close();
    });

test('an already-aborted startup signal consumes protocol before listen',
    async () => {
      const controller = new AbortController();
      controller.abort();
      const value = fixture({ signal: controller.signal });

      await assert.rejects(
        _startPhase5CaptureChannelServer(value.options),
        errorCode('PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED'),
      );
      assert.deepEqual(value.server.listenCalls, []);
      assert.deepEqual(
        value.calls.at(-1),
        ['finalize', Buffer.alloc(0)],
      );
      assert.equal(value.state.socketExists, false);
    });

test('abort during listen closes and unlinks a late socket before reject',
    async () => {
      const controller = new AbortController();
      const value = fixture({ signal: controller.signal });
      let finishListen;
      value.server.listen = function listen(path, callback) {
        this.listenCalls.push(path);
        value.state.socketExists = true;
        finishListen = callback;
      };

      const starting = _startPhase5CaptureChannelServer(
        value.options,
      );
      await Promise.resolve();
      controller.abort();
      await assert.rejects(
        starting,
        errorCode('PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED'),
      );
      assert.equal(value.server.closeCalls >= 1, true);
      assert.equal(value.state.socketExists, false);
      value.state.socketExists = true;
      finishListen();
      assert.equal(value.state.socketExists, false);
    });

test('first connection closes listener and unlinks before finalizing', async () => {
  const value = fixture();
  const service = await _startPhase5CaptureChannelServer(
    value.options,
  );
  const peer = new FakeSocket();

  value.server.connect(peer);
  assert.equal(value.server.closeCalls, 1);
  assert.equal(value.state.socketExists, false);
  assert.equal(peer.pauses, 1);
  assert.equal(peer.resumes, 1);

  peer.emit('data', Buffer.from(REQUEST_BYTES));
  peer.emit('end');

  assert.deepEqual(
    value.calls.slice(-2),
    [
      ['unlink'],
      ['finalize', REQUEST_BYTES],
    ],
  );
  assert.deepEqual(peer.endedWith, [RESPONSE_BYTES]);
  assert.equal(peer.destroyed, false);
  await service.close();
});

test('a second accepted peer is destroyed without a second finalize', async () => {
  const value = fixture();
  const service = await _startPhase5CaptureChannelServer(
    value.options,
  );
  const first = new FakeSocket();
  const second = new FakeSocket();

  value.server.connect(first);
  value.server.connect(second);
  first.emit('data', Buffer.from(REQUEST_BYTES));
  first.emit('end');

  assert.equal(second.destroyed, true);
  assert.equal(
    value.calls.filter(([kind]) => kind === 'finalize').length,
    1,
  );
  await service.close();
});

test('oversize request consumes protocol with an empty request and destroys peer',
    async () => {
      const value = fixture();
      const service = await _startPhase5CaptureChannelServer(
        value.options,
      );
      const peer = new FakeSocket();

      value.server.connect(peer);
      peer.emit(
        'data',
        Buffer.alloc(
          MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES + 1,
          0x20,
        ),
      );

      assert.equal(peer.destroyed, true);
      assert.deepEqual(
        value.calls.at(-1),
        ['finalize', Buffer.alloc(0)],
      );
      await service.close();
    });

test('timeout and socket error each consume a fresh protocol exactly once',
    async () => {
      for (const trigger of [
        (_peer, value) => value.timers[0].handler(),
        (peer) => peer.emit('error', new Error('peer failed')),
      ]) {
        const value = fixture();
        const service = await _startPhase5CaptureChannelServer(
          value.options,
        );
        const peer = new FakeSocket();

        value.server.connect(peer);
        trigger(peer, value);

        assert.equal(peer.destroyed, true);
        assert.deepEqual(
          value.calls.filter(([kind]) => kind === 'finalize'),
          [['finalize', Buffer.alloc(0)]],
        );
        await assert.rejects(
          service.waitForTerminal(),
          errorCode('PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED'),
        );
        await service.close();
      }
    });

test('absolute deadline is not extended by slow request chunks',
    async () => {
      const value = fixture();
      const service = await _startPhase5CaptureChannelServer(
        value.options,
      );
      const peer = new FakeSocket();

      value.server.connect(peer);
      for (let index = 0; index < 10; index += 1) {
        peer.emit('data', Buffer.from('x'));
      }

      assert.equal(value.timers.length, 1);
      assert.equal(value.timers[0].milliseconds, 5000);
      assert.equal(value.timers[0].cancelled, false);
      value.timers[0].handler();

      assert.equal(peer.destroyed, true);
      assert.equal(value.timers[0].cancelled, true);
      assert.deepEqual(
        value.calls.at(-1),
        ['finalize', Buffer.alloc(0)],
      );
      await service.close();
    });

test('absolute deadline remains armed when the response does not flush',
    async () => {
      const value = fixture();
      const service = await _startPhase5CaptureChannelServer(
        value.options,
      );
      const peer = new FakeSocket({ flushImmediately: false });

      value.server.connect(peer);
      peer.emit('data', Buffer.from(REQUEST_BYTES));
      peer.emit('end');

      assert.deepEqual(peer.endedWith, [RESPONSE_BYTES]);
      assert.equal(value.timers[0].cancelled, false);
      value.timers[0].handler();

      assert.equal(peer.destroyed, true);
      assert.equal(value.timers[0].cancelled, true);
      peer.flushEnd();
      await service.close();
    });

test('response deadline clears only after flush and peer close',
    async () => {
      const value = fixture();
      const service = await _startPhase5CaptureChannelServer(
        value.options,
      );
      const peer = new FakeSocket();

      value.server.connect(peer);
      peer.emit('data', Buffer.from(REQUEST_BYTES));
      peer.emit('end');

      assert.equal(value.timers[0].cancelled, false);
      peer.emit('close');
      assert.equal(value.timers[0].cancelled, true);
      assert.equal(peer.destroyed, false);
      assert.equal(await service.waitForTerminal(), 'completed');
      await service.close();
    });

test('close destroys an active peer and awaits the original listener close',
    async () => {
      const value = fixture();
      const closeCallbacks = [];
      value.server.close = function close(callback = () => {}) {
        this.closeCalls += 1;
        closeCallbacks.push(callback);
      };
      const service = await _startPhase5CaptureChannelServer(
        value.options,
      );
      const peer = new FakeSocket();
      value.server.connect(peer);
      let closed = false;

      const closing = service.close().then(() => {
        closed = true;
      });
      await Promise.resolve();

      assert.equal(peer.destroyed, true);
      assert.equal(closed, false);
      assert.equal(closeCallbacks.length, 1);
      closeCallbacks[0]();
      await closing;
      assert.equal(closed, true);
      assert.equal(await service.waitForTerminal(), 'closed');
    });

test('post-start server error consumes, unlinks and closes active state',
    async () => {
      const value = fixture();
      const service = await _startPhase5CaptureChannelServer(
        value.options,
      );
      const peer = new FakeSocket();
      value.server.connect(peer);

      value.server.emit('error', new Error('listener failed'));

      assert.equal(peer.destroyed, true);
      assert.equal(value.state.socketExists, false);
      assert.equal(value.server.closeCalls, 1);
      assert.deepEqual(
        value.calls.filter(([kind]) => kind === 'finalize'),
        [['finalize', Buffer.alloc(0)]],
      );
      await assert.rejects(
        service.waitForTerminal(),
        errorCode('PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED'),
      );
      await service.close();
    });

test('server error immediately after listen callback cannot escape startup',
    async () => {
      const value = fixture();
      value.server.afterListenCallback = () => {
        value.server.emit(
          'error',
          new Error('synchronous post-listen failure'),
        );
      };

      await assert.rejects(
        _startPhase5CaptureChannelServer(value.options),
        errorCode('PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED'),
      );
      assert.equal(value.state.socketExists, false);
      assert.equal(value.server.closeCalls, 1);
      assert.deepEqual(
        value.calls.filter(([kind]) => kind === 'finalize'),
        [['finalize', Buffer.alloc(0)]],
      );
    });

test('unlink failure consumes protocol before any request can be read',
    async () => {
      const value = fixture({
        unlinkSync() {
          const error = new Error('unlink failed');
          error.code = 'EACCES';
          throw error;
        },
      });
      const service = await _startPhase5CaptureChannelServer(
        value.options,
      );
      const peer = new FakeSocket();

      value.server.connect(peer);

      assert.equal(peer.destroyed, true);
      assert.equal(peer.resumes, 0);
      assert.deepEqual(
        value.calls.at(-1),
        ['finalize', Buffer.alloc(0)],
      );
      await assert.rejects(
        service.close(),
        errorCode('PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED'),
      );
    });

test('request chunks require exact owned Buffers and fixed total bytes',
    async () => {
      class BufferSubclass extends Uint8Array {}
      const invalidChunks = [
        new Proxy(Buffer.from(REQUEST_BYTES), {}),
        new BufferSubclass(REQUEST_BYTES),
        new Uint8Array(REQUEST_BYTES),
      ];

      for (const chunk of invalidChunks) {
        const value = fixture();
        const service = await _startPhase5CaptureChannelServer(
          value.options,
        );
        const peer = new FakeSocket();
        value.server.connect(peer);

        peer.emit('data', chunk);

        assert.equal(peer.destroyed, true);
        assert.deepEqual(
          value.calls.at(-1),
          ['finalize', Buffer.alloc(0)],
        );
        await service.close();
      }
    });

test('startup rejects wrong platform, unsafe parents, occupied path and proxy protocol',
    async () => {
      const attacks = [
        (value) => { value.options.platform = 'win32'; },
        (value) => {
          value.options.lstatSync = (path) => {
            if (path === '/run/flock-phase5-candidate') {
              return mode(0o040000, 0o770);
            }
            return fixture().options.lstatSync(path);
          };
        },
        (value) => {
          value.options.lstatSync = (path) => {
            if (path === '/run/flock-phase5-candidate') {
              return mode(0o040000, 0o1700);
            }
            return fixture().options.lstatSync(path);
          };
        },
        (value) => { value.state.socketExists = true; },
        (value) => {
          value.options.protocol = new Proxy(value.protocol, {});
        },
      ];

      for (const attack of attacks) {
        const value = fixture();
        attack(value);
        await assert.rejects(
          _startPhase5CaptureChannelServer(value.options),
          errorCode('PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED'),
        );
      }
    });

test('private socket path is canonical, bounded and fixed-name', async () => {
  for (const socketPath of [
    true,
    'relative/run-flock-phase5-candidate/capture.sock',
    '/tmp/flock-phase5-probe/not-the-candidate/capture.sock',
    '/tmp/flock-phase5-probe/run-flock-phase5-candidate/not-capture.sock',
    '/tmp/flock-phase5-probe/../run-flock-phase5-candidate/capture.sock',
    '/tmp//flock-phase5-probe/run-flock-phase5-candidate/capture.sock',
    '/tmp/flock-phase5-probe/run-flock-phase5-candidate/capture.sock\0x',
    `/${'x'.repeat(108)}/run-flock-phase5-candidate/capture.sock`,
  ]) {
    const value = fixture({ socketPath });
    await assert.rejects(
      _startPhase5CaptureChannelServer(value.options),
      errorCode('PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED'),
    );
  }
});

test('server options are exact data properties and do not invoke accessors',
    async () => {
      const value = fixture();
      let getterCalls = 0;
      Object.defineProperty(value.options, 'hidden', {
        enumerable: true,
        get() {
          getterCalls += 1;
          return true;
        },
      });

      await assert.rejects(
        _startPhase5CaptureChannelServer(value.options),
        errorCode('PHASE5_CAPTURE_CHANNEL_SERVER_REQUIRED'),
      );
      assert.equal(getterCalls, 0);
      assert.equal(types.isProxy(value.options), false);
    });
