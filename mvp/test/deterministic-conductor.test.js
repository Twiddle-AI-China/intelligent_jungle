import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeterministicConductor } from '../src/deterministic-conductor.js';
import { attachPipelineConductor } from '../src/agent.js';
import { CONFIG } from '../src/config.js';
import { createWorld } from '../src/world.js';
import { CONDUCTOR_GOLDEN } from './fixtures/conductor-golden.js';
import { runConductorScenario } from './fixtures/conductor-scenario.js';
import { advanceTo, mulberry32 } from './helpers.js';

const SCENARIO = Object.freeze({
  worldSeed: 0x4c4353,
  conductorSeed: 0x4c4354,
  ticks: 600,
  dt: 1 / 30,
});

test('deterministic conductor 与 legacy adapter 的冻结 trace 完全一致', () => {
  const actual = runConductorScenario({
    createConductor: createDeterministicConductor,
    ...SCENARIO,
  });

  assert.deepEqual(actual, CONDUCTOR_GOLDEN);
});

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

function fallbackDawnResult() {
  return {
    reviewedDay: null,
    flock: { plan: null, fallback: true },
    master: { decision: null, source: 'rule-fallback', fallback: true },
  };
}

test('pipeline-v1 保留精确 dayReview payload，并同步零参数调用 dawnPlan', () => {
  const config = structuredClone(CONFIG);
  const world = createWorld({ config, rng: mulberry32(101) });
  let emittedStats = null;
  world.onBeforeDawn(({ stats }) => { emittedStats = stats; });
  const dawnCalls = [];
  const reviews = [];
  const pipeline = {
    dawnPlan(...args) {
      dawnCalls.push(args);
      return fallbackDawnResult();
    },
    dayReview(input) {
      reviews.push(input);
    },
  };
  createDeterministicConductor(world, {
    config,
    rng: mulberry32(102),
    reviewSource: { kind: 'pipeline-v1', pipeline },
  });

  advanceTo(world, 2, 0.02);

  assert.deepEqual(dawnCalls, [[]]);
  assert.equal(reviews.length, 1);
  assert.deepEqual(Object.keys(reviews[0]).sort(), ['day', 'flockSnapshot', 'masterInput']);
  assert.equal(reviews[0].day, emittedStats.day);
  assert.equal(reviews[0].flockSnapshot.day, emittedStats.day);
  assert.deepEqual(
    Object.keys(reviews[0].masterInput).sort(),
    ['menu', 'observations', 'state'],
  );
});

test('evaluator-v1 保留精确 stats/context 参数并消费 Promise 计划', async () => {
  const config = structuredClone(CONFIG);
  const world = createWorld({ config, rng: mulberry32(103) });
  let emittedStats = null;
  world.onBeforeDawn(({ stats }) => { emittedStats = stats; });
  const calls = [];
  const plans = Object.fromEntries(config.trees.map((tree) => [tree.id, { marker: tree.id }]));
  const planEvents = [];
  createDeterministicConductor(world, {
    config,
    rng: mulberry32(104),
    reviewSource: {
      kind: 'evaluator-v1',
      evaluator: (...args) => {
        calls.push(args);
        return Promise.resolve(plans);
      },
    },
    onPlan: (event) => planEvents.push(event),
  });

  advanceTo(world, 2, 0.02);
  await flush();

  assert.equal(calls.length, 1);
  assert.strictEqual(calls[0][0], emittedStats);
  assert.deepEqual(calls[0][1], { season: 'spring', colorId: '日光' });
  assert.equal(calls[0].length, 2);
  assert.deepEqual(planEvents, [{
    plans,
    source: 'LLM',
    reviewedDay: emittedStats.day,
    targetDay: emittedStats.day + 2,
  }]);
});

