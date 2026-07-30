import assert from 'node:assert/strict';
import test from 'node:test';

import { createPhase5FaultBridge } from '../../src/acceptance/phase5-fault-bridge.js';

function fixture({ asyncState = false } = {}) {
  const order = [];
  const state = { world: { revision: 1 } };
  const recorder = Object.freeze({
    flush() { order.push('flush'); return []; },
    snapshotState() { order.push('snapshot'); return structuredClone(state); },
  });
  const actuator = Object.freeze({
    prepareAction(plan) {
      order.push(`prepare:${plan.actionSequence}`);
      return { actuatorSequence: plan.actionSequence, accepted: true };
    },
    dispatchInstruction(sequence) {
      order.push(`dispatch:${sequence}`);
    },
    waitForState(_plan, snapshot) {
      order.push('wait');
      const value = snapshot();
      return asyncState ? Promise.resolve(value) : value;
    },
  });
  let now = 100;
  const bridge = createPhase5FaultBridge({
    recorder, actuator,
    monotonicNow: () => (now += 1),
    unixNow: () => 1_000 + now,
  });
  return { bridge, order };
}

test('signed action bytes commit before fixed instruction dispatch', () => {
  const { bridge, order } = fixture();
  const payload = bridge.payloadFor({
    scenario: 'worker-crash-restart', phase: 'fault-action',
    actionSequence: 1, operation: 'signal-worker',
    target: 'candidate-audio-worker',
  });
  assert.equal(payload.payload.action.receipt.actuatorSequence, 1);
  bridge.commitSignedAction(Buffer.from('{"signed":true}'), 1);
  bridge.dispatchFixedInstruction(1);
  assert.deepEqual(order, ['snapshot', 'prepare:1', 'dispatch:1']);
  assert.throws(() => bridge.dispatchFixedInstruction(1));
});

test('state phase may asynchronously wait on an owned predicate', async () => {
  const { bridge, order } = fixture({ asyncState: true });
  const payload = await bridge.payloadFor({
    scenario: 'worker-crash-restart', phase: 'before',
    actionSequence: null, operation: null, target: null,
  });
  assert.deepEqual(payload.payload, {
    kind: 'state', state: { world: { revision: 1 } },
  });
  assert.deepEqual(order, ['wait', 'snapshot']);
});
