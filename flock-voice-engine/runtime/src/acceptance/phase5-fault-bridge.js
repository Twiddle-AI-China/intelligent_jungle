import { types } from 'node:util';

import { canonicalPhase5CaptureJson } from '../capture/capture-wire.js';

const OPTION_FIELDS = Object.freeze([
  'recorder', 'actuator', 'monotonicNow', 'unixNow',
]);
const RECORDER_FIELDS = Object.freeze(['flush', 'snapshotState']);
const ACTUATOR_FIELDS = Object.freeze([
  'prepareAction', 'dispatchInstruction', 'waitForState',
]);

function fail(code) {
  throw new Error(code);
}

function exactObject(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length
    && fields.every((field) => keys.includes(field));
}

function exactFrozenMethods(value, fields) {
  return exactObject(value, fields) && Object.isFrozen(value)
    && fields.every((field) => typeof value[field] === 'function');
}

function frozenMethodsAtLeast(value, fields) {
  return value !== null && typeof value === 'object' && !types.isProxy(value)
    && Object.isFrozen(value)
    && fields.every((field) => typeof value[field] === 'function');
}

function owned(value) {
  return JSON.parse(canonicalPhase5CaptureJson(value));
}

function then(value, operation) {
  return value && typeof value.then === 'function'
    ? Promise.resolve(value).then(operation)
    : operation(value);
}

export function createPhase5FaultBridge(options = {}) {
  if (arguments.length !== 1 || !exactObject(options, OPTION_FIELDS)
      || !frozenMethodsAtLeast(options.recorder, RECORDER_FIELDS)
      || !exactFrozenMethods(options.actuator, ACTUATOR_FIELDS)
      || typeof options.monotonicNow !== 'function'
      || typeof options.unixNow !== 'function') {
    fail('PHASE5_FAULT_BRIDGE_INPUT_INVALID');
  }
  const { recorder, actuator, monotonicNow, unixNow } = options;
  const committed = new Map();
  let nextActionSequence = 1;
  let terminal = false;

  function timestamped(payload) {
    const atMonotonicMs = Reflect.apply(monotonicNow, undefined, []);
    const atUnixMs = Reflect.apply(unixNow, undefined, []);
    if (!Number.isFinite(atMonotonicMs) || atMonotonicMs < 0
        || !Number.isFinite(atUnixMs) || atUnixMs < 0) {
      terminal = true;
      fail('PHASE5_FAULT_BRIDGE_CLOCK_INVALID');
    }
    return owned({ atMonotonicMs, atUnixMs, payload });
  }

  function payloadFor(plan) {
    if (terminal || plan === null || typeof plan !== 'object') {
      terminal = true;
      fail('PHASE5_FAULT_BRIDGE_PLAN_INVALID');
    }
    if (plan.actionSequence === null) {
      const pending = Reflect.apply(actuator.waitForState, actuator, [
        Object.freeze(owned(plan)),
        () => recorder.snapshotState(),
      ]);
      return then(pending, (state) => timestamped({
        kind: 'state',
        state: owned(state),
      }));
    }
    if (plan.actionSequence !== nextActionSequence) {
      terminal = true;
      fail('PHASE5_FAULT_BRIDGE_SEQUENCE_INVALID');
    }
    const state = recorder.snapshotState();
    const pending = Reflect.apply(actuator.prepareAction, actuator, [
      Object.freeze(owned(plan)),
      Object.freeze(owned(state)),
      () => recorder.snapshotState(),
    ]);
    return then(pending, (receipt) => timestamped({
      kind: 'action',
      action: {
        operation: plan.operation,
        target: plan.target,
        receipt: owned(receipt),
      },
    }));
  }

  function flushTransportObservations(...args) {
    if (terminal || args.length !== 0) {
      terminal = true;
      fail('PHASE5_FAULT_BRIDGE_INPUT_INVALID');
    }
    return recorder.flush();
  }

  function commitSignedAction(bytes, sequence) {
    if (terminal || !Buffer.isBuffer(bytes) || bytes.byteLength === 0
        || sequence !== nextActionSequence || committed.has(sequence)) {
      terminal = true;
      fail('PHASE5_FAULT_BRIDGE_COMMIT_INVALID');
    }
    committed.set(sequence, Buffer.from(bytes));
  }

  function dispatchFixedInstruction(sequence) {
    const bytes = committed.get(sequence);
    if (terminal || !bytes || sequence !== nextActionSequence) {
      terminal = true;
      fail('PHASE5_FAULT_BRIDGE_DISPATCH_INVALID');
    }
    const result = Reflect.apply(actuator.dispatchInstruction, actuator, [
      sequence,
      Buffer.from(bytes),
    ]);
    const finish = () => {
      committed.delete(sequence);
      nextActionSequence += 1;
    };
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).then(finish, (error) => {
        terminal = true;
        throw error;
      });
    }
    finish();
    return undefined;
  }

  return Object.freeze({
    flushTransportObservations,
    payloadFor,
    commitSignedAction,
    dispatchFixedInstruction,
  });
}
