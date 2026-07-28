import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { runLegacyLease } from '../../tools/legacy-lease.mjs';

const BROWSER_AUTHORITY = '127.0.0.1:18090';
const CANDIDATE_ORIGIN = `http://${BROWSER_AUTHORITY}`;
const BOOTSTRAP = Object.freeze({
  clientId: 'candidate-client',
  bootstrapToken: 'candidate-bootstrap',
  worldGeneration: 'world-7',
  revision: 41,
  eventSeq: 73,
});

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeWritable extends EventEmitter {
  constructor({ mode = 'ok', calls, values }) {
    super();
    this.mode = mode;
    this.calls = calls;
    this.values = values;
  }

  write(value, callback) {
    this.calls.push(['stdout.write']);
    this.values.push(String(value));
    if (this.mode === 'throw') throw Object.assign(new Error('broken stdout'), { code: 'EPIPE' });
    if (this.mode === 'epipe') {
      queueMicrotask(() => {
        const error = Object.assign(new Error('pipe closed'), { code: 'EPIPE' });
        this.emit('error', error);
        callback?.(error);
      });
      return false;
    }
    if (this.mode === 'timeout') return false;
    queueMicrotask(() => callback?.());
    return true;
  }
}

function createHarness({
  bootstrapStatus = 200,
  bootstrapBody = JSON.stringify(BOOTSTRAP),
  bootstrapMode = 'ok',
  rejectCommand = null,
  hangCommand = null,
  openMode = 'ok',
  signalOnCommand = null,
  signalsToEmit = [],
  stdoutMode = 'ok',
  autoTimers = [],
} = {}) {
  const calls = [];
  const frames = [];
  const sockets = [];
  const requests = [];
  const agents = [];
  const timers = [];
  const stdout = [];
  const stderr = [];
  const signals = new EventEmitter();
  const stdoutWritable = new FakeWritable({
    mode: stdoutMode,
    calls,
    values: stdout,
  });
  let commandSequence = 0;

  class FakeAgent {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      agents.push(this);
      calls.push(['agent', options]);
    }

    destroy() {
      this.destroyed = true;
      calls.push(['agent.destroy']);
    }
  }

  function schedule(callback, milliseconds) {
    const handle = { callback, milliseconds, cleared: false };
    timers.push(handle);
    if (autoTimers.includes(milliseconds)) {
      setImmediate(() => {
        if (!handle.cleared) callback();
      });
    }
    return handle;
  }

  function clearScheduled(handle) {
    if (handle) handle.cleared = true;
  }

  function request(options, onResponse) {
    const requestObject = new EventEmitter();
    requestObject.options = options;
    requestObject.destroyed = false;
    requestObject.ended = false;
    requestObject.end = () => {
      requestObject.ended = true;
      calls.push(['http.end']);
      if (bootstrapMode === 'hang') return;
      queueMicrotask(() => {
        if (requestObject.destroyed) return;
        const response = new EventEmitter();
        response.statusCode = bootstrapStatus;
        response.headers = {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(bootstrapBody)),
        };
        response.destroyed = false;
        response.destroy = (error) => {
          response.destroyed = true;
          if (error) queueMicrotask(() => response.emit('error', error));
        };
        onResponse(response);
        if (bootstrapMode === 'response-hang') return;
        queueMicrotask(() => {
          if (response.destroyed) return;
          response.emit('data', Buffer.from(bootstrapBody));
          response.emit('end');
        });
      });
    };
    requestObject.destroy = (error) => {
      requestObject.destroyed = true;
      calls.push(['http.destroy', error?.message]);
      if (error) queueMicrotask(() => requestObject.emit('error', error));
    };
    requests.push(requestObject);
    calls.push(['http.request', options]);
    return requestObject;
  }

  class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, options) {
      super();
      this.url = String(url);
      this.options = options;
      this.readyState = FakeWebSocket.CONNECTING;
      this.terminated = false;
      sockets.push(this);
      calls.push(['websocket', this.url, options]);
      if (openMode === 'ok') {
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.emit('open');
        });
      }
    }

    send(serialized) {
      const frame = JSON.parse(String(serialized));
      frames.push(frame);
      const name = frame.type === 'command' ? frame.name : frame.type;
      calls.push(['send', name]);
      if (signalOnCommand === name) {
        for (const signal of signalsToEmit) signals.emit(signal);
      }
      if (frame.type === 'hello') {
        queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
          type: 'ready',
          worldGeneration: BOOTSTRAP.worldGeneration,
          revision: BOOTSTRAP.revision,
          eventSeq: BOOTSTRAP.eventSeq,
        }))));
        return;
      }
      if (frame.name === hangCommand) return;
      let response;
      if (frame.name === rejectCommand) {
        response = {
          type: 'command.result',
          commandId: frame.commandId,
          accepted: false,
          code: `${frame.name}.denied`,
        };
      } else if (frame.name === 'maintenance.authenticate') {
        response = {
          type: 'command.result',
          commandId: frame.commandId,
          accepted: true,
          maintenanceToken: 'maintenance-grant',
        };
      } else if (frame.name === 'legacy.take') {
        response = {
          type: 'command.result',
          commandId: frame.commandId,
          accepted: true,
          leaseToken: 'lease-new',
          taken: true,
        };
      } else if (frame.name === 'legacy.heartbeat') {
        response = {
          type: 'command.result',
          commandId: frame.commandId,
          accepted: true,
          renewed: true,
        };
      } else {
        response = {
          type: 'command.result',
          commandId: frame.commandId,
          accepted: true,
          released: true,
        };
      }
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(response))));
    }

    close() {
      calls.push(['close']);
      this.readyState = FakeWebSocket.CLOSING;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.CLOSED;
        this.emit('close');
      });
    }

    terminate() {
      calls.push(['terminate']);
      this.terminated = true;
      this.readyState = FakeWebSocket.CLOSED;
      queueMicrotask(() => {
        this.emit('error', new Error('delayed abortHandshake error'));
        this.emit('close');
      });
    }
  }

  const dependencies = {
    async readFile(path, encoding) {
      calls.push(['readFile', path, encoding]);
      return 'fixed-secret\n';
    },
    fetch() {
      throw new Error('FETCH_MUST_NOT_BE_USED');
    },
    httpRequest: request,
    HttpAgent: FakeAgent,
    WebSocket: FakeWebSocket,
    randomUUID() {
      commandSequence += 1;
      return `command-${commandSequence}`;
    },
    setTimeout: schedule,
    clearTimeout: clearScheduled,
    signals,
  };

  return {
    agents,
    calls,
    dependencies,
    frames,
    requests,
    signals,
    sockets,
    stderr,
    stdout,
    stdoutWritable,
    timers,
    options(argv, env = {}) {
      return {
        argv,
        env,
        dependencies,
        stdout: stdoutWritable,
        stderr: { write(value) { stderr.push(String(value)); return true; } },
      };
    },
  };
}

