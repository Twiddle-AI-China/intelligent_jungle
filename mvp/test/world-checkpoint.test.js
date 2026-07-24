import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { createDeterministicRng } from '../src/deterministic-rng.js';
import { createWorld } from '../src/world.js';

const jsonRoundTrip = (value) => JSON.parse(JSON.stringify(value));

function allBirds(state) {
  return state.world.trees.flatMap((tree) => tree.birds);
}

function treeState(state, treeId) {
  return state.world.trees.find((tree) => tree.id === treeId);
}

function exerciseWorld(seed = 7) {
  const config = structuredClone(CONFIG);
  const worldRng = createDeterministicRng(seed);
  const world = createWorld({ config, rng: worldRng });

  assert.equal(world.setTempo(72), true);
  assert.equal(world.setBeatsPerBar(2), true);
  assert.equal(world.setBranchPreference('pad', [0.1, 0.2, 0.3, 0.4, 0.5]), true);
  assert.equal(world.setVocalizeBias('pad', 0.75), true);
  assert.equal(world.setDensityTier('pad', 'full'), true);
  assert.equal(world.setFlockPlan('pad', { dwellBeats: 3.5, activeBars: 6 }), true);
  assert.ok(world.applySeasonChange(3).length > 0);

  const melodyPattern = {
    version: 2,
    pitchBranchCount: 5,
    stepCount: 16,
    occupiedCells: [
      { pitchBranchId: 1, stepIndex: 0, count: 1 },
      { pitchBranchId: 3, stepIndex: 8, count: 1 },
    ],
  };
  assert.equal(world.setSequencePattern('melody', melodyPattern), true);
  assert.equal(world.setJungleEditPlan('texture', {
    breakEdit: 'repeat2',
    toneEdit: 'dub',
    evidence: {
      onsetCount: 4,
      conflictRatio: 0.25,
      patternSimilarity: 0.5,
      tension: 0.75,
    },
  }), true);

  for (let index = 0; index < 8; index += 1) world.tick(1 / 30);

  assert.equal(world.setTreeControl('texture', 'USER'), true);
  const firstPlacement = world.userPlaceOnBranch('texture', 1, {
    pitchBranchId: 1,
    stepIndex: 9,
    stepCount: 16,
  });
  assert.ok(firstPlacement);
  world.tick(0.25);
  const secondPlacement = world.userPlaceOnBranch('texture', 2, {
    pitchBranchId: 2,
    stepIndex: 9,
    stepCount: 16,
  });
  assert.ok(secondPlacement);
  assert.notEqual(secondPlacement.birdId, firstPlacement.birdId);
  assert.equal(world.userShooBird(firstPlacement.birdId), true);
  assert.equal(world.releaseTreeControl('texture'), true);

  return {
    config,
    firstPlacement,
    secondPlacement,
    world,
    worldRng,
  };
}

test('完整 world wire 经 JSON 往返后以零 RNG、零 dawn 副作用精确恢复', () => {
  const {
    config,
    firstPlacement,
    secondPlacement,
    world,
    worldRng,
  } = exerciseWorld();
  const rendererSnapshot = world.getSnapshot();
  const rawExport = world.exportDeterministicState();
  const state = jsonRoundTrip(rawExport);

  assert.deepEqual(Object.keys(state), ['world', 'sequence', 'control']);
  assert.deepEqual(Object.keys(state.world), ['clock', 'trees']);
  assert.deepEqual(Object.keys(state.sequence), [
    'worldPatterns',
    'jungleEditPlans',
    'lastSequenceStep',
  ]);
  assert.deepEqual(Object.keys(state.control), ['treeControl', 'agentResumeAt', 'tempo']);
  assert.deepEqual(jsonRoundTrip(rawExport), rawExport, '导出必须已经是严格 JSON wire');

  const pad = treeState(state, 'pad');
  const bass = treeState(state, 'bass');
  const texture = treeState(state, 'texture');
  const shooed = allBirds(state).find((bird) => bird.id === firstPlacement.birdId);
  const held = allBirds(state).find((bird) => bird.id === secondPlacement.birdId);
  const rendererBird = rendererSnapshot.birds.find((bird) => bird.id === shooed.id);

  for (const field of [
    'targetBranch',
    'settleAt',
    'returnCause',
    'returnSequence',
    'visitCounts',
    'orbitRadius',
    'orbitAngle',
    'orbitSpeed',
    'bobPhase',
  ]) {
    assert.ok(Object.hasOwn(shooed, field), `wire 必须包含 bird.${field}`);
    assert.equal(Object.hasOwn(rendererBird, field), false, `renderer snapshot 不应拥有 ${field}`);
  }
  assert.ok(Object.hasOwn(pad, 'stats'));
  assert.equal(Object.hasOwn(rendererSnapshot.trees.find((tree) => tree.id === 'pad'), 'stats'), false);
  assert.ok(pad.stats.dayTime > 0, '真实 tick 必须留下开放日统计');
  assert.equal(bass.lastSeasonMigrationDay, 3);
  assert.deepEqual(pad.branchPreference, [0.1, 0.2, 0.3, 0.4, 0.5]);
  assert.equal(pad.vocalizeBias, 0.75);
  assert.deepEqual(state.sequence.worldPatterns.melody, world.getSequencePattern('melody'));
  assert.deepEqual(state.sequence.jungleEditPlans.texture, world.getJungleEditPlan('texture'));
  assert.ok(Number.isInteger(state.sequence.lastSequenceStep.melody));
  assert.equal(state.control.treeControl.texture, 'AGENT');
  assert.ok(Number.isFinite(state.control.agentResumeAt.texture));
  assert.deepEqual(state.control.tempo, { bpm: 72, barsPerDay: 8, beatsPerBar: 2 });
  assert.equal(config.tempo.beatsPerBar, 2, '当前 owner 只修改自己的 config clone');

  assert.equal(shooed.returnCause, 'user');
  assert.equal(shooed.plannedFlight, null, 'Infinity flight 只能编码为 null sentinel');
  assert.equal(held.plannedDwell, null, 'Infinity dwell 只能编码为 null sentinel');
  const finiteDwell = allBirds(state).find((bird) => Number.isFinite(bird.plannedDwell));
  const finiteFlight = allBirds(state).find((bird) => Number.isFinite(bird.plannedFlight));
  assert.ok(finiteDwell);
  assert.ok(finiteFlight);
  assert.equal(
    finiteDwell.plannedDwell,
    allBirds(rawExport).find((bird) => bird.id === finiteDwell.id).plannedDwell,
  );
  assert.equal(
    finiteFlight.plannedFlight,
    allBirds(rawExport).find((bird) => bird.id === finiteFlight.id).plannedFlight,
  );

  // 用合法的隐藏字段改动证明 hydrate 不依赖 renderer snapshot。
  const hiddenBird = pad.birds[0];
  hiddenBird.targetBranch = 2;
  hiddenBird.settleAt += 0.125;
  hiddenBird.returnSequence += 3;
  hiddenBird.visitCounts[2] += 2;
  hiddenBird.orbitRadius += 0.25;
  hiddenBird.orbitAngle += 0.5;
  hiddenBird.orbitSpeed += 0.125;
  hiddenBird.bobPhase += 0.75;
  pad.stats.dayTime += 1;
  pad.stats.silentTime += 1;

  const expected = structuredClone(state);
  const rngState = worldRng.exportState();
  const restoreRng = createDeterministicRng(7, rngState);
  const restoreConfig = structuredClone(CONFIG);
  const restored = createWorld({
    config: restoreConfig,
    rng: restoreRng,
    restoredState: state,
  });

  assert.equal(restoreRng.exportState().drawCount, rngState.drawCount);
  assert.deepEqual(restored.exportDeterministicState(), expected);
  assert.equal(restoreConfig.tempo.beatsPerBar, 2);
  assert.equal(restoreConfig.tempo.barsPerDay, 8);
});

