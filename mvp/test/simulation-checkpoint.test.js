import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIG } from '../src/config.js';
import { createDeterministicConductor } from '../src/deterministic-conductor.js';
import {
  assertCanonicalSeed,
  createDeterministicRng,
  deriveConductorSeed,
} from '../src/deterministic-rng.js';
import {
  createSimulationCheckpoint,
  SIMULATION_CONFIG_REVISION,
  validateSimulationCheckpoint,
} from '../src/simulation-checkpoint.js';
import { createWorld } from '../src/world.js';
import {
  createCheckpointableOwner,
  createCheckpointableOwnerFactory,
} from './fixtures/checkpoint-owner.js';

const ROOT_SEED = 0x4c4353;
const HALF_TICKS = 300;
const DT = 1 / 30;
const DOMAIN_EVENT_NAMES = [
  'perch',
  'unperch',
  'dawn',
  'dusk',
  'sequence-pattern',
  'sequence-step',
  'agent-resume',
  'season-migration',
  'meter-change',
];
const EXPECTED_SUBSCRIPTION_ORDER = [
  'perch',
  'perch',
  'unperch',
  'before-dawn',
  'dusk',
  ...DOMAIN_EVENT_NAMES,
];

function advance(owner, ticks = HALF_TICKS) {
  for (let index = 0; index < ticks; index += 1) owner.tick(DT);
}

function jsonRoundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertCheckpointError(operation, label) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, 'INVALID_SIMULATION_CHECKPOINT');
    assert.equal(error?.message, 'INVALID_SIMULATION_CHECKPOINT');
    return true;
  }, label);
}

function assertOwnerError(operation, code, label) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.message, code);
    return true;
  }, label);
}

function checkpointExpected(seed = ROOT_SEED) {
  return { seed, configRevision: SIMULATION_CONFIG_REVISION };
}

function snapshotOwnGraph(root) {
  const seen = new Map();
  const visit = (value) => {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
      return { kind: 'primitive', value };
    }
    if (seen.has(value)) return { kind: 'reference', id: seen.get(value) };
    const id = seen.size;
    seen.set(value, id);
    const descriptors = Reflect.ownKeys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const record = {
        key,
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
      };
      if ('value' in descriptor) {
        record.writable = descriptor.writable;
        record.value = visit(descriptor.value);
      } else {
        record.get = descriptor.get;
        record.set = descriptor.set;
      }
      return record;
    });
    return {
      kind: typeof value === 'function' ? 'function' : 'object',
      id,
      prototype: Object.getPrototypeOf(value),
      descriptors,
    };
  };
  return visit(root);
}

function makeConstructionProbe({
  throwSubscribeAt = null,
  throwUnsubscribeAt = null,
  throwConductorDispose = false,
} = {}) {
  const counts = {
    seed: 0,
    validation: 0,
    acceptedClone: 0,
    rng: 0,
    world: 0,
    worldTick: 0,
    conductor: 0,
    conductorDispose: 0,
    subscription: 0,
  };
  const collectorInstallError = new Error('synthetic collector install failure');
  const conductorDisposeError = new Error('synthetic conductor dispose failure');
  const cloneInputs = [];
  const validationInputs = [];
  const subscriptionOrder = [];
  const unsubscribeCounts = [];

  const createOwner = createCheckpointableOwnerFactory({
    config: CONFIG,
    assertCanonicalSeed: (seed) => {
      counts.seed += 1;
      return assertCanonicalSeed(seed);
    },
    validateSimulationCheckpoint: (checkpoint, expected) => {
      counts.validation += 1;
      validationInputs.push({ checkpoint, expected });
      return validateSimulationCheckpoint(checkpoint, expected);
    },
    clone: (value) => {
      counts.acceptedClone += 1;
      cloneInputs.push(value);
      return structuredClone(value);
    },
    createDeterministicRng: (...args) => {
      counts.rng += 1;
      return createDeterministicRng(...args);
    },
    deriveConductorSeed,
    createWorld: (options) => {
      counts.world += 1;
      const world = createWorld(options);
      const wrapUnsubscribe = (name, subscribe) => {
        const index = counts.subscription;
        counts.subscription += 1;
        subscriptionOrder.push(name);
        if (index === throwSubscribeAt) throw collectorInstallError;
        const unsubscribeIndex = unsubscribeCounts.length;
        unsubscribeCounts.push(0);
        const unsubscribe = subscribe();
        return () => {
          unsubscribeCounts[unsubscribeIndex] += 1;
          const result = unsubscribe();
          if (index === throwUnsubscribeAt) throw new Error('synthetic unsubscribe failure');
          return result;
        };
      };
      return {
        ...world,
        tick: (dt) => {
          counts.worldTick += 1;
          return world.tick(dt);
        },
        on: (event, listener) => wrapUnsubscribe(
          event,
          () => world.on(event, listener),
        ),
        onBeforeDawn: (listener) => wrapUnsubscribe(
          'before-dawn',
          () => world.onBeforeDawn(listener),
        ),
      };
    },
    createDeterministicConductor: (world, options) => {
      counts.conductor += 1;
      const conductor = createDeterministicConductor(world, options);
      return {
        ...conductor,
        dispose: () => {
          counts.conductorDispose += 1;
          const result = conductor.dispose();
          if (throwConductorDispose) throw conductorDisposeError;
          return result;
        },
      };
    },
    createSimulationCheckpoint,
  });

  return {
    collectorInstallError,
    conductorDisposeError,
    counts,
    cloneInputs,
    createOwner,
    subscriptionOrder,
    unsubscribeCounts,
    validationInputs,
  };
}