function commandNames(harness) {
  return harness.frames
    .filter(({ type }) => type === 'command')
    .map(({ name }) => name);
}

function releases(harness) {
  return commandNames(harness).filter((name) => name === 'legacy.release');
}

test('hold uses fixed container transport with exact browser Host and Origin over direct agents',
  async () => {
    const harness = createHarness({
      signalOnCommand: 'legacy.heartbeat',
      signalsToEmit: ['SIGTERM'],
      autoTimers: [750],
    });

    const outcome = await runLegacyLease(harness.options(['hold', 'decoder-a']));

    assert.deepEqual(outcome, { exitCode: 143 });
    assert.equal(harness.requests.length, 1);
    assert.deepEqual(harness.requests[0].options, {
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: 8090,
      method: 'GET',
      path: '/api/v1/bootstrap',
      headers: {
        Host: BROWSER_AUTHORITY,
        Origin: CANDIDATE_ORIGIN,
        Accept: 'application/json',
      },
      agent: harness.agents[0],
      localAddress: '127.0.0.1',
      setHost: false,
    });
    assert.equal(harness.sockets[0].url, 'ws://127.0.0.1:8090/api/v1/runtime');
    assert.deepEqual(harness.sockets[0].options, {
      agent: harness.agents[1],
      followRedirects: false,
      handshakeTimeout: 5_000,
      headers: { Host: BROWSER_AUTHORITY },
      localAddress: '127.0.0.1',
      origin: CANDIDATE_ORIGIN,
    });
    assert.notEqual(harness.agents[0], harness.agents[1]);
    assert.deepEqual(harness.agents.map(({ options }) => options), [
      { keepAlive: false, localAddress: '127.0.0.1' },
      { keepAlive: false, localAddress: '127.0.0.1' },
    ]);
    assert.deepEqual(commandNames(harness), [
      'maintenance.authenticate', 'legacy.take', 'legacy.heartbeat', 'legacy.release',
    ]);
    assert.equal(releases(harness).length, 1);
    assert.deepEqual(harness.stdout, ['{"status":"holding"}\n']);
    assert.equal(harness.agents.every(({ destroyed }) => destroyed), true);
  });

