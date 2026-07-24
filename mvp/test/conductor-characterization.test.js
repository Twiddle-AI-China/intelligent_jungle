import test from 'node:test';
import assert from 'node:assert/strict';

import { attachPipelineConductor } from '../src/agent.js';
import { CONDUCTOR_GOLDEN } from './fixtures/conductor-golden.js';
import { runConductorScenario } from './fixtures/conductor-scenario.js';

const SCENARIO = Object.freeze({
  worldSeed: 0x4c4353,
  conductorSeed: 0x4c4354,
  ticks: 600,
  dt: 1 / 30,
});

function assertDeepFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test('legacy conductor 行为 trace 保持冻结', () => {
  const actual = runConductorScenario({
    createConductor: attachPipelineConductor,
    ...SCENARIO,
  });

  assert.match(CONDUCTOR_GOLDEN.eventTraceSha256, /^[0-9a-f]{64}$/);
  assert.match(CONDUCTOR_GOLDEN.callbackTraceSha256, /^[0-9a-f]{64}$/);
  assert.equal(actual.worldRngDrawCount, 264);
  assert.equal(actual.conductorRngDrawCount, 9);
  assertDeepFrozen(CONDUCTOR_GOLDEN);
  assert.deepEqual(actual, CONDUCTOR_GOLDEN);
});