function hiddenWorldProjection(checkpoint) {
  return checkpoint.world.trees.map((tree) => ({
    id: tree.id,
    branchPreference: tree.branchPreference,
    stats: tree.stats,
    birds: tree.birds.map((bird) => ({
      id: bird.id,
      settleAt: bird.settleAt,
      plannedDwell: bird.plannedDwell,
      plannedFlight: bird.plannedFlight,
      dwellTime: bird.dwellTime,
      dwellBeatTime: bird.dwellBeatTime,
      flightTime: bird.flightTime,
      visitCounts: bird.visitCounts,
      returnSequence: bird.returnSequence,
    })),
  }));
}

test('600 ticks 与 300 + JSON checkpoint + 300 的 owner 状态和有序事件完全一致', () => {
  const uninterrupted = createCheckpointableOwner({ seed: ROOT_SEED });
  const first = createCheckpointableOwner({ seed: ROOT_SEED });
  let restored = null;

  try {
    advance(uninterrupted);
    advance(first);

    const expectedPrefix = uninterrupted.getDomainEvents();
    const actualPrefix = first.getDomainEvents();
    assert.deepEqual(actualPrefix, expectedPrefix, '前 300 ticks 的有序 domain events');
    assert.equal(expectedPrefix.length, 27, '前半段冻结事件数');

    const wireCheckpoint = jsonRoundTrip(first.exportCheckpoint());
    assert.equal(first.dispose(), true);

    const probe = makeConstructionProbe();
    restored = probe.createOwner({
      seed: ROOT_SEED,
      restoredSnapshot: wireCheckpoint,
    });

    assert.equal(probe.counts.seed, 1, 'seed gate 必须先执行一次');
    assert.equal(probe.counts.validation, 1, '非 null full checkpoint 必须验证一次');
    assert.deepEqual(probe.validationInputs, [{
      checkpoint: wireCheckpoint,
      expected: checkpointExpected(),
    }]);
    assert.equal(probe.counts.acceptedClone, 2, '只 clone checkpoint 与独立 CONFIG');
    assert.strictEqual(probe.cloneInputs[0], wireCheckpoint, '完整 checkpoint 只 clone 一次');
    assert.strictEqual(probe.cloneInputs[1], CONFIG, '每个 owner 必须取得独立 CONFIG clone');
    assert.equal(probe.counts.rng, 2, '只构造 root 与 derived 两路 RNG');
    assert.equal(probe.counts.world, 1);
    assert.equal(probe.counts.conductor, 1);
    assert.deepEqual(
      probe.subscriptionOrder,
      EXPECTED_SUBSCRIPTION_ORDER,
      'conductor 五个订阅必须先于九类 event collector',
    );
    assert.deepEqual(restored.getDomainEvents(), [], 'restore 构造不得伪造 domain event');
    const firstImmediateExport = restored.exportCheckpoint();
    const secondImmediateExport = restored.exportCheckpoint();
    assert.deepEqual(
      firstImmediateExport,
      wireCheckpoint,
      'restore 构造本身不得消费 RNG 或推进 owner 状态',
    );
    assert.deepEqual(secondImmediateExport, firstImmediateExport, '重复 export 必须零副作用');
    assert.deepEqual(restored.getDomainEvents(), [], '重复 export 不得产生 domain event');

    advance(uninterrupted);
    advance(restored);

    const uninterruptedEvents = uninterrupted.getDomainEvents();
    const expectedSecondHalf = uninterruptedEvents.slice(expectedPrefix.length);
    const restoredSecondHalf = restored.getDomainEvents();
    assert.deepEqual(
      restoredSecondHalf,
      expectedSecondHalf,
      'restore 后 300 ticks 的有序 domain events',
    );
    assert.equal(restoredSecondHalf.length, 59, '后半段冻结事件数');
    assert.deepEqual(
      [...actualPrefix, ...restoredSecondHalf],
      uninterruptedEvents,
      'handoff 前后事件拼接必须等于连续 owner',
    );

    const uninterruptedFinal = uninterrupted.exportCheckpoint();
    const restoredFinal = restored.exportCheckpoint();
    assert.deepEqual(restoredFinal, uninterruptedFinal, '最终 checkpoint 的每个字段');
    assert.deepEqual(restoredFinal.rng, uninterruptedFinal.rng, 'world/conductor RNG state');
    assert.equal(restoredFinal.rng.world.drawCount, 264, '冻结 world RNG draw count');
    assert.equal(restoredFinal.rng.conductor.drawCount, 11, '冻结 conductor RNG draw count');
    assert.deepEqual(
      hiddenWorldProjection(restoredFinal),
      hiddenWorldProjection(uninterruptedFinal),
      'branch preferences、bird timers 与 tree stats',
    );
    assert.deepEqual(restoredFinal.sequence, uninterruptedFinal.sequence, 'sequence current/previous');
    assert.deepEqual(restoredFinal.control, uninterruptedFinal.control, 'owner controls');
  } finally {
    restored?.dispose();
    first.dispose();
    uninterrupted.dispose();
  }
});