test('combined-v1 逐字保留 pipeline master/dayReview 与 evaluator flock 优先级怪异', () => {
  const config = structuredClone(CONFIG);
  const world = createWorld({ config, rng: mulberry32(105) });
  let evaluatorCalls = 0;
  let reviewCalls = 0;
  const applies = [];
  const pipeline = {
    dawnPlan: () => ({
      reviewedDay: 99,
      flock: {
        fallback: false,
        plan: {
          flocks: config.trees.map(() => ({
            dwellBeats: 999,
            activeBars: 1,
            holdLoops: 1,
            mutations: [],
          })),
        },
      },
      master: { decision: null, source: 'rule-fallback', fallback: true },
    }),
    dayReview: () => { reviewCalls += 1; },
  };
  createDeterministicConductor(world, {
    config,
    rng: mulberry32(106),
    reviewSource: {
      kind: 'combined-v1',
      pipeline,
      evaluator: () => {
        evaluatorCalls += 1;
        return null;
      },
    },
    onApply: (event) => applies.push(event),
  });

  advanceTo(world, 2, 0.02);

  assert.equal(evaluatorCalls, 0, 'pipeline 存在时 day-end 不启动 evaluator');
  assert.equal(reviewCalls, 1, 'pipeline 存在时 day-end 仍走 pipeline.dayReview');
  const day2 = applies.find((event) => event.day === 2);
  assert.ok(day2);
  assert.ok(Object.values(day2.plans).every(
    (entry) => entry.source === '规则层(即时兜底)',
  ), 'flock apply 只因 evaluator 存在就忽略 pipeline flock，pending 为空时规则兜底');
});

test('legacy setPipeline(null) 不丢失构造时捕获的 evaluator', async () => {
  const config = structuredClone(CONFIG);
  const world = createWorld({ config, rng: mulberry32(107) });
  let evaluatorCalls = 0;
  const conductor = attachPipelineConductor(world, {
    config,
    rng: mulberry32(108),
    evaluator: async () => {
      evaluatorCalls += 1;
      return null;
    },
    pipeline: {
      dawnPlan: fallbackDawnResult,
      dayReview: () => {},
    },
  });

  assert.equal(conductor.setPipeline(null), undefined, 'legacy setter 返回值保持 undefined');
  advanceTo(world, 2, 0.02);
  await flush();

  assert.equal(evaluatorCalls, 1);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function instrumentWorld(world) {
  const counts = Object.fromEntries(
    Object.entries(world)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => [name, 0]),
  );
  const wrapped = Object.fromEntries(Object.entries(world).map(([name, value]) => [
    name,
    typeof value === 'function'
      ? (...args) => {
        counts[name] += 1;
        return value(...args);
      }
      : value,
  ]));
  return { world: wrapped, counts };
}

function countingRng(seed) {
  const source = mulberry32(seed);
  let count = 0;
  const rng = () => {
    count += 1;
    return source();
  };
  rng.count = () => count;
  return rng;
}

test('setReviewSource generation 在 fallback 前丢弃迟到 resolve/reject，且无任何副作用', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const config = structuredClone(CONFIG);
    const baseWorld = createWorld({ config, rng: mulberry32(109) });
    const observed = instrumentWorld(baseWorld);
    const pending = deferred();
    const rng = countingRng(110);
    let providerCalls = 0;
    let percussionCalls = 0;
    let callbackCalls = 0;
    const conductor = createDeterministicConductor(observed.world, {
      config,
      rng,
      reviewSource: {
        kind: 'evaluator-v1',
        evaluator: () => pending.promise,
      },
      ecologyProvider: () => {
        providerCalls += 1;
        return null;
      },
      getPercussionMode: () => {
        percussionCalls += 1;
        return 'jungle';
      },
      onPlan: () => { callbackCalls += 1; },
    });

    advanceTo(observed.world, 2, 0.02);
    conductor.setReviewSource(null);
    assert.equal(conductor.hasPendingPlan(), false);
    const before = {
      world: structuredClone(observed.counts),
      rng: rng.count(),
      providerCalls,
      percussionCalls,
      callbackCalls,
    };

    if (outcome === 'resolve') pending.resolve({ stale: true });
    else pending.reject(new Error('late rejection'));
    await flush();

    assert.deepEqual({
      world: observed.counts,
      rng: rng.count(),
      providerCalls,
      percussionCalls,
      callbackCalls,
    }, before, `${outcome} 必须先过 generation guard，不能进入规则 fallback`);
    assert.equal(conductor.hasPendingPlan(), false);
    conductor.dispose();
  }
});

