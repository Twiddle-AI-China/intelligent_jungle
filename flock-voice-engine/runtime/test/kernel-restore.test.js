import assert from 'node:assert/strict';
import test from 'node:test';

import { DOMAIN_CONFIG } from '../src/domain/config.js';
import {
  SIMULATION_CONFIG_REVISION,
  validateSimulationCheckpoint,
} from '../src/domain/simulation-checkpoint.js';
import {
  createSimulationKernelFactory,
  createSimulationRuntime,
} from '../src/simulation-runtime.js';
import { WorldSession } from '../src/world-session/world-session.js';

const SEED = 0x4c4353;
const DT = 1 / DOMAIN_CONFIG.sim.tickHz;

function advance(runtime, count = 300) {
  for (let index = 0; index < count; index += 1) runtime.tick(DT);
}

function expected() {
  return { seed: SEED, configRevision: SIMULATION_CONFIG_REVISION };
}

test('real runtime 300+checkpoint+300 与 600 ticks 继续同轨', () => {
  const continuous = createSimulationRuntime({ seed: SEED });
  const source = createSimulationRuntime({ seed: SEED });
  try {
    advance(continuous, 600);
    advance(source, 300);
    const checkpoint = source.exportCheckpoint({
      worldGeneration: 'generation-a', revision: 300, eventSeq: 300,
    });
    assert.equal(validateSimulationCheckpoint(checkpoint, expected()), true);
    const restored = createSimulationRuntime({
      seed: SEED,
      restoredSnapshot: JSON.parse(JSON.stringify(checkpoint)),
    });
    try {
      advance(restored, 300);
      const continuousCheckpoint = continuous.exportCheckpoint({
        worldGeneration: 'generation-a', revision: 600, eventSeq: 600,
      });
      const restoredCheckpoint = restored.exportCheckpoint({
        worldGeneration: 'generation-a', revision: 600, eventSeq: 600,
      });
      assert.deepEqual(restoredCheckpoint, continuousCheckpoint);
    } finally {
      restored.dispose();
    }
  } finally {
    continuous.dispose();
    source.dispose();
  }
});

test('WorldSession 在 mailbox 内原子导出并精确恢复 cursor tuple', async () => {
  const createKernel = createSimulationKernelFactory();
  const session = new WorldSession({
    seed: SEED,
    createKernel,
    validateRestoredSnapshot: (snapshot) => validateSimulationCheckpoint(snapshot, expected()),
    worldGenerationFactory: () => 'generation-mailbox',
  });
  await session.commit('fixed.tick', (owner) => owner.kernel.tick(DT));
  const checkpoint = await session.runExclusive('checkpoint.export', (owner) => (
    owner.kernel.exportCheckpoint({
      worldGeneration: owner.worldGeneration,
      revision: owner.revision,
      eventSeq: owner.eventSeq,
    })
  ));
  const restored = new WorldSession({
    seed: SEED,
    createKernel,
    validateRestoredSnapshot: (snapshot) => validateSimulationCheckpoint(snapshot, expected()),
    restoredSnapshot: checkpoint,
    worldGenerationFactory: () => { throw new Error('must restore'); },
  });
  assert.equal(restored.restoreDisposition, 'restored');
  assert.deepEqual(
    [restored.worldGeneration, restored.revision, restored.eventSeq],
    ['generation-mailbox', 1, 1],
  );
  session.kernel.dispose();
  restored.kernel.dispose();
});

test('invalid canonical checkpoint 通过 WorldSession 只能整世 clean rebuild', () => {
  const source = createSimulationRuntime({ seed: SEED });
  advance(source, 20);
  const valid = source.exportCheckpoint({
    worldGeneration: 'generation-source', revision: 20, eventSeq: 20,
  });
  source.dispose();
  const invalid = structuredClone(valid);
  invalid.conductor.cursor.lastDuskShiftDay = invalid.world.clock.day + 1;
  invalid.conductor.cursor.lastDuskShiftCycle = 0;
  assert.equal(validateSimulationCheckpoint(invalid, expected()), false);

  const rebuilt = new WorldSession({
    seed: SEED,
    createKernel: createSimulationKernelFactory(),
    validateRestoredSnapshot: (snapshot) => validateSimulationCheckpoint(snapshot, expected()),
    restoredSnapshot: invalid,
    worldGenerationFactory: () => 'generation-rebuilt',
  });
  const independentlyFresh = createSimulationRuntime({ seed: SEED });
  try {
    assert.equal(rebuilt.restoreDisposition, 'rebuilt-incompatible');
    assert.deepEqual([rebuilt.revision, rebuilt.eventSeq], [0, 0]);
    assert.deepEqual(rebuilt.kernel.getSnapshot(), independentlyFresh.getSnapshot());
    assert.deepEqual(
      rebuilt.kernel.exportCheckpoint({
        worldGeneration: 'same', revision: 0, eventSeq: 0,
      }),
      independentlyFresh.exportCheckpoint({
        worldGeneration: 'same', revision: 0, eventSeq: 0,
      }),
    );
  } finally {
    rebuilt.kernel.dispose();
    independentlyFresh.dispose();
  }
});

test('cross-section corruption matrix 全部进入同一 clean rebuild 策略', () => {
  const source = createSimulationRuntime({ seed: SEED });
  advance(source, 40);
  const valid = source.exportCheckpoint({
    worldGeneration: 'generation-matrix', revision: 40, eventSeq: 40,
  });
  source.dispose();
  const cases = [
    ['world identity', (value) => { value.worldId = 'other'; }],
    ['protocol', (value) => { value.protocolVersion = 2; }],
    ['revision', (value) => { value.revision = -1; }],
    ['bird ownership', (value) => { value.world.trees[0].birds[0].treeId = 'melody'; }],
    ['bridge dimensions', (value) => { value.sequence.bridgeCurrent.pitchBranchCount = 0; }],
    ['texture harmony', (value) => { value.conductor.hCounts.texture.skeleton = 1; }],
    ['future dusk', (value) => {
      value.conductor.cursor.lastDuskShiftDay = value.world.clock.day + 1;
      value.conductor.cursor.lastDuskShiftCycle = 0;
    }],
    ['rng relation', (value) => { value.rng.world.state ^= 1; }],
    ['ordinary infinity', (value) => { value.world.clock.phase = Number.POSITIVE_INFINITY; }],
    ['undefined', (value) => { value.control.paused = undefined; }],
    ['function', (value) => { value.control.paused = () => false; }],
    ['shared alias', (value) => { value.sequence.bridgePrevious = value.sequence.bridgeCurrent; }],
  ];

  for (const [label, mutate] of cases) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.equal(validateSimulationCheckpoint(candidate, expected()), false, label);
    assert.throws(
      () => createSimulationRuntime({ seed: SEED, restoredSnapshot: candidate }),
      /INCOMPATIBLE_SIMULATION_CHECKPOINT/,
      label,
    );
    const rebuilt = new WorldSession({
      seed: SEED,
      createKernel: createSimulationKernelFactory(),
      validateRestoredSnapshot: (snapshot) => validateSimulationCheckpoint(snapshot, expected()),
      restoredSnapshot: candidate,
      worldGenerationFactory: () => `rebuilt-${label}`,
    });
    const fresh = createSimulationRuntime({ seed: SEED });
    try {
      assert.equal(rebuilt.restoreDisposition, 'rebuilt-incompatible', label);
      assert.deepEqual(rebuilt.kernel.getSnapshot(), fresh.getSnapshot(), label);
    } finally {
      rebuilt.kernel.dispose();
      fresh.dispose();
    }
  }
});