test('代表性 full checkpoint corruption 均在 clone/RNG/world/conductor/subscription 前拒绝', () => {
  const source = createCheckpointableOwner({ seed: ROOT_SEED });
  advance(source, HALF_TICKS * 2);
  const valid = source.exportCheckpoint();
  source.dispose();

  let accessorCalls = 0;
  const corruptions = [
    {
      label: 'root missing',
      corrupt: (value) => { delete value.world; },
    },
    {
      label: 'root extra',
      corrupt: (value) => { value.extra = true; },
    },
    {
      label: 'protocol identity',
      corrupt: (value) => { value.protocolVersion += 1; },
    },
    {
      label: 'config identity',
      corrupt: (value) => { value.configRevision = 'other'; },
    },
    {
      label: 'checkpoint seed identity',
      corrupt: (value) => { value.seed = ROOT_SEED + 1; },
    },
    {
      label: 'expected seed identity',
      ownerSeed: ROOT_SEED + 1,
      corrupt: () => {},
    },
    {
      label: 'blank generation metadata',
      corrupt: (value) => { value.worldGeneration = '   '; },
    },
    {
      label: 'negative revision metadata',
      corrupt: (value) => { value.revision = -1; },
    },
    {
      label: 'unsafe event sequence metadata',
      corrupt: (value) => { value.eventSeq = Number.MAX_SAFE_INTEGER + 1; },
    },
    {
      label: 'strict JSON NaN',
      corrupt: (value) => { value.conductor.pendingPlan = Number.NaN; },
    },
    {
      label: 'strict JSON undefined',
      corrupt: (value) => { value.conductor.pendingPlan = undefined; },
    },
    {
      label: 'strict JSON infinity',
      corrupt: (value) => { value.conductor.pendingPlan = Number.POSITIVE_INFINITY; },
    },
    {
      label: 'strict JSON function',
      corrupt: (value) => { value.conductor.pendingPlan = () => {}; },
    },
    {
      label: 'strict JSON accessor',
      corrupt: (value) => {
        Object.defineProperty(value.world.clock, 'simTime', {
          configurable: true,
          enumerable: true,
          get() {
            accessorCalls += 1;
            throw new Error('descriptor-first validation must not invoke this getter');
          },
        });
      },
      verify: () => assert.equal(accessorCalls, 0),
    },
    {
      label: 'strict JSON shared alias',
      corrupt: (value) => {
        value.sequence.bridgePrevious = value.sequence.bridgeCurrent;
      },
    },
    {
      label: 'world clock range',
      corrupt: (value) => { value.world.clock.phase = 1; },
    },
    {
      label: 'sequence canonical grid',
      corrupt: (value) => { value.sequence.bridgeCurrent.pitchBranchCount = 0; },
    },
    {
      label: 'conductor cursor',
      corrupt: (value) => {
        value.conductor.cursor.seasonIdx = CONFIG.harmony.seasons.length;
      },
    },
    {
      label: 'conductor dusk sentinel pair',
      corrupt: (value) => {
        value.conductor.cursor.lastDuskShiftDay = null;
        value.conductor.cursor.lastDuskShiftCycle = 0;
      },
    },
    {
      label: 'world RNG seed/cursor relation',
      corrupt: (value) => {
        value.rng.world.state = (value.rng.world.state + 1) >>> 0;
      },
    },
    {
      label: 'conductor RNG seed/cursor relation',
      corrupt: (value) => {
        value.rng.conductor.state = (value.rng.conductor.state + 1) >>> 0;
      },
    },
    {
      label: 'tree control enum',
      corrupt: (value) => {
        value.control.treeControl[CONFIG.trees[0].id] = 'BROKEN';
      },
    },
    {
      label: 'tempo meter',
      corrupt: (value) => { value.control.tempo.beatsPerBar = 3; },
    },
  ];

  for (const {
    label,
    ownerSeed = ROOT_SEED,
    corrupt,
    verify = () => {},
  } of corruptions) {
    const candidate = structuredClone(valid);
    corrupt(candidate);
    const before = snapshotOwnGraph(candidate);
    let canonical = null;
    assert.doesNotThrow(() => {
      canonical = validateSimulationCheckpoint(candidate, checkpointExpected(ownerSeed));
    }, label);
    assert.equal(canonical, false, `${label}: canonical validator`);

    const probe = makeConstructionProbe();
    assertCheckpointError(() => probe.createOwner({
      seed: ownerSeed,
      restoredSnapshot: candidate,
    }), label);
    assert.deepEqual(probe.counts, {
      seed: 1,
      validation: 1,
      acceptedClone: 0,
      rng: 0,
      world: 0,
      worldTick: 0,
      conductor: 0,
      conductorDispose: 0,
      subscription: 0,
    }, `${label}: owner construction 必须保持原子`);
    assert.deepEqual(probe.cloneInputs, [], `${label}: rejected wire 不得 clone`);
    assert.deepEqual(probe.validationInputs, [{
      checkpoint: candidate,
      expected: checkpointExpected(ownerSeed),
    }], `${label}: helper 只能把原输入交给 canonical validator`);
    assert.deepEqual(snapshotOwnGraph(candidate), before, `${label}: 输入不得被改写`);
    verify();
  }
});

