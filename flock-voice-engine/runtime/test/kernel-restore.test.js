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

function uniqueWireShapes(root) {
  const shapes = new Map();
  const visited = new WeakSet();
  function visit(value, path) {
    if (value === null || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    const keys = Object.keys(value);
    const signature = `${Array.isArray(value) ? 'array' : 'object'}:${keys.join(',')}`;
    if (!shapes.has(signature)) shapes.set(signature, { path, keys, array: Array.isArray(value) });
    for (const key of keys) visit(value[key], [...path, key]);
  }
  visit(root, []);
  return [...shapes.values()];
}

function valueAtPath(root, path) {
  return path.reduce((value, key) => value[key], root);
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
    ['snapshot schema', (value) => { value.snapshotSchemaVersion = 2; }],
    ['checkpoint schema', (value) => { value.schemaVersion = 2; }],
    ['config revision', (value) => { value.configRevision = 'other'; }],
    ['seed', (value) => { value.seed ^= 1; }],
    ['blank generation', (value) => { value.worldGeneration = ''; }],
    ['revision', (value) => { value.revision = -1; }],
    ['unsafe revision', (value) => { value.revision = Number.MAX_SAFE_INTEGER + 1; }],
    ['event sequence', (value) => { value.eventSeq = -1; }],
    ['unsafe event sequence', (value) => { value.eventSeq = Number.MAX_SAFE_INTEGER + 1; }],
    ['root extra key', (value) => { value.poison = true; }],
    ['missing section', (value) => { delete value.control; }],
    ['bird ownership', (value) => { value.world.trees[0].birds[0].treeId = 'melody'; }],
    ['bird duplicate id', (value) => {
      value.world.trees[0].birds[1].id = value.world.trees[0].birds[0].id;
    }],
    ['bird id gap', (value) => { value.world.trees[0].birds[0].id = 99; }],
    ['home branch reference', (value) => { value.world.trees[0].birds[0].homeBranch = 99; }],
    ['target branch reference', (value) => { value.world.trees[0].birds[0].targetBranch = 99; }],
    ['tree identity', (value) => { value.world.trees[0].id = 'melody'; }],
    ['bridge dimensions', (value) => { value.sequence.bridgeCurrent.pitchBranchCount = 0; }],
    ['sequence tree map', (value) => { value.sequence.worldPatterns.other = null; }],
    ['sequence last step reference', (value) => { value.sequence.lastSequenceStep.pad = 99; }],
    ['planned pattern reference', (value) => {
      value.sequence.plannedPatterns.pad = { day: -1, pattern: null };
    }],
    ['frame derivation', (value) => { value.conductor.currentFrame.season = 'winter'; }],
    ['chord derivation', (value) => { value.conductor.currentChord.id = 'forged'; }],
    ['hold map key', (value) => { delete value.conductor.holdState.pad; }],
    ['pattern history owner', (value) => {
      value.conductor.patternHistory.push({ day: -1, patterns: {} });
    }],
    ['texture harmony', (value) => { value.conductor.hCounts.texture.skeleton = 1; }],
    ['future dusk', (value) => {
      value.conductor.cursor.lastDuskShiftDay = value.world.clock.day + 1;
      value.conductor.cursor.lastDuskShiftCycle = 0;
    }],
    ['rng relation', (value) => { value.rng.world.state ^= 1; }],
    ['rng world negative state', (value) => { value.rng.world.state = -1; }],
    ['rng world state range', (value) => { value.rng.world.state = 0x1_0000_0000; }],
    ['rng half state', (value) => { delete value.rng.world.drawCount; }],
    ['rng negative draw', (value) => { value.rng.world.drawCount = -1; }],
    ['rng unsafe draw', (value) => {
      value.rng.world.drawCount = Number.MAX_SAFE_INTEGER + 1;
    }],
    ['rng conductor relation', (value) => { value.rng.conductor.state ^= 1; }],
    ['rng extra state', (value) => { value.rng.conductor.extra = 0; }],
    ['tempo relation', (value) => { value.control.tempo.barsPerDay += 1; }],
    ['tree control', (value) => { value.control.treeControl.pad = 'other'; }],
    ['USER resume conflict', (value) => {
      value.control.treeControl.pad = 'USER';
      value.control.agentResumeAt.pad = 1;
    }],
    ['paused type', (value) => { value.control.paused = 0; }],
    ['half sentinel', (value) => { value.conductor.cursor.lastDuskShiftCycle = 0; }],
    ['future sentinel', (value) => {
      value.conductor.cursor.lastDuskShiftDay = value.world.clock.day + 1;
      value.conductor.cursor.lastDuskShiftCycle = 0;
    }],
    ['nullable poison', (value) => { value.conductor.pendingSource = {}; }],
    ['pending plan poison', (value) => { value.conductor.pendingPlan = {}; }],
    ['pending reviewed day poison', (value) => { value.conductor.pendingReviewedDay = 0; }],
    ['NaN', (value) => { value.world.clock.phase = Number.NaN; }],
    ['ordinary infinity', (value) => { value.world.clock.phase = Number.POSITIVE_INFINITY; }],
    ['negative infinity', (value) => { value.world.clock.phase = Number.NEGATIVE_INFINITY; }],
    ['negative zero', (value) => { value.revision = -0; }],
    ['undefined', (value) => { value.control.paused = undefined; }],
    ['function', (value) => { value.control.paused = () => false; }],
    ['bigint', (value) => { value.control.paused = 1n; }],
    ['symbol', (value) => { value.control.paused = Symbol('poison'); }],
    ['promise', (value) => { value.control.paused = Promise.resolve(false); }],
    ['non-plain nested', (value) => {
      value.control.treeControl = Object.assign(Object.create(null), value.control.treeControl);
    }],
    ['accessor', (value) => {
      Object.defineProperty(value.control, 'paused', {
        enumerable: true,
        get() { throw new Error('must not read'); },
      });
    }],
    ['shared alias', (value) => { value.sequence.bridgePrevious = value.sequence.bridgeCurrent; }],
    ['cycle', (value) => { value.sequence.bridgePrevious = value.sequence; }],
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
    const createKernel = createSimulationKernelFactory();
    let factorySnapshot = Symbol('not-called');
    const rebuilt = new WorldSession({
      seed: SEED,
      createKernel: (options) => {
        factorySnapshot = options.restoredSnapshot;
        return createKernel(options);
      },
      validateRestoredSnapshot: (snapshot) => validateSimulationCheckpoint(snapshot, expected()),
      restoredSnapshot: candidate,
      worldGenerationFactory: () => `rebuilt-${label}`,
    });
    const fresh = createSimulationRuntime({ seed: SEED });
    try {
      assert.equal(rebuilt.restoreDisposition, 'rebuilt-incompatible', label);
      assert.equal(factorySnapshot, null, label);
      assert.deepEqual(rebuilt.kernel.getSnapshot(), fresh.getSnapshot(), label);
      assert.deepEqual(
        rebuilt.kernel.exportCheckpoint({
          worldGeneration: 'comparison', revision: 0, eventSeq: 0,
        }),
        fresh.exportCheckpoint({
          worldGeneration: 'comparison', revision: 0, eventSeq: 0,
        }),
        label,
      );
    } finally {
      rebuilt.kernel.dispose();
      fresh.dispose();
    }
  }
});