test('checkpoint export 对任一外部 source/hook fail-closed；全 null 与 callbacks 可导出', () => {
  const cases = [
    {
      label: 'pipeline reviewSource',
      options: {
        reviewSource: {
          kind: 'pipeline-v1',
          pipeline: { dawnPlan: fallbackDawnResult, dayReview: () => {} },
        },
      },
    },
    {
      label: 'evaluator reviewSource',
      options: {
        reviewSource: { kind: 'evaluator-v1', evaluator: () => null },
      },
    },
    {
      label: 'combined reviewSource',
      options: {
        reviewSource: {
          kind: 'combined-v1',
          pipeline: { dawnPlan: fallbackDawnResult, dayReview: () => {} },
          evaluator: () => null,
        },
      },
    },
    { label: 'ecologyProvider', options: { ecologyProvider: () => null } },
    { label: 'getPercussionMode', options: { getPercussionMode: () => 'jungle' } },
  ];
  for (const [index, row] of cases.entries()) {
    const config = structuredClone(CONFIG);
    const world = createWorld({ config, rng: mulberry32(120 + index) });
    const conductor = createDeterministicConductor(world, {
      config,
      rng: mulberry32(130 + index),
      ...row.options,
    });
    assert.throws(
      () => conductor.exportDeterministicState(),
      (error) => error?.code === 'CHECKPOINT_NONDETERMINISTIC_SOURCE_ACTIVE',
      row.label,
    );
    conductor.dispose();
  }

  const config = structuredClone(CONFIG);
  const world = createWorld({ config, rng: mulberry32(140) });
  const conductor = createDeterministicConductor(world, {
    config,
    rng: mulberry32(141),
    reviewSource: null,
    ecologyProvider: null,
    getPercussionMode: null,
    onPlan: () => {},
    onApply: () => {},
    onChord: () => {},
    onMaster: () => {},
    onTempoIntent: () => {},
  });
  const first = conductor.exportDeterministicState();
  const second = conductor.exportDeterministicState();
  assert.deepEqual(Object.keys(first).sort(), ['conductor', 'control', 'sequence']);
  assert.deepEqual(first, JSON.parse(JSON.stringify(first)));
  assert.deepEqual(second, first);
  assert.notStrictEqual(second, first);
  conductor.dispose();
  assert.throws(() => conductor.exportDeterministicState(), 'disposed owner 必须 fail-closed');
});

test('setReviewSource(null) 清空 source 与 pending 后恢复可导出状态', async () => {
  const config = structuredClone(CONFIG);
  const world = createWorld({ config, rng: mulberry32(142) });
  const pending = deferred();
  const conductor = createDeterministicConductor(world, {
    config,
    rng: mulberry32(143),
    reviewSource: {
      kind: 'evaluator-v1',
      evaluator: () => pending.promise,
    },
  });
  advanceTo(world, 2, 0.02);
  conductor.setReviewSource(null);
  assert.equal(conductor.hasPendingPlan(), false);
  assert.doesNotThrow(() => conductor.exportDeterministicState());
  pending.resolve({ stale: true });
  await flush();
  assert.equal(conductor.hasPendingPlan(), false);
  conductor.dispose();
});

test('畸形 reviewSource 在任何订阅或 world 调用前被原子拒绝', () => {
  let getterCalls = 0;
  const accessorSource = { kind: 'pipeline-v1' };
  Object.defineProperty(accessorSource, 'pipeline', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { dawnPlan: fallbackDawnResult, dayReview: () => {} };
    },
  });
  const malformed = [
    {},
    { kind: 'unknown-v1' },
    { kind: 'pipeline-v1' },
    { kind: 'pipeline-v1', pipeline: null },
    {
      kind: 'pipeline-v1',
      pipeline: { dawnPlan: fallbackDawnResult, dayReview: () => {} },
      extra: true,
    },
    { kind: 'evaluator-v1', evaluator: null },
    {
      kind: 'combined-v1',
      pipeline: { dawnPlan: fallbackDawnResult, dayReview: () => {} },
    },
    Object.assign(Object.create({ inherited: true }), {
      kind: 'evaluator-v1',
      evaluator: () => null,
    }),
    accessorSource,
  ];

  for (const [index, reviewSource] of malformed.entries()) {
    let worldCalls = 0;
    const world = new Proxy({}, {
      get() {
        return () => {
          worldCalls += 1;
          return () => {};
        };
      },
    });
    assert.throws(() => createDeterministicConductor(world, { reviewSource }));
    assert.equal(worldCalls, 0, `malformed source case ${index}`);
  }
  assert.equal(getterCalls, 0, 'source validator 不得求值 accessor');
});