test('root/nested checkpoint Proxy 均在 validation 阶段原子拒绝且不触发 get trap', () => {
  const source = createCheckpointableOwner({ seed: ROOT_SEED });
  advance(source, HALF_TICKS * 2);
  const valid = source.exportCheckpoint();
  source.dispose();

  for (const { label, makeCandidate } of [
    {
      label: 'root checkpoint Proxy',
      makeCandidate: (onGet) => new Proxy(structuredClone(valid), { get: onGet }),
    },
    {
      label: 'nested checkpoint Proxy',
      makeCandidate: (onGet) => {
        const candidate = structuredClone(valid);
        candidate.world.clock = new Proxy(candidate.world.clock, { get: onGet });
        return candidate;
      },
    },
  ]) {
    let getterCalls = 0;
    const candidate = makeCandidate(() => {
      getterCalls += 1;
      throw new Error('checkpoint Proxy get trap must not run');
    });
    assert.equal(
      validateSimulationCheckpoint(candidate, checkpointExpected()),
      false,
      `${label}: canonical validator`,
    );

    const probe = makeConstructionProbe();
    assertCheckpointError(() => probe.createOwner({
      seed: ROOT_SEED,
      restoredSnapshot: candidate,
    }), label);
    assert.deepEqual(probe.counts, {
      seed: 1,
      validation: 1,
      acceptedClone: 0,
      rng: 0,
      world: 0,
      worldTick: 0,
      conductor: 0,
      conductorDispose: 0,
      subscription: 0,
    }, `${label}: owner construction 必须在 validation gate 保持原子`);
    assert.deepEqual(probe.cloneInputs, []);
    assert.equal(getterCalls, 0);
  }
});

test('caller 显式 null rebuild 与独立 fresh owner 在继续 300 ticks 后仍完全一致', () => {
  const rebuilt = createCheckpointableOwner({
    seed: ROOT_SEED,
    restoredSnapshot: null,
  });
  const independentlyFresh = createCheckpointableOwner({ seed: ROOT_SEED });
  try {
    assert.deepEqual(rebuilt.exportCheckpoint(), independentlyFresh.exportCheckpoint());
    assert.deepEqual(rebuilt.getDomainEvents(), []);
    assert.deepEqual(independentlyFresh.getDomainEvents(), []);
    advance(rebuilt);
    advance(independentlyFresh);
    assert.deepEqual(rebuilt.getDomainEvents(), independentlyFresh.getDomainEvents());
    assert.deepEqual(rebuilt.exportCheckpoint(), independentlyFresh.exportCheckpoint());
    assert.deepEqual(
      rebuilt.exportCheckpoint().rng,
      independentlyFresh.exportCheckpoint().rng,
    );
  } finally {
    rebuilt.dispose();
    independentlyFresh.dispose();
  }
});