test('每种 checkpoint wire 形状的缺键/多键都穿过真实 WorldSession clean rebuild seam', () => {
  const source = createSimulationRuntime({ seed: SEED });
  advance(source, 40);
  const valid = source.exportCheckpoint({
    worldGeneration: 'generation-shapes', revision: 40, eventSeq: 40,
  });
  source.dispose();
  const fresh = createSimulationRuntime({ seed: SEED });
  const freshCheckpoint = fresh.exportCheckpoint({
    worldGeneration: 'comparison', revision: 0, eventSeq: 0,
  });
  fresh.dispose();

  const mutations = [];
  for (const { path, keys, array } of uniqueWireShapes(valid)) {
    const displayPath = path.length === 0 ? '$' : `$.${path.join('.')}`;
    mutations.push([`${displayPath} extra`, (candidate) => {
      valueAtPath(candidate, path).__unexpected = true;
    }]);
    for (const key of array ? keys.slice(0, 1) : keys) {
      mutations.push([`${displayPath} missing ${key}`, (candidate) => {
        delete valueAtPath(candidate, path)[key];
      }]);
    }
  }

  for (const [label, mutate] of mutations) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.equal(validateSimulationCheckpoint(candidate, expected()), false, label);
    assert.throws(
      () => createSimulationRuntime({ seed: SEED, restoredSnapshot: candidate }),
      /INCOMPATIBLE_SIMULATION_CHECKPOINT/,
      label,
    );
    let factorySnapshot = Symbol('not-called');
    const createKernel = createSimulationKernelFactory();
    const rebuilt = new WorldSession({
      seed: SEED,
      createKernel: (options) => {
        factorySnapshot = options.restoredSnapshot;
        return createKernel(options);
      },
      validateRestoredSnapshot: (snapshot) => validateSimulationCheckpoint(snapshot, expected()),
      restoredSnapshot: candidate,
      worldGenerationFactory: () => `rebuilt-shape-${label}`,
    });
    try {
      assert.equal(factorySnapshot, null, label);
      assert.equal(rebuilt.revision, 0, label);
      assert.equal(rebuilt.eventSeq, 0, label);
      assert.deepEqual(rebuilt.kernel.exportCheckpoint({
        worldGeneration: 'comparison', revision: 0, eventSeq: 0,
      }), freshCheckpoint, label);
    } finally {
      rebuilt.kernel.dispose();
    }
  }
  assert.ok(mutations.length >= 100, `expected broad wire matrix, got ${mutations.length}`);
});