test('bootstrap rejects redirects, oversized bodies, invalid JSON, and invalid schema before WS',
  async (t) => {
    const cases = [
      ['redirect', { bootstrapStatus: 302 }, /BOOTSTRAP_HTTP_302/],
      ['oversized', { bootstrapBody: 'x'.repeat(65_537) }, /BOOTSTRAP_BODY_TOO_LARGE/],
      ['invalid JSON', { bootstrapBody: '{' }, /BOOTSTRAP_JSON_INVALID/],
      ['invalid schema', {
        bootstrapBody: JSON.stringify({ ...BOOTSTRAP, revision: -1 }),
      }, /BOOTSTRAP_SCHEMA_INVALID/],
    ];
    for (const [name, setup, expected] of cases) {
      await t.test(name, async () => {
        const harness = createHarness(setup);
        await assert.rejects(
          runLegacyLease(harness.options(['hold', 'decoder-a'])),
          expected,
        );
        assert.equal(harness.sockets.length, 0);
      });
    }
  });

test('bootstrap total timeout covers both connection and incomplete response', async () => {
  for (const bootstrapMode of ['hang', 'response-hang']) {
    const harness = createHarness({
      bootstrapMode,
      autoTimers: [5_000],
    });

    await assert.rejects(
      runLegacyLease(harness.options(['hold', 'decoder-a'])),
      /BOOTSTRAP_TIMEOUT/,
    );

    assert.equal(harness.requests[0].destroyed, true);
    assert.equal(harness.sockets.length, 0);
  }
});

test('signal handlers exist before legacy.take and repeated signals release exactly once', async () => {
  const harness = createHarness({
    signalOnCommand: 'legacy.take',
    signalsToEmit: ['SIGTERM', 'SIGINT', 'SIGTERM'],
  });

  const outcome = await runLegacyLease(harness.options(['hold', 'decoder-signal']));

  assert.equal(outcome.exitCode, 143);
  assert.equal(harness.stdout.length, 0);
  assert.equal(releases(harness).length, 1);
  assert.equal(harness.signals.listenerCount('SIGINT'), 0);
  assert.equal(harness.signals.listenerCount('SIGTERM'), 0);
});

test('SIGINT during hold heartbeat releases once and returns shell exit code 130', async () => {
  const harness = createHarness({
    signalOnCommand: 'legacy.heartbeat',
    signalsToEmit: ['SIGINT', 'SIGINT'],
    autoTimers: [750],
  });

  const outcome = await runLegacyLease(harness.options(['hold', 'decoder-hold']));

  assert.equal(outcome.exitCode, 130);
  assert.deepEqual(commandNames(harness), [
    'maintenance.authenticate', 'legacy.take', 'legacy.heartbeat', 'legacy.release',
  ]);
  assert.equal(harness.signals.listenerCount('SIGINT'), 0);
  assert.equal(harness.signals.listenerCount('SIGTERM'), 0);
});

test('hold never exposes maintenance or lease tokens in its result or output', async () => {
  const harness = createHarness({
    signalOnCommand: 'legacy.heartbeat',
    signalsToEmit: ['SIGINT'],
    autoTimers: [750],
  });

  const outcome = await runLegacyLease(harness.options(['hold', 'decoder-sanitized']));

  assert.deepEqual(outcome, { exitCode: 130 });
  assert.deepEqual(harness.stdout, ['{"status":"holding"}\n']);
  assert.deepEqual(harness.stderr, []);
  const observable = JSON.stringify({
    outcome,
    stdout: harness.stdout,
    stderr: harness.stderr,
  });
  assert.doesNotMatch(observable, /maintenance-grant|lease-new|fixed-secret/);
});