test('paused checkpoint restore 后 tick 是不推进 world/RNG/events 的 no-op', () => {
  const source = createCheckpointableOwner({ seed: ROOT_SEED });
  advance(source);
  const pausedCheckpoint = structuredClone(source.exportCheckpoint());
  pausedCheckpoint.control.paused = true;
  source.dispose();
  assert.equal(
    validateSimulationCheckpoint(pausedCheckpoint, checkpointExpected()),
    true,
  );

  const probe = makeConstructionProbe();
  const owner = probe.createOwner({
    seed: ROOT_SEED,
    restoredSnapshot: pausedCheckpoint,
  });
  try {
    const checkpointBeforeTick = owner.exportCheckpoint();
    const eventsBeforeTick = owner.getDomainEvents();
    assert.equal(owner.tick(DT), false);
    assert.equal(probe.counts.worldTick, 0);
    assert.deepEqual(owner.exportCheckpoint(), checkpointBeforeTick);
    assert.deepEqual(owner.exportCheckpoint().rng, checkpointBeforeTick.rng);
    assert.deepEqual(owner.getDomainEvents(), eventsBeforeTick);
  } finally {
    owner.dispose();
  }
});

test('owner tick 校验 dt 并在 dispose 后显式拒绝 tick/export', () => {
  const probe = makeConstructionProbe();
  const owner = probe.createOwner({ seed: ROOT_SEED });
  const checkpointBeforeInvalidTicks = owner.exportCheckpoint();
  const eventsBeforeInvalidTicks = owner.getDomainEvents();

  for (const [label, dt] of [
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ]) {
    assertOwnerError(
      () => owner.tick(dt),
      'INVALID_CHECKPOINT_OWNER_TICK',
      label,
    );
  }
  assert.equal(probe.counts.worldTick, 0);
  assert.deepEqual(owner.exportCheckpoint(), checkpointBeforeInvalidTicks);
  assert.deepEqual(owner.getDomainEvents(), eventsBeforeInvalidTicks);

  assert.equal(owner.tick(DT), true);
  assert.equal(probe.counts.worldTick, 1);
  assert.equal(owner.dispose(), true);
  assertOwnerError(
    () => owner.tick(DT),
    'DISPOSED_CHECKPOINT_OWNER',
    'disposed tick',
  );
  assert.equal(probe.counts.worldTick, 1);
  assertOwnerError(
    () => owner.exportCheckpoint(),
    'DISPOSED_CHECKPOINT_OWNER',
    'disposed export',
  );
});

test('collector 安装失败时 conductor dispose 抛错也不掩盖原错误或中断回滚', () => {
  const probe = makeConstructionProbe({
    throwSubscribeAt: 8,
    throwConductorDispose: true,
  });
  assert.throws(
    () => probe.createOwner({ seed: ROOT_SEED }),
    (error) => {
      assert.strictEqual(error, probe.collectorInstallError);
      return true;
    },
  );
  assert.equal(probe.counts.conductorDispose, 1);
  assert.deepEqual(
    probe.subscriptionOrder,
    EXPECTED_SUBSCRIPTION_ORDER.slice(0, 9),
  );
  assert.deepEqual(probe.unsubscribeCounts, new Array(8).fill(1));
});

test('owner dispose 对 conductor 与九个 collector best-effort exact-once 且幂等', () => {
  const probe = makeConstructionProbe({ throwUnsubscribeAt: 7 });
  const owner = probe.createOwner({ seed: ROOT_SEED });
  assert.deepEqual(probe.subscriptionOrder, EXPECTED_SUBSCRIPTION_ORDER);
  assert.equal(owner.dispose(), true);
  assert.deepEqual(
    probe.unsubscribeCounts,
    new Array(EXPECTED_SUBSCRIPTION_ORDER.length).fill(1),
  );
  assert.equal(owner.dispose(), false);
  assert.deepEqual(
    probe.unsubscribeCounts,
    new Array(EXPECTED_SUBSCRIPTION_ORDER.length).fill(1),
  );
});
