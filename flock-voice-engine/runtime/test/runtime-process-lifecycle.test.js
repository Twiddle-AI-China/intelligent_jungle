import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  createRuntimeProcessLifecycle,
} from '../src/runtime-process-lifecycle.js';

const flush = () => new Promise((resolve) => {
  setImmediate(resolve);
});

async function within(promise, milliseconds = 100) {
  let handle;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        handle = setTimeout(
          () => resolve(Symbol.for('timeout')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(handle);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

function fixture({
  captureWaitForFailure = () => new Promise(() => {}),
  captureStart = async () => true,
  captureClose = async () => true,
  appStart = async () => true,
  appStop = async () => true,
  setExitCode = async () => true,
} = {}) {
  const calls = [];
  const signalSource = new EventEmitter();
  const exitCodes = [];
  const lifecycle = createRuntimeProcessLifecycle({
    capture: Object.freeze({
      async start() {
        calls.push('capture.start');
        return captureStart();
      },
      async close() {
        calls.push('capture.close');
        return captureClose();
      },
      waitForFailure() {
        calls.push('capture.waitForFailure');
        return captureWaitForFailure();
      },
    }),
    app: Object.freeze({
      async start() {
        calls.push('app.start');
        return appStart();
      },
      async stop() {
        calls.push('app.stop');
        return appStop();
      },
    }),
    signalSource,
    setExitCode(value) {
      exitCodes.push(value);
      return setExitCode(value);
    },
  });
  return {
    calls,
    exitCodes,
    lifecycle,
    signalSource,
  };
}

test('failure monitoring and signal handlers exist before bootstrap',
    async () => {
      const bootstrap = deferred();
      const value = fixture({
        captureStart: () => bootstrap.promise,
      });

      assert.equal(value.signalSource.listenerCount('SIGINT'), 1);
      assert.equal(value.signalSource.listenerCount('SIGTERM'), 1);
      const starting = value.lifecycle.start();
      assert.deepEqual(value.calls, [
        'capture.waitForFailure',
        'capture.start',
      ]);

      bootstrap.resolve(true);
      assert.equal(await starting, true);
      assert.deepEqual(value.calls, [
        'capture.waitForFailure',
        'capture.start',
        'app.start',
      ]);
      await value.lifecycle.stop();
    });

test('signal during bootstrap closes both owners and never starts app',
    async () => {
      const bootstrap = deferred();
      const value = fixture({
        captureStart: () => bootstrap.promise,
      });
      const starting = value.lifecycle.start();

      value.signalSource.emit('SIGTERM');
      await flush();
      assert.deepEqual(value.calls, [
        'capture.waitForFailure',
        'capture.start',
        'capture.close',
        'app.stop',
      ]);

      bootstrap.reject(new Error('BOOTSTRAP_ABORTED'));
      assert.equal(await starting, false);
      assert.deepEqual(value.exitCodes, [0]);
      assert.equal(value.calls.includes('app.start'), false);
    });

test('capture failure during bootstrap owns rejection and exits one',
    async () => {
      const failure = deferred();
      const bootstrap = deferred();
      const closing = deferred();
      const appStopping = deferred();
      const unhandled = [];
      const onUnhandled = (error) => {
        unhandled.push(error);
      };
      const value = fixture({
        captureWaitForFailure: () => failure.promise,
        captureStart: () => bootstrap.promise,
        captureClose: () => closing.promise,
        appStop: () => appStopping.promise,
      });
      const starting = value.lifecycle.start();
      process.on('unhandledRejection', onUnhandled);
      try {
        failure.reject(new Error('CAPTURE_AUTHORITY_DIED'));
        await flush();
        assert.deepEqual(value.calls, [
          'capture.waitForFailure',
          'capture.start',
          'capture.close',
          'app.stop',
        ]);
        assert.equal(value.calls.includes('app.start'), false);
        assert.deepEqual(value.exitCodes, []);

        closing.resolve(true);
        appStopping.resolve(true);
        await flush();
        assert.deepEqual(value.exitCodes, [1]);

        bootstrap.reject(new Error('BOOTSTRAP_ABORTED'));
        assert.equal(await starting, false);
        await flush();
        assert.deepEqual(unhandled, []);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

test('invalid failure monitors fail closed before bootstrap',
    async () => {
      for (const captureWaitForFailure of [
        () => {
          throw new Error('FAILURE_MONITOR_BROKEN');
        },
        () => undefined,
        () => Object.freeze({}),
      ]) {
        const value = fixture({ captureWaitForFailure });

        assert.equal(await value.lifecycle.start(), false);
        assert.deepEqual(value.calls, [
          'capture.waitForFailure',
          'capture.close',
          'app.stop',
        ]);
        assert.deepEqual(value.exitCodes, [1]);
      }
    });

test('a deceptive thenable cannot reach bootstrap before failing closed',
    async () => {
      let reads = 0;
      const deceptive = {};
      Object.defineProperty(deceptive, 'then', {
        get() {
          reads += 1;
          if (reads === 1) return () => {};
          throw new Error('SECOND_THEN_READ_FAILED');
        },
      });
      const value = fixture({
        captureWaitForFailure: () => deceptive,
      });

      assert.equal(await value.lifecycle.start(), false);
      assert.deepEqual(value.calls, [
        'capture.waitForFailure',
        'capture.close',
        'app.stop',
      ]);
      assert.deepEqual(value.exitCodes, [1]);
    });

test('normal capture monitor completion requires no action',
    async () => {
      const value = fixture({
        captureWaitForFailure: async () => true,
      });

      assert.equal(await value.lifecycle.start(), true);
      await flush();
      assert.deepEqual(value.calls, [
        'capture.waitForFailure',
        'capture.start',
        'app.start',
      ]);
      assert.deepEqual(value.exitCodes, []);
      await value.lifecycle.stop();
    });

test('capture failure during app start stops both owners once',
    async () => {
      const failure = deferred();
      const appStarting = deferred();
      const value = fixture({
        captureWaitForFailure: () => failure.promise,
        appStart: () => appStarting.promise,
      });
      const starting = value.lifecycle.start();
      await flush();
      assert.deepEqual(value.calls, [
        'capture.waitForFailure',
        'capture.start',
        'app.start',
      ]);

      failure.reject(new Error('CAPTURE_AUTHORITY_DIED'));
      await flush();
      assert.equal(
        value.calls.filter((name) => name === 'capture.close').length,
        1,
      );
      assert.equal(
        value.calls.filter((name) => name === 'app.stop').length,
        1,
      );
      assert.deepEqual(value.exitCodes, [1]);

      appStarting.reject(new Error('APP_START_ABORTED'));
      assert.equal(await starting, false);
    });

test('signal during a hung app start settles after owned cleanup',
    async () => {
      const appStarting = deferred();
      const value = fixture({
        appStart: () => appStarting.promise,
      });
      const starting = value.lifecycle.start();
      await flush();

      value.signalSource.emit('SIGTERM');
      assert.equal(await within(starting), false);
      assert.deepEqual(value.exitCodes, [0]);
      assert.equal(
        value.calls.filter(
          (name) => name === 'capture.close',
        ).length,
        1,
      );
      assert.equal(
        value.calls.filter((name) => name === 'app.stop').length,
        1,
      );

      appStarting.reject(new Error('LATE_APP_START_FAILURE'));
      await flush();
    });

test('capture failure after startup stops once and exits one',
    async () => {
      const failure = deferred();
      const value = fixture({
        captureWaitForFailure: () => failure.promise,
      });
      assert.equal(await value.lifecycle.start(), true);

      failure.reject(new Error('CAPTURE_AUTHORITY_DIED'));
      await flush();
      assert.equal(
        value.calls.filter((name) => name === 'capture.close').length,
        1,
      );
      assert.equal(
        value.calls.filter((name) => name === 'app.stop').length,
        1,
      );
      assert.deepEqual(value.exitCodes, [1]);
    });

test('signal and capture failure use first-wins exit status',
    async () => {
      for (const first of ['signal', 'capture']) {
        const failure = deferred();
        const closing = deferred();
        const value = fixture({
          captureWaitForFailure: () => failure.promise,
          captureClose: () => closing.promise,
        });
        assert.equal(await value.lifecycle.start(), true);

        if (first === 'signal') {
          value.signalSource.emit('SIGTERM');
          failure.reject(new Error('CAPTURE_AUTHORITY_DIED'));
        } else {
          failure.reject(new Error('CAPTURE_AUTHORITY_DIED'));
          await flush();
          value.signalSource.emit('SIGTERM');
        }
        await flush();
        assert.equal(
          value.calls.filter(
            (name) => name === 'capture.close',
          ).length,
          1,
        );
        assert.equal(
          value.calls.filter((name) => name === 'app.stop').length,
          1,
        );

        closing.resolve(true);
        await flush();
        assert.deepEqual(
          value.exitCodes,
          [first === 'signal' ? 0 : 1],
        );
      }
    });

test('runtime fatal synchronously wins a later signal and stops once',
    async () => {
      const closing = deferred();
      const value = fixture({
        captureClose: () => closing.promise,
      });
      assert.equal(await value.lifecycle.start(), true);

      value.lifecycle.fail();
      value.signalSource.emit('SIGTERM');
      await flush();
      assert.equal(
        value.calls.filter(
          (name) => name === 'capture.close',
        ).length,
        1,
      );
      assert.equal(
        value.calls.filter((name) => name === 'app.stop').length,
        1,
      );

      closing.resolve(true);
      await flush();
      assert.deepEqual(value.exitCodes, [1]);
      assert.throws(
        () => value.lifecycle.fail('unexpected'),
        /RUNTIME_PROCESS_LIFECYCLE_DEPENDENCIES_INVALID/,
      );
    });

test('capture cleanup failures stay observable without leaking',
    async () => {
      const failure = deferred();
      const captureCloseFailure = new Error(
        'CAPTURE_CLOSE_FAILED',
      );
      const appStopFailure = new Error('APP_STOP_FAILED');
      const unhandled = [];
      const onUnhandled = (error) => {
        unhandled.push(error);
      };
      const value = fixture({
        captureWaitForFailure: () => failure.promise,
        captureClose: async () => {
          throw captureCloseFailure;
        },
        appStop: async () => {
          throw appStopFailure;
        },
      });
      assert.equal(await value.lifecycle.start(), true);
      process.on('unhandledRejection', onUnhandled);
      try {
        failure.reject(new Error('CAPTURE_AUTHORITY_DIED'));
        await flush();
        await assert.rejects(value.lifecycle.stop(), (error) => {
          assert.equal(error instanceof AggregateError, true);
          assert.deepEqual(error.errors, [
            captureCloseFailure,
            appStopFailure,
          ]);
          return true;
        });
        await flush();
        assert.deepEqual(value.exitCodes, [1]);
        assert.deepEqual(unhandled, []);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

test('broken capture-failure status sinks never become unhandled',
    async () => {
      for (const setExitCode of [
        () => {
          throw new Error('SYNC_EXIT_STATUS_SINK_FAILED');
        },
        async () => {
          throw new Error('ASYNC_EXIT_STATUS_SINK_FAILED');
        },
      ]) {
        const failure = deferred();
        const unhandled = [];
        const onUnhandled = (error) => {
          unhandled.push(error);
        };
        const value = fixture({
          captureWaitForFailure: () => failure.promise,
          setExitCode,
        });
        assert.equal(await value.lifecycle.start(), true);
        process.on('unhandledRejection', onUnhandled);
        try {
          failure.reject(new Error('CAPTURE_AUTHORITY_DIED'));
          await flush();
          await flush();
          assert.deepEqual(value.exitCodes, [1]);
          assert.deepEqual(unhandled, []);
        } finally {
          process.off('unhandledRejection', onUnhandled);
        }
      }
    });

test('bootstrap and app start failures each run one complete cleanup',
    async () => {
      for (const options of [
        {
          captureStart: async () => {
            throw new Error('BOOTSTRAP_FAILED');
          },
          expected: /BOOTSTRAP_FAILED/,
          prefix: ['capture.waitForFailure', 'capture.start'],
        },
        {
          appStart: async () => {
            throw new Error('APP_START_FAILED');
          },
          expected: /APP_START_FAILED/,
          prefix: [
            'capture.waitForFailure',
            'capture.start',
            'app.start',
          ],
        },
      ]) {
        const value = fixture(options);
        await assert.rejects(
          value.lifecycle.start(),
          options.expected,
        );
        assert.deepEqual(value.calls, [
          ...options.prefix,
          'capture.close',
          'app.stop',
        ]);
      }
    });

test('only an exact positive capture admission can start the app',
    async () => {
      for (const captureStart of [
        async () => false,
        async () => undefined,
        async () => 'true',
      ]) {
        const value = fixture({ captureStart });
        await assert.rejects(
          value.lifecycle.start(),
          /RUNTIME_CAPTURE_BOOTSTRAP_NOT_ADMITTED/,
        );
        assert.deepEqual(value.calls, [
          'capture.waitForFailure',
          'capture.start',
          'capture.close',
          'app.stop',
        ]);
        assert.equal(value.calls.includes('app.start'), false);
      }
    });

test('app start false keeps cleanup rejection observable',
    async () => {
      const value = fixture({
        appStart: async () => false,
        captureClose: async () => {
          throw new Error('CAPTURE_CLOSE_FAILED');
        },
      });

      await assert.rejects(
        value.lifecycle.start(),
        /CAPTURE_CLOSE_FAILED/,
      );
      assert.deepEqual(value.calls, [
        'capture.waitForFailure',
        'capture.start',
        'app.start',
        'capture.close',
        'app.stop',
      ]);
    });

test('stop before start permanently prevents bootstrap',
    async () => {
      const value = fixture();

      assert.equal(await value.lifecycle.stop(), true);
      assert.throws(
        () => value.lifecycle.start(),
        /RUNTIME_PROCESS_LIFECYCLE_START_INVALID/,
      );
      assert.deepEqual(value.calls, [
        'capture.close',
        'app.stop',
      ]);
    });

test('stop in progress prevents bootstrap from starting',
    async () => {
      const closing = deferred();
      const value = fixture({
        captureClose: () => closing.promise,
      });

      const stopping = value.lifecycle.stop();
      assert.throws(
        () => value.lifecycle.start(),
        /RUNTIME_PROCESS_LIFECYCLE_START_INVALID/,
      );
      assert.equal(value.calls.includes('capture.start'), false);
      closing.resolve(true);
      assert.equal(await stopping, true);
    });

test('synchronous stop from failure subscription prevents bootstrap',
    async () => {
      let value;
      value = fixture({
        captureWaitForFailure: () => {
          value.signalSource.emit('SIGTERM');
          return Promise.resolve();
        },
      });

      assert.equal(await value.lifecycle.start(), false);
      assert.deepEqual(value.calls, [
        'capture.waitForFailure',
        'capture.close',
        'app.stop',
      ]);
      assert.deepEqual(value.exitCodes, [0]);
    });

test('synchronous start reentry is rejected before invoking owners twice',
    async () => {
      let value;
      let nested;
      let attempts = 0;
      value = fixture({
        captureStart: async () => {
          attempts += 1;
          if (attempts === 1) {
            try {
              nested = value.lifecycle.start();
            } catch (error) {
              nested = error;
            }
          }
          return true;
        },
      });

      assert.equal(await value.lifecycle.start(), true);
      assert.match(
        nested?.message,
        /RUNTIME_PROCESS_LIFECYCLE_START_INVALID/,
      );
      assert.equal(attempts, 1);
      assert.equal(
        value.calls.filter((name) => name === 'app.start').length,
        1,
      );
      await value.lifecycle.stop();
    });

test('synchronous stop reentry receives the already claimed promise',
    async () => {
      let value;
      let nested;
      let closes = 0;
      value = fixture({
        captureClose: async () => {
          closes += 1;
          if (closes === 1) nested = value.lifecycle.stop();
          return true;
        },
      });
      await value.lifecycle.start();

      const stopping = value.lifecycle.stop();
      assert.equal(nested, stopping);
      assert.equal(await stopping, true);
      assert.equal(closes, 1);
      assert.equal(
        value.calls.filter((name) => name === 'app.stop').length,
        1,
      );
    });

test('repeated signals and programmatic stop share one cleanup promise',
    async () => {
      const closing = deferred();
      const value = fixture({
        captureClose: () => closing.promise,
      });
      assert.equal(await value.lifecycle.start(), true);

      value.signalSource.emit('SIGINT');
      value.signalSource.emit('SIGTERM');
      const stopped = value.lifecycle.stop();
      await flush();
      assert.equal(
        value.calls.filter((name) => name === 'capture.close').length,
        1,
      );
      assert.equal(
        value.calls.filter((name) => name === 'app.stop').length,
        1,
      );

      closing.resolve(true);
      assert.equal(await stopped, true);
      assert.equal(value.signalSource.listenerCount('SIGINT'), 0);
      assert.equal(value.signalSource.listenerCount('SIGTERM'), 0);
      assert.deepEqual(value.exitCodes, [0]);
    });

test('one cleanup failure does not prevent the other owner from stopping',
    async () => {
      const value = fixture({
        captureClose: async () => {
          throw new Error('CAPTURE_CLOSE_FAILED');
        },
      });
      await value.lifecycle.start();

      await assert.rejects(
        value.lifecycle.stop(),
        /CAPTURE_CLOSE_FAILED/,
      );
      assert.equal(value.calls.includes('app.stop'), true);
    });

test('multiple cleanup failures remain visible as one aggregate',
    async () => {
      const captureFailure = new Error('CAPTURE_CLOSE_FAILED');
      const appFailure = new Error('APP_STOP_FAILED');
      const value = fixture({
        captureClose: async () => {
          throw captureFailure;
        },
        appStop: async () => {
          throw appFailure;
        },
      });
      await value.lifecycle.start();

      await assert.rejects(value.lifecycle.stop(), (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.deepEqual(error.errors, [
          captureFailure,
          appFailure,
        ]);
        return true;
      });
    });

test('a broken signal status sink cannot create an unhandled rejection',
    async () => {
      const sinkFailure = new Error('EXIT_STATUS_SINK_FAILED');
      const unhandled = [];
      const onUnhandled = (error) => {
        unhandled.push(error);
      };
      const value = fixture({
        setExitCode: async () => {
          throw sinkFailure;
        },
      });
      await value.lifecycle.start();
      process.on('unhandledRejection', onUnhandled);
      try {
        value.signalSource.emit('SIGTERM');
        await flush();
        await flush();
        assert.deepEqual(value.exitCodes, [0]);
        assert.deepEqual(unhandled, []);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

test('dependencies are exact enough to reject mutable or partial owners',
    () => {
      const signalSource = new EventEmitter();
      for (const input of [
        {},
        {
          capture: {
            start() {},
            close() {},
            waitForFailure() {},
          },
          app: Object.freeze({ start() {}, stop() {} }),
          signalSource,
          setExitCode() {},
        },
        {
          capture: Object.freeze({
            start() {},
            close() {},
          }),
          app: Object.freeze({ start() {}, stop() {} }),
          signalSource,
          setExitCode() {},
        },
        {
          capture: Object.freeze({
            start() {},
            close() {},
            waitForFailure() {},
            extra() {},
          }),
          app: Object.freeze({ start() {}, stop() {} }),
          signalSource,
          setExitCode() {},
        },
      ]) {
        assert.throws(
          () => createRuntimeProcessLifecycle(input),
          /RUNTIME_PROCESS_LIFECYCLE_DEPENDENCIES_INVALID/,
        );
      }
    });