function emptyTreeSnapshot(config, tree) {
  return {
    id: tree.id,
    species: tree.species,
    meanEnergy: 0.8,
    perchedTotal: 0,
    birds: [],
    branches: config.tree.branches.map((_, id) => ({ id })),
    densityTier: 'normal',
    dwellBeats: config.species[tree.species].dwellBeats,
    activeBars: config.tempo.barsPerDay,
  };
}

function dayStats(config, day = 1) {
  return {
    day,
    trees: Object.fromEntries(config.trees.map((tree) => [tree.id, {
      day,
      branchLoads: config.tree.branches.map(() => 0),
      meanDwell: 0,
      meanDwellBeats: 0,
      dwellSampleCount: 0,
      switches: 0,
      switchRate: 0,
      silentRatio: 0,
      densityTier: 'normal',
      dwellBeats: config.species[tree.species].dwellBeats,
      activeBars: config.tempo.barsPerDay,
    }])),
  };
}

function createSyntheticWorld(config, { throwUnsubscribeAt = -1 } = {}) {
  const subscriptions = [];
  const unsubscribeCounts = [];
  const calls = {
    getSnapshot: 0,
    setters: 0,
    callbacks: 0,
  };
  const snapshot = {
    simTime: 0,
    day: 1,
    phase: 0,
    trees: config.trees.map((tree) => emptyTreeSnapshot(config, tree)),
  };
  const subscribe = (channel, event, fn) => {
    const index = subscriptions.length;
    subscriptions.push({ channel, event, fn });
    unsubscribeCounts[index] = 0;
    return () => {
      unsubscribeCounts[index] += 1;
      if (index === throwUnsubscribeAt) throw new Error(`unsubscribe-${index}`);
    };
  };
  const setter = (value = true) => {
    calls.setters += 1;
    return value;
  };
  const world = {
    on: (event, fn) => subscribe('on', event, fn),
    onBeforeDawn: (fn) => subscribe('before-dawn', 'before-dawn', fn),
    getSnapshot: () => {
      calls.getSnapshot += 1;
      return snapshot;
    },
    getTreeControl: () => 'AGENT',
    setBranchPreference: () => setter(true),
    setVocalizeBias: () => setter(true),
    setHomeBranch: () => setter(false),
    applySeasonChange: () => {
      calls.setters += 1;
      return [];
    },
    setSequencePattern: () => setter(true),
    setDensityTier: () => setter(true),
    setFlockPlan: () => setter(true),
    setJungleEditPlan: () => setter(true),
  };
  return {
    world,
    calls,
    subscriptions,
    unsubscribeCounts,
    snapshot,
  };
}

function makeExportedConductorState(seed = 150) {
  const config = structuredClone(CONFIG);
  const world = createWorld({ config, rng: mulberry32(seed) });
  const conductor = createDeterministicConductor(world, {
    config,
    rng: mulberry32(seed + 1),
  });
  const state = conductor.exportDeterministicState();
  conductor.dispose();
  return { config, state };
}