test('root/nested/revoked Proxy 在 canonical admission 阶段拒绝且 factory 只收到 null', () => {
  const source = createSimulationRuntime({ seed: SEED });
  const valid = source.exportCheckpoint({
    worldGeneration: 'generation-proxy', revision: 0, eventSeq: 0,
  });
  source.dispose();

  let rootGetCount = 0;
  const rootProxy = new Proxy(structuredClone(valid), {
    get(target, key, receiver) {
      rootGetCount += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  let nestedGetCount = 0;
  const nestedProxy = structuredClone(valid);
  nestedProxy.control = new Proxy(nestedProxy.control, {
    get(target, key, receiver) {
      nestedGetCount += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const { proxy: revokedProxy, revoke } = Proxy.revocable(structuredClone(valid), {});
  revoke();

  for (const [label, candidate] of [
    ['root', rootProxy],
    ['nested', nestedProxy],
    ['revoked', revokedProxy],
  ]) {
    assert.equal(validateSimulationCheckpoint(candidate, expected()), false, label);
    assert.throws(
      () => createSimulationRuntime({ seed: SEED, restoredSnapshot: candidate }),
      /INCOMPATIBLE_SIMULATION_CHECKPOINT/,
      label,
    );
    let factorySnapshot = Symbol('not-called');
    const createKernel = createSimulationKernelFactory();
    const rebuilt = new WorldSession({
      seed: SEED,
      createKernel: (options) => {
        factorySnapshot = options.restoredSnapshot;
        return createKernel(options);
      },
      validateRestoredSnapshot: (snapshot) => validateSimulationCheckpoint(snapshot, expected()),
      restoredSnapshot: candidate,
      worldGenerationFactory: () => `rebuilt-${label}`,
    });
    const fresh = createSimulationRuntime({ seed: SEED });
    try {
      assert.equal(factorySnapshot, null, label);
      assert.deepEqual(
        rebuilt.kernel.exportCheckpoint({
          worldGeneration: 'comparison', revision: 0, eventSeq: 0,
        }),
        fresh.exportCheckpoint({
          worldGeneration: 'comparison', revision: 0, eventSeq: 0,
        }),
        label,
      );
    } finally {
      rebuilt.kernel.dispose();
      fresh.dispose();
    }
  }
  assert.equal(rootGetCount, 0);
  assert.equal(nestedGetCount, 0);
});