test('hold validates its lease token before attempting sanitized stdout', async () => {
  const harness = createHarness();
  const originalSend = harness.dependencies.WebSocket.prototype.send;
  harness.dependencies.WebSocket.prototype.send = function send(serialized) {
    const frame = JSON.parse(String(serialized));
    if (frame.name !== 'legacy.take') return originalSend.call(this, serialized);
    harness.frames.push(frame);
    harness.calls.push(['send', frame.name]);
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
      type: 'command.result',
      commandId: frame.commandId,
      accepted: true,
      taken: true,
    }))));
  };

  await assert.rejects(
    runLegacyLease(harness.options(['hold', 'decoder-invalid'])),
    /LEGACY_TAKE_LEASE_TOKEN_REQUIRED/,
  );

  assert.equal(harness.stdout.length, 0);
  assert.equal(releases(harness).length, 0);
});

test('sanitized stdout throw and EPIPE each cause exactly one bounded release', async (t) => {
  for (const stdoutMode of ['throw', 'epipe']) {
    await t.test(stdoutMode, async () => {
      const harness = createHarness({ stdoutMode });
      await assert.rejects(
        runLegacyLease(harness.options(['hold', `decoder-${stdoutMode}`])),
        /broken stdout|pipe closed/,
      );
      assert.equal(releases(harness).length, 1);
    });
  }
});

test('sanitized stdout flush timeout causes exactly one bounded release', async () => {
  const harness = createHarness({
    stdoutMode: 'timeout',
    autoTimers: [2_000],
  });

  await assert.rejects(
    runLegacyLease(harness.options(['hold', 'decoder-flush-timeout'])),
    /STDOUT_FLUSH_TIMEOUT/,
  );

  assert.equal(releases(harness).length, 1);
  assert.equal(harness.timers.some(({ milliseconds }) => milliseconds === 2_000), true);
});

test('stdout flush timeout retains an error sink for a delayed EPIPE', async () => {
  const harness = createHarness({
    stdoutMode: 'timeout',
    autoTimers: [2_000],
  });

  await assert.rejects(
    runLegacyLease(harness.options(['hold', 'decoder-late-epipe'])),
    /STDOUT_FLUSH_TIMEOUT/,
  );

  assert.equal(releases(harness).length, 1);
  assert.ok(harness.stdoutWritable.listenerCount('error') >= 1);
  assert.doesNotThrow(() => {
    harness.stdoutWritable.emit(
      'error',
      Object.assign(new Error('late EPIPE'), { code: 'EPIPE' }),
    );
  });
});

test('signal exit code remains authoritative when bounded release rejects or times out',
  async (t) => {
    const cases = [
      ['rejected release', {
        rejectCommand: 'legacy.release',
        signalOnCommand: 'legacy.heartbeat',
        signalsToEmit: ['SIGINT'],
        autoTimers: [750],
      }, 130],
      ['timed out release', {
        hangCommand: 'legacy.release',
        signalOnCommand: 'legacy.heartbeat',
        signalsToEmit: ['SIGTERM'],
        autoTimers: [750, 2_000],
      }, 143],
    ];
    for (const [name, setup, exitCode] of cases) {
      await t.test(name, async () => {
        const harness = createHarness(setup);
        const outcome = await runLegacyLease(
          harness.options(['hold', `decoder-${exitCode}`]),
        );
        assert.deepEqual(outcome, { exitCode });
        assert.equal(releases(harness).length, 1);
      });
    }
  });

test('signal remains authoritative when an in-flight heartbeat rejects or times out',
  async (t) => {
    const cases = [
      ['heartbeat rejected', {
        rejectCommand: 'legacy.heartbeat',
        signalOnCommand: 'legacy.heartbeat',
        signalsToEmit: ['SIGTERM'],
        autoTimers: [750],
      }, 143],
      ['heartbeat timed out', {
        hangCommand: 'legacy.heartbeat',
        signalOnCommand: 'legacy.heartbeat',
        signalsToEmit: ['SIGINT'],
        autoTimers: [750, 10_000],
      }, 130],
    ];
    for (const [name, setup, exitCode] of cases) {
      await t.test(name, async () => {
        const harness = createHarness(setup);
        const outcome = await runLegacyLease(
          harness.options(['hold', `decoder-heartbeat-${exitCode}`]),
        );
        assert.deepEqual(outcome, { exitCode });
        assert.equal(releases(harness).length, 1);
      });
    }
  });

test('signal remains authoritative when sanitized stdout fails after take', async () => {
  const harness = createHarness({ stdoutMode: 'epipe' });
  const originalWrite = harness.stdoutWritable.write.bind(harness.stdoutWritable);
  harness.stdoutWritable.write = (...args) => {
    harness.signals.emit('SIGTERM');
    return originalWrite(...args);
  };

  const outcome = await runLegacyLease(
    harness.options(['hold', 'decoder-stdout-signal']),
  );

  assert.deepEqual(outcome, { exitCode: 143 });
  assert.equal(releases(harness).length, 1);
});