test('valid restore 先完整 hydrate、零 RNG/零 setter/零 callback，再安装五个订阅', () => {
  const { config, state } = makeExportedConductorState();
  const expected = structuredClone(state);
  const synthetic = createSyntheticWorld(config);
  const rng = countingRng(152);
  let callbackCalls = 0;
  const restored = createDeterministicConductor(synthetic.world, {
    config,
    rng,
    restoredState: state,
    onPlan: () => { callbackCalls += 1; },
    onApply: () => { callbackCalls += 1; },
    onChord: () => { callbackCalls += 1; },
    onMaster: () => { callbackCalls += 1; },
    onTempoIntent: () => { callbackCalls += 1; },
  });

  assert.equal(rng.count(), 0);
  assert.equal(synthetic.calls.getSnapshot, 0);
  assert.equal(synthetic.calls.setters, 0);
  assert.equal(callbackCalls, 0);
  assert.equal(synthetic.subscriptions.length, 5);
  assert.deepEqual(
    synthetic.subscriptions.map(({ channel, event }) => [channel, event]),
    [
      ['on', 'perch'],
      ['on', 'perch'],
      ['on', 'unperch'],
      ['before-dawn', 'before-dawn'],
      ['on', 'dusk'],
    ],
  );

  state.conductor.cursor.daysSinceChange = 999;
  assert.deepEqual(restored.exportDeterministicState(), expected, 'restore 必须先独立 clone 输入');
  restored.dispose();
});

test('invalid restore 在订阅、RNG、world setter 与 callback 前原子拒绝', () => {
  const { config, state } = makeExportedConductorState(153);
  let arrayAccessorCalls = 0;
  const invalidStates = [
    (() => {
      const value = structuredClone(state);
      value.extra = true;
      return value;
    })(),
    (() => {
      const value = structuredClone(state);
      delete value.sequence.bridgePrevious;
      return value;
    })(),
    (() => {
      const value = structuredClone(state);
      value.conductor.cursor.lastDuskShiftDay = Number.NEGATIVE_INFINITY;
      return value;
    })(),
    (() => {
      const value = structuredClone(state);
      value.conductor.pendingPlan = {};
      return value;
    })(),
    (() => {
      const value = structuredClone(state);
      value.conductor.treeScoreHistory.melody = value.conductor.treeScoreHistory.pad;
      return value;
    })(),
    (() => {
      const value = structuredClone(state);
      Object.defineProperty(value.conductor.treeScoreHistory.pad, Symbol('hidden'), {
        value: true,
        enumerable: true,
      });
      return value;
    })(),
    (() => {
      const value = structuredClone(state);
      Object.defineProperty(value.conductor.treeScoreHistory.pad, 'hidden', {
        value: true,
        enumerable: false,
      });
      return value;
    })(),
    (() => {
      const value = structuredClone(state);
      Object.defineProperty(value.conductor.treeScoreHistory.pad, 'hiddenAccessor', {
        enumerable: true,
        get() {
          arrayAccessorCalls += 1;
          return true;
        },
      });
      return value;
    })(),
    (() => {
      const value = structuredClone(state);
      const pad = config.trees.find((tree) => tree.id === 'pad');
      value.sequence.plannedPatterns.pad = {
        version: 2,
        pitchBranchCount: config.tree.branches.length,
        stepCount: config.tempo.barsPerDay * config.tempo.beatsPerBar,
        occupiedCells: [{
          pitchBranchId: 0,
          stepIndex: 0,
          count: pad.birdCount + 1,
        }],
      };
      return value;
    })(),
    (() => {
      const value = structuredClone(state);
      value.conductor.pendingNext = {
        seasonIdx: 1,
        seasonLength: config.harmony.defaultSeasonLength,
        progressionId: value.conductor.cursor.progressionId,
      };
      return value;
    })(),
  ];

  for (const restoredState of invalidStates) {
    const synthetic = createSyntheticWorld(config);
    const rng = countingRng(154);
    let callbackCalls = 0;
    assert.throws(() => createDeterministicConductor(synthetic.world, {
      config,
      rng,
      restoredState,
      onPlan: () => { callbackCalls += 1; },
      onApply: () => { callbackCalls += 1; },
    }));
    assert.equal(synthetic.subscriptions.length, 0);
    assert.equal(synthetic.calls.getSnapshot, 0);
    assert.equal(synthetic.calls.setters, 0);
    assert.equal(rng.count(), 0);
    assert.equal(callbackCalls, 0);
  }
  assert.equal(arrayAccessorCalls, 0, 'array extra accessor 必须 descriptor-first 拒绝且不求值');
});

