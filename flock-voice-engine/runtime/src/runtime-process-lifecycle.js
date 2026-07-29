import { types } from 'node:util';

const OPTION_FIELDS = Object.freeze([
  'capture',
  'app',
  'signalSource',
  'setExitCode',
]);
const CAPTURE_FIELDS = Object.freeze([
  'start',
  'close',
  'waitForFailure',
]);
const APP_FIELDS = Object.freeze(['start', 'stop']);
const SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

function fail() {
  throw new Error(
    'RUNTIME_PROCESS_LIFECYCLE_DEPENDENCIES_INVALID',
  );
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
    && fields.every((key) => (
      typeof Object.getOwnPropertyDescriptor(value, key).value
        === 'function'
    ));
}

function ownedMethod(value, key) {
  return Object.getOwnPropertyDescriptor(value, key).value;
}

export function createRuntimeProcessLifecycle(options) {
  if (!exactPlainDataObject(options, OPTION_FIELDS)) fail();
  const capture = ownedMethod(options, 'capture');
  const app = ownedMethod(options, 'app');
  const signalSource = ownedMethod(options, 'signalSource');
  const setExitCode = ownedMethod(options, 'setExitCode');
  if (!exactFrozenOwner(capture, CAPTURE_FIELDS)
      || !exactFrozenOwner(app, APP_FIELDS)
      || signalSource === null
      || typeof signalSource !== 'object'
      || types.isProxy(signalSource)
      || typeof signalSource.on !== 'function'
      || typeof signalSource.off !== 'function'
      || typeof setExitCode !== 'function') {
    fail();
  }

  const captureStart = ownedMethod(capture, 'start');
  const captureClose = ownedMethod(capture, 'close');
  const captureWaitForFailure = ownedMethod(
    capture,
    'waitForFailure',
  );
  const appStart = ownedMethod(app, 'start');
  const appStop = ownedMethod(app, 'stop');
  let stopping = false;
  let stopped = false;
  let startPromise = null;
  let stopPromise = null;
  let terminationCause = null;
  let resolveStopClaimed;
  const stopClaimed = new Promise((resolve) => {
    resolveStopClaimed = resolve;
  });

  function removeSignalHandlers() {
    for (const signal of SIGNALS) {
      signalSource.off(signal, onSignal);
    }
  }

  function invoke(owner, method) {
    try {
      return Promise.resolve(Reflect.apply(
        method,
        owner,
        [],
      ));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function observe(owner, method) {
    return invoke(owner, method).then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    );
  }

  function observeOrStop(owner, method) {
    return Promise.race([
      observe(owner, method),
      stopClaimed.then(() => ({ status: 'stopping' })),
    ]);
  }

  function stop(...args) {
    if (args.length !== 0) fail();
    if (stopPromise !== null) return stopPromise;
    stopping = true;
    let resolveStop;
    let rejectStop;
    stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    resolveStopClaimed();
    const captureClosing = invoke(capture, captureClose);
    const appStopping = invoke(app, appStop);
    void Promise.allSettled([
      captureClosing,
      appStopping,
    ]).then((results) => {
      stopped = true;
      removeSignalHandlers();
      const failures = results.filter(
        (result) => result.status === 'rejected',
      ).map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          'RUNTIME_PROCESS_STOP_FAILED',
        );
      }
      return true;
    }).then(resolveStop, rejectStop);
    return stopPromise;
  }

  async function failStart(primary) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        primary instanceof Error
          ? primary.message
          : 'RUNTIME_PROCESS_START_FAILED',
      );
    }
    throw primary;
  }

  async function finishStoppedStart() {
    try {
      await stopPromise;
    } catch (error) {
      if (terminationCause === null) throw error;
    }
    return false;
  }

  function claimTermination(cause) {
    if (terminationCause !== null) return;
    terminationCause = cause;
    void stop().then(
      () => Reflect.apply(
        setExitCode,
        undefined,
        [cause === 'signal' ? 0 : 1],
      ),
      () => Reflect.apply(
        setExitCode,
        undefined,
        [1],
      ),
    ).catch(() => {
      // A broken status sink must not create a second process failure.
    });
  }

  function subscribeToCaptureFailure() {
    let waiting;
    try {
      waiting = Reflect.apply(
        captureWaitForFailure,
        capture,
        [],
      );
    } catch {
      claimTermination('capture');
      return false;
    }
    try {
      if (!types.isPromise(waiting)
          || types.isProxy(waiting)
          || Object.getPrototypeOf(waiting) !== Promise.prototype
          || Object.hasOwn(waiting, 'then')
          || Object.hasOwn(waiting, 'constructor')) {
        claimTermination('capture');
        return false;
      }
      Promise.prototype.then.call(
        waiting,
        () => {},
        () => claimTermination('capture'),
      );
    } catch {
      claimTermination('capture');
      return false;
    }
    return true;
  }

  function start(...args) {
    if (args.length !== 0
        || startPromise !== null
        || stopping
        || stopped) {
      throw new Error('RUNTIME_PROCESS_LIFECYCLE_START_INVALID');
    }
    let resolveStart;
    let rejectStart;
    startPromise = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    if (!subscribeToCaptureFailure()) {
      void stopPromise.then(
        () => false,
        () => false,
      ).then(resolveStart, rejectStart);
      return startPromise;
    }
    if (stopping) {
      void stopPromise.then(
        () => false,
        () => false,
      ).then(resolveStart, rejectStart);
      return startPromise;
    }
    void (async () => {
      const captureOutcome = await observeOrStop(
        capture,
        captureStart,
      );
      if (captureOutcome.status === 'stopping') {
        return finishStoppedStart();
      }
      if (captureOutcome.status === 'rejected') {
        if (stopping) return finishStoppedStart();
        return failStart(captureOutcome.error);
      }
      const admitted = captureOutcome.value;
      if (stopping) return finishStoppedStart();
      if (admitted !== true) {
        return failStart(new Error(
          'RUNTIME_CAPTURE_BOOTSTRAP_NOT_ADMITTED',
        ));
      }
      const appOutcome = await observeOrStop(app, appStart);
      if (appOutcome.status === 'stopping') {
        return finishStoppedStart();
      }
      if (appOutcome.status === 'rejected') {
        if (stopping) return finishStoppedStart();
        return failStart(appOutcome.error);
      }
      const started = appOutcome.value;
      if (stopping) return finishStoppedStart();
      if (started === false) {
        await stop();
        return false;
      }
      return true;
    })().then(resolveStart, rejectStart);
    return startPromise;
  }

  function onSignal() {
    claimTermination('signal');
  }

  function failProcess(...args) {
    if (args.length !== 0) fail();
    claimTermination('failure');
  }

  for (const signal of SIGNALS) {
    signalSource.on(signal, onSignal);
  }

  return Object.freeze({
    start,
    stop,
    fail: failProcess,
  });
}