test('a failed hold heartbeat makes only one bounded release attempt', async () => {
  const harness = createHarness({
    rejectCommand: 'legacy.heartbeat',
    autoTimers: [750],
  });

  await assert.rejects(
    runLegacyLease(harness.options(['hold', 'decoder-failure'])),
    /LEGACY_HEARTBEAT_REJECTED/,
  );

  assert.deepEqual(commandNames(harness), [
    'maintenance.authenticate', 'legacy.take', 'legacy.heartbeat', 'legacy.release',
  ]);
});

test('a hung release cannot make post-hold cleanup unbounded', async () => {
  const harness = createHarness({
    stdoutMode: 'throw',
    hangCommand: 'legacy.release',
    autoTimers: [2_000],
  });

  await assert.rejects(
    runLegacyLease(harness.options(['hold', 'decoder-release-timeout'])),
    /broken stdout/,
  );

  assert.equal(releases(harness).length, 1);
  assert.equal(harness.timers.some(({ milliseconds }) => milliseconds === 2_000), true);
});

test('open timeout terminates WS while retaining an error sink for delayed abort errors',
  async () => {
    const harness = createHarness({
      openMode: 'timeout',
      autoTimers: [5_000],
    });

    await assert.rejects(
      runLegacyLease(harness.options(['hold', 'decoder-open-timeout'])),
      /OPEN_TIMEOUT/,
    );
    await nextTurn();

    assert.equal(harness.sockets[0].terminated, true);
    assert.ok(harness.sockets[0].listenerCount('error') >= 1);
  });

test('only hold is supported and invalid decoder IDs fail before secret or network effects',
  async () => {
    const invalidInvocations = [
      ['take', 'decoder-a'],
      ['heartbeat', 'decoder-a', 'lease-from-argv'],
      ['release', 'decoder-a', 'lease-from-argv'],
      ['hold', 'decoder-a', 'unexpected-extra'],
      ['hold', '-leading-punctuation'],
      ['hold', 'decoder\ncontrol'],
      ['hold', 'decoder-雪'],
      ['hold', 'a'.repeat(161)],
    ];
    for (const argv of invalidInvocations) {
      const harness = createHarness({
        signalOnCommand: 'legacy.take',
        signalsToEmit: ['SIGTERM'],
      });
      const outcome = await runLegacyLease(harness.options(argv));
      assert.deepEqual(outcome, { exitCode: 2 });
      assert.deepEqual(harness.calls, []);
      assert.equal(harness.stderr.join(''), 'usage: legacy-lease.mjs hold <decoderSessionId>\n');
      assert.doesNotMatch(harness.stderr.join(''), /lease-from-argv|unexpected-extra/);
    }
  });

test('decoder IDs at the protocol maximum length remain valid', async () => {
  const decoderSessionId = 'a'.repeat(160);
  const harness = createHarness({
    signalOnCommand: 'legacy.take',
    signalsToEmit: ['SIGTERM'],
  });

  const outcome = await runLegacyLease(harness.options(['hold', decoderSessionId]));

  assert.deepEqual(outcome, { exitCode: 143 });
  const take = harness.frames.find(({ name }) => name === 'legacy.take');
  assert.equal(take.payload.decoderSessionId, decoderSessionId);
  assert.equal(releases(harness).length, 1);
});

test('authority overrides and missing CLI arguments fail before secret or network effects',
  async () => {
  for (const name of ['FLOCK_RUNTIME_URL', 'FLOCK_RUNTIME_ORIGIN']) {
    const harness = createHarness();
    await assert.rejects(
      runLegacyLease(harness.options(['hold', 'decoder-a'], {
        [name]: CANDIDATE_ORIGIN,
      })),
      new RegExp(`MAINTENANCE_AUTHORITY_OVERRIDE_FORBIDDEN:${name}`),
    );
    assert.deepEqual(harness.calls, []);
  }

  const harness = createHarness();
  const outcome = await runLegacyLease(harness.options(['hold']));
  assert.equal(outcome.exitCode, 2);
  assert.equal(harness.stderr.join(''), 'usage: legacy-lease.mjs hold <decoderSessionId>\n');
  assert.deepEqual(harness.calls, []);
});