test('restore tension 必须落在 owner config 的 canonical tensionRange', () => {
  const { config, state } = makeExportedConductorState(154);
  const narrowedConfig = structuredClone(config);
  narrowedConfig.harmony.tensionRange = [0.4, 0.6];
  assert.equal(state.conductor.currentFrame.tension < 0.4, true);
  const synthetic = createSyntheticWorld(narrowedConfig);
  const rng = countingRng(155);

  assert.throws(() => createDeterministicConductor(synthetic.world, {
    config: narrowedConfig,
    rng,
    restoredState: state,
  }));
  assert.equal(synthetic.subscriptions.length, 0);
  assert.equal(synthetic.calls.getSnapshot, 0);
  assert.equal(synthetic.calls.setters, 0);
  assert.equal(rng.count(), 0);
});

test('restore 将 lastDuskShiftDay wire null 还原为 -Infinity 语义', () => {
  const { config, state } = makeExportedConductorState(155);
  assert.equal(state.conductor.cursor.lastDuskShiftDay, null);
  const synthetic = createSyntheticWorld(config);
  const reviews = [];
  const conductor = createDeterministicConductor(synthetic.world, {
    config,
    rng: mulberry32(156),
    restoredState: state,
  });
  conductor.setReviewSource({
    kind: 'pipeline-v1',
    pipeline: {
      dawnPlan: fallbackDawnResult,
      dayReview: (payload) => reviews.push(payload),
    },
  });
  const beforeDawn = synthetic.subscriptions.find(
    ({ channel }) => channel === 'before-dawn',
  ).fn;

  beforeDawn({ day: 2, stats: dayStats(config, 1) });

  assert.equal(reviews.length, 1);
  assert.equal(
    reviews[0].masterInput.state.duskShiftAllowed,
    true,
    '1 - (-Infinity) 可立即通过两日门禁；若错误保留 null 则结果为 false',
  );
  conductor.dispose();
});

test('dispose 幂等且即使一个 unsubscribe 抛错仍逐一释放；旧 listener/Promise 永不复活', async () => {
  const config = structuredClone(CONFIG);
  const synthetic = createSyntheticWorld(config, { throwUnsubscribeAt: 1 });
  const pending = deferred();
  const rng = countingRng(157);
  let callbackCalls = 0;
  const conductor = createDeterministicConductor(synthetic.world, {
    config,
    rng,
    reviewSource: {
      kind: 'evaluator-v1',
      evaluator: () => pending.promise,
    },
    onPlan: () => { callbackCalls += 1; },
    onApply: () => { callbackCalls += 1; },
    onChord: () => { callbackCalls += 1; },
    onMaster: () => { callbackCalls += 1; },
    onTempoIntent: () => { callbackCalls += 1; },
  });
  const beforeDawn = synthetic.subscriptions.find(
    ({ channel }) => channel === 'before-dawn',
  ).fn;
  beforeDawn({ day: 2, stats: dayStats(config, 1) });
  assert.equal(callbackCalls > 0, true, 'dispose 前 dawn 路径确实可观察');
  callbackCalls = 0;

  assert.doesNotThrow(() => conductor.dispose());
  assert.doesNotThrow(() => conductor.dispose());
  assert.deepEqual(synthetic.unsubscribeCounts, [1, 1, 1, 1, 1]);
  const before = {
    calls: structuredClone(synthetic.calls),
    rng: rng.count(),
    callbackCalls,
  };

  for (const subscription of synthetic.subscriptions) {
    if (subscription.channel === 'before-dawn') {
      subscription.fn({ day: 3, stats: dayStats(config, 2) });
    } else if (subscription.event === 'perch') {
      subscription.fn({
        treeId: 'pad', birdId: 0, branchId: 0, simTime: 0, day: 2,
      });
    } else if (subscription.event === 'unperch') {
      subscription.fn({ treeId: 'pad', birdId: 0, dwellTime: 1, day: 2 });
    } else if (subscription.event === 'dusk') {
      subscription.fn({ day: 2 });
    }
  }
  pending.resolve({ stale: true });
  await flush();

  assert.deepEqual({
    calls: synthetic.calls,
    rng: rng.count(),
    callbackCalls,
  }, before);
  assert.equal(conductor.hasPendingPlan(), false);
});