test('恢复输入、重复导出和公开 getter 均不泄漏 world 内部引用', () => {
  const { world, worldRng } = exerciseWorld(17);
  const input = jsonRoundTrip(world.exportDeterministicState());
  const rngState = worldRng.exportState();
  const restored = createWorld({
    config: structuredClone(CONFIG),
    rng: createDeterministicRng(17, rngState),
    restoredState: input,
  });
  const baseline = restored.exportDeterministicState();

  input.world.clock.day = 999;
  input.world.trees[0].birds[0].visitCounts[0] = 999;
  input.sequence.worldPatterns.melody.occupiedCells[0].count = 999;
  input.sequence.jungleEditPlans.texture.evidence.onsetCount = 999;
  input.control.treeControl.pad = 'USER';
  assert.deepEqual(restored.exportDeterministicState(), baseline);

  const exported = restored.exportDeterministicState();
  exported.world.trees[0].stats.dwellSamples.push(999);
  exported.world.trees[0].birds[0].pos.x = 999;
  exported.sequence.worldPatterns.melody.occupiedCells[0].stepIndex = 7;
  exported.control.tempo.bpm = 50;
  assert.deepEqual(restored.exportDeterministicState(), baseline);

  const preference = restored.getBranchPreference('pad');
  const pattern = restored.getSequencePattern('melody');
  const junglePlan = restored.getJungleEditPlan('texture');
  preference[0] = 1;
  pattern.occupiedCells[0].count = 999;
  junglePlan.evidence.tension = 0;
  assert.deepEqual(restored.getBranchPreference('pad'), baseline.world.trees[0].branchPreference);
  assert.deepEqual(restored.getSequencePattern('melody'), baseline.sequence.worldPatterns.melody);
  assert.deepEqual(restored.getJungleEditPlan('texture'), baseline.sequence.jungleEditPlans.texture);
});

test('坏 bird ID 与非严格输入在任何恢复随机消费前原子拒绝', () => {
  const { world, worldRng } = exerciseWorld(23);
  const valid = jsonRoundTrip(world.exportDeterministicState());
  const rngState = worldRng.exportState();

  const cases = [
    ['全局 bird ID 不连续', (state) => {
      state.world.trees[1].birds[0].id += 1;
    }],
    ['额外字段', (state) => {
      state.world.clock.extra = true;
    }],
    ['共享引用', (state) => {
      state.world.trees[1].birds[0].pos = state.world.trees[0].birds[0].pos;
    }],
  ];

  for (const [label, corrupt] of cases) {
    const state = jsonRoundTrip(valid);
    corrupt(state);
    const restoreRng = createDeterministicRng(23, rngState);
    assert.throws(
      () => createWorld({
        config: structuredClone(CONFIG),
        rng: restoreRng,
        restoredState: state,
      }),
      undefined,
      label,
    );
    assert.equal(
      restoreRng.exportState().drawCount,
      rngState.drawCount,
      `${label} 不得消费 RNG`,
    );
  }

  let getterCalls = 0;
  const accessorState = jsonRoundTrip(valid);
  Object.defineProperty(accessorState.world.clock, 'day', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  const accessorRng = createDeterministicRng(23, rngState);
  assert.throws(() => createWorld({
    config: structuredClone(CONFIG),
    rng: accessorRng,
    restoredState: accessorState,
  }));
  assert.equal(getterCalls, 0, '验证不能调用恢复输入 getter');
  assert.equal(accessorRng.exportState().drawCount, rngState.drawCount);
});
