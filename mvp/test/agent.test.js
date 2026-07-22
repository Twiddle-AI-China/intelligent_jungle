// mvp/test/agent.test.js —— 日界变奏 evaluateDay 的规则边界：
// 散巢、漫游变异、密度档位、dwell 基线、变异上限、均衡保持。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachPipelineConductor,
  evaluateDay,
  filterMutationBounds,
  ensurePatternMutation,
  meanTreePatternSimilarity,
  planFromLlm,
  ruleSequencePlan,
  padDiversityBranchWeights,
  bassRootBranchWeights,
} from '../src/agent.js';
import { createWorld } from '../src/world.js';
import { CONFIG } from '../src/config.js';
import { colorOptions } from '../src/harmony.js';
import { advanceTo, mulberry32 } from './helpers.js';

const CFG = { ...CONFIG.agent, branchCount: 5, dwellBase: 40 }; // pad 尺度

test('planFromLlm 同时保留旧家枝变异与严格 cell mutation 结果', () => {
  const pattern = {
    version: 2, pitchBranchCount: 5, stepCount: 16,
    occupiedCells: [{ pitchBranchId: 1, stepIndex: 3, count: 2 }],
  };
  const cellMutation = {
    from: { pitchBranchId: 1, stepIndex: 3 },
    to: { pitchBranchId: 2, stepIndex: 5 },
  };
  const plan = planFromLlm({ flocks: [{
    dwellBeats: 4,
    activeBars: 2,
    holdLoops: 4,
    mutations: [{ from: 0, to: 1 }],
    cellMutations: [cellMutation],
  }] }, [{ birdId: 7, homeBranch: 0 }], { densityTier: 'normal' }, {
    ...CONFIG.agent, branchCount: 5,
  }, pattern);
  assert.deepEqual(plan.mutations, [{ birdId: 7, from: 0, to: 1 }]);
  assert.deepEqual(plan.cellMutations, [cellMutation]);
  assert.deepEqual(plan.sequencePattern.occupiedCells, [
    { pitchBranchId: 2, stepIndex: 5, count: 2 },
  ]);
  assert.equal(planFromLlm({ flocks: [{
    dwellBeats: 4, activeBars: 2, holdLoops: 4, mutations: [],
    cellMutations: [{
      from: { pitchBranchId: 4, stepIndex: 3 },
      to: { pitchBranchId: 2, stepIndex: 5 },
    }],
  }] }, [], { densityTier: 'normal' }, CONFIG.agent, pattern), null,
  '空来源不得在 agent 边界被再次放过');
});

test('规则 Sequence 每保持期只移动一个 onset，其余日原样继承', () => {
  const pattern = {
    version: 2, pitchBranchCount: 5, stepCount: 16,
    occupiedCells: [{ pitchBranchId: 1, stepIndex: 3, count: 2 }],
  };
  const held = ruleSequencePlan(pattern, 3, { holdLoops: 4, maxMutations: 2 });
  assert.deepEqual(held.mutations, []);
  assert.deepEqual(held.summary, pattern);
  const changed = ruleSequencePlan(pattern, 4, { holdLoops: 4, maxMutations: 2 });
  assert.deepEqual(changed.mutations, [{
    from: { pitchBranchId: 1, stepIndex: 3 },
    to: { pitchBranchId: 0, stepIndex: 3 },
  }]);
  assert.deepEqual(changed.summary.occupiedCells, [
    { pitchBranchId: 0, stepIndex: 3, count: 2 },
  ]);
});

test('非 Jungle gridDrift 每日最多增删一个 onset，逐步逼近物种带且受相似度保护', () => {
  const sparse = {
    version: 2, pitchBranchCount: 5, stepCount: 16,
    occupiedCells: [{ pitchBranchId: 2, stepIndex: 0, count: 1 }],
  };
  const raised = ruleSequencePlan(sparse, 1, { gridDriftBand: [2, 5], maxMutations: 2 });
  assert.equal(raised.additions.length, 1);
  assert.equal(raised.removals.length, 0);
  assert.equal(new Set(raised.summary.occupiedCells.map((cell) => cell.stepIndex)).size, 2);
  assert.equal(raised.gridDrift.nextOnsetCount, 2);
  assert.ok(raised.gridDrift.similarity >= 0.5);

  const dense = {
    version: 2, pitchBranchCount: 5, stepCount: 16,
    occupiedCells: [0, 2, 4, 6, 8, 10].map((stepIndex, index) => ({
      pitchBranchId: index % 5, stepIndex, count: 1,
    })),
  };
  const lowered = ruleSequencePlan(dense, 1, { gridDriftBand: [2, 5], maxMutations: 2 });
  assert.equal(lowered.additions.length, 0);
  assert.equal(lowered.removals.length, 1);
  assert.equal(new Set(lowered.summary.occupiedCells.map((cell) => cell.stepIndex)).size, 5);

  const guarded = ruleSequencePlan(sparse, 1, {
    gridDriftBand: [2, 5], gridDriftMinSimilarity: 0.75, maxMutations: 2,
  });
  assert.deepEqual(guarded.summary, sparse, '单次加点令 Jaccard 过低时应放弃整包');
});

test('非 Jungle 带外网格连续 16 日单向进入偏好带且不越界', () => {
  let summary = { version: 2, pitchBranchCount: 5, stepCount: 16, occupiedCells: [] };
  const counts = [];
  for (let day = 1; day <= 16; day += 1) {
    const direction = summary.occupiedCells.length < 4 ? 'low' : 'within';
    const plan = ruleSequencePlan(summary, day, {
      holdLoops: 99, gridDriftBand: [4, 6], onsetCountDirection: direction,
    });
    summary = plan.summary;
    counts.push(summary.occupiedCells.length);
  }
  assert.deepEqual(counts.slice(0, 5), [1, 2, 3, 4, 4]);
  assert.ok(counts.every((count, index) => index === 0 || count >= counts[index - 1]));
  assert.ok(counts.every((count) => count <= 6));
});

test('ruleSequencePlan day=0 不产生负索引变异', () => {
  const pattern = {
    version: 2, pitchBranchCount: 5, stepCount: 16,
    occupiedCells: [{ pitchBranchId: 1, stepIndex: 3, count: 1 }],
  };
  const result = ruleSequencePlan(pattern, 0, { holdLoops: 4, maxMutations: 2 });
  assert.deepEqual(result.summary, pattern);
  assert.deepEqual(result.mutations, []);
});

test('Bass 间隔规律偏低时把密集起音移入最大循环空隙', () => {
  const pattern = {
    version: 2, pitchBranchCount: 5, stepCount: 16,
    occupiedCells: [
      { pitchBranchId: 0, stepIndex: 0, count: 1 },
      { pitchBranchId: 1, stepIndex: 1, count: 1 },
      { pitchBranchId: 0, stepIndex: 8, count: 1 },
    ],
  };
  const result = ruleSequencePlan(pattern, 1, {
    holdLoops: 4, maxMutations: 1, regularityDirection: 'low',
  });
  assert.equal(result.mutations.length, 1);
  assert.deepEqual(result.mutations[0].from, { pitchBranchId: 1, stepIndex: 1 });
  assert.deepEqual(result.mutations[0].to, { pitchBranchId: 1, stepIndex: 12 });
});

test('Jungle 起音偏低时规则 Agent 补充 break 骨架，而非永久移动稀疏旧点', () => {
  const pattern = {
    version: 2, pitchBranchCount: 5, stepCount: 16,
    occupiedCells: [
      { pitchBranchId: 2, stepIndex: 0, count: 1 },
      { pitchBranchId: 2, stepIndex: 8, count: 1 },
    ],
  };
  const result = ruleSequencePlan(pattern, 1, {
    holdLoops: 4, maxMutations: 2, preferJungleGrid: true, onsetCountDirection: 'low',
  });
  assert.equal(result.mutations.length, 0);
  assert.deepEqual(result.additions, [
    { pitchBranchId: 1, stepIndex: 4, count: 1 },
    { pitchBranchId: 3, stepIndex: 12, count: 1 },
  ]);
  assert.equal(new Set(result.summary.occupiedCells.map((cell) => cell.stepIndex)).size, 4);
});

test('Jungle 同拍多音高优先拆到空强拍', () => {
  const pattern = {
    version: 2, pitchBranchCount: 5, stepCount: 16,
    occupiedCells: [
      { pitchBranchId: 1, stepIndex: 4, count: 1 },
      { pitchBranchId: 3, stepIndex: 4, count: 1 },
      { pitchBranchId: 2, stepIndex: 8, count: 1 },
    ],
  };
  const result = ruleSequencePlan(pattern, 1, { maxMutations: 2, preferJungleGrid: true });
  assert.deepEqual(result.mutations, [{
    from: { pitchBranchId: 3, stepIndex: 4 },
    to: { pitchBranchId: 3, stepIndex: 0 },
  }]);
  assert.equal(new Set(result.summary.occupiedCells.map((cell) => cell.stepIndex)).size, 3);
});

function stats(over = {}) {
  return {
    day: 1,
    species: 'pad',
    branchLoads: [2, 2, 1, 1, 2], // 无拥挤（< crowdedBranchSize=3）
    switches: 0,
    perBirdSwitches: {},
    meanDwell: 38,         // 在 pad 期望区间 [20, 80] 内
    dwellSampleCount: 5,
    activeCount: 5,
    birdCount: 8,
    silentRatio: 0,
    switchRate: 0,
    densityTier: 'normal',
    dwellBaseline: 1,
    ...over,
  };
}

function assignments(count = 8) {
  // 把鸟均匀放到 5 根家枝上
  return Array.from({ length: count }, (_, i) => ({ birdId: i, homeBranch: i % 5 }));
}

test('散巢：拥挤家枝上的鸟被搬去最轻的枝，理由含枝号', () => {
  const s = stats({ branchLoads: [3, 1, 0, 1, 2] }); // 枝0拥挤，枝2最轻
  const d = evaluateDay(s, assignments(), CFG, () => 0.999); // 关掉漫游
  assert.equal(d.mutations.length, 1);
  assert.equal(d.mutations[0].from, 0);
  assert.equal(d.mutations[0].to, 2);
  assert.match(d.reason, /散巢/);
});

test('漫游变异：无拥挤时按概率注入一只家枝变异，from≠to', () => {
  const rngSeq = [0.1, 0.0, 0.5]; // 漫游判定通过 + 选鸟 + 选枝
  let i = 0;
  const d = evaluateDay(stats(), assignments(), CFG, () => rngSeq[i++ % rngSeq.length]);
  assert.equal(d.mutations.length, 1);
  assert.notEqual(d.mutations[0].from, d.mutations[0].to);
  assert.match(d.reason, /漫游/);
});

test('变异上限：散巢+漫游同一天发生也不超过 maxMutationsPerDay', () => {
  const s = stats({ branchLoads: [4, 0, 0, 2, 2] });
  const d = evaluateDay(s, assignments(), CFG, () => 0.01); // 漫游必触发
  assert.ok(d.mutations.length <= CFG.maxMutationsPerDay);
});

test('密度升档：白天沉默占比过阈值 → 升一档', () => {
  const d = evaluateDay(stats({ silentRatio: 0.5 }), assignments(), CFG, () => 0.999);
  assert.equal(d.densityTier, 'full');
  assert.match(d.reason, /密度/);
});

test('密度降档：换枝率过疯 → 降一档', () => {
  const d = evaluateDay(stats({ switchRate: 9 }), assignments(), CFG, () => 0.999);
  assert.equal(d.densityTier, 'sparse');
});

test('dwell 基线：偏短上调；有限上界才报偏长；hi=∞ 永不偏长（P1-1）', () => {
  const melodyCfg = {
    ...CFG,
    dwellBase: 1.2,
    dwellPref: { lo: 0.5, hi: 2, slope: 2 / 3 },
  };
  const short = evaluateDay(
    stats({ meanDwell: 0.1, meanDwellBeats: 0.1, dwellBaseline: 1 }),
    assignments(),
    melodyCfg,
    () => 0.999,
  );
  assert.ok(short.dwellBaseline > 1);
  assert.match(short.reason, /偏短/);

  const long = evaluateDay(
    stats({ meanDwell: 9, meanDwellBeats: 9, dwellBaseline: 1 }),
    assignments(),
    melodyCfg,
    () => 0.999,
  );
  assert.ok(long.dwellBaseline < 1);
  assert.match(long.reason, /偏长/);
  assert.ok(long.dwellBaseline >= CFG.dwellBaselineMin && long.dwellBaseline <= CFG.dwellBaselineMax);

  const padCfg = {
    ...CFG,
    dwellBase: 40,
    dwellPref: { lo: 8, hi: Number.POSITIVE_INFINITY, slope: 1 / 8 },
  };
  const openHi = evaluateDay(
    stats({ meanDwellBeats: 200, meanDwell: 200, dwellBaseline: 1 }),
    assignments(),
    padCfg,
    () => 0.999,
  );
  assert.equal(openHi.dwellBaseline, 1, 'pad/bass hi=∞ 不得报偏长');
  assert.doesNotMatch(openHi.reason, /偏长/);
});

test('economy 换枝偏低→缩短 dwell（不压偏好下限）且保持满活跃窗', () => {
  const cfg = {
    ...CFG,
    dwellBase: 1.2,
    dwellPref: { lo: 0.5, hi: 2 },
    barsPerDay: 4,
  };
  const result = evaluateDay(
    stats({ meanDwellBeats: 1.2, meanDwell: 1.2 }),
    assignments(),
    cfg,
    () => 0.999,
    { deviation: { branchChanges: { direction: 'low', amount: 2 } } },
  );
  assert.equal(result.dwellBaseline, 1 - cfg.dwellBaselineStep);
  assert.equal(result.activeBars, 4, '偏低/沉默高都保持满窗');
  assert.ok(cfg.dwellBase * result.dwellBaseline >= cfg.dwellPref.lo,
    '本次下调不压出偏好带下限；rulePlan 另有最终 lo clamp');
  assert.match(result.reason, /驻留基线:1\.00→0\.85（换枝偏低）/);
});

test('economy 换枝偏高→延长 dwell 且 activeBars 收窄一档', () => {
  const cfg = { ...CFG, barsPerDay: 4 };
  const result = evaluateDay(
    stats(), assignments(), cfg, () => 0.999,
    { deviation: { branchChanges: { direction: 'high', amount: 3 } } },
  );
  assert.equal(result.dwellBaseline, 1 + cfg.dwellBaselineStep);
  assert.equal(result.activeBars, 3);
  assert.match(result.reason, /驻留基线:1\.00→1\.15（换枝偏高）/);
  assert.match(result.reason, /活跃窗:4→3 小节（换枝偏高）/);
});

test('economy 换枝带内→dwell/密度/activeBars 均不动', () => {
  const result = evaluateDay(
    stats(), assignments(), { ...CFG, barsPerDay: 4 }, () => 0.999,
    { deviation: { branchChanges: { direction: 'within', amount: 0 } } },
  );
  assert.equal(result.dwellBaseline, 1);
  assert.equal(result.densityTier, 'normal');
  assert.equal(result.activeBars, 4);
  assert.match(result.reason, /保持/);
});

test('crossVoice 偏低·suppress → 收窄活跃窗；不改 densityTier（梯度交给 vocalizeBias）', () => {
  const mild = evaluateDay(
    stats(), assignments(), { ...CFG, barsPerDay: 4 }, () => 0.999,
    {
      deviation: { crossVoice: { direction: 'low', amount: 0.04 } },
      crossVoiceHint: 'suppress',
      crossVoiceConflictRatio: 0.5,
    },
  );
  assert.equal(mild.densityTier, 'normal', 'suppress 不粘住 sparse');
  assert.equal(mild.activeBars, 3);
  assert.match(mild.reason, /错峰偏低·抑制/);
});

test('crossVoice 偏低·encourage → 升密度并满窗', () => {
  const result = evaluateDay(
    stats({ densityTier: 'sparse' }), assignments(),
    { ...CFG, barsPerDay: 4 }, () => 0.999,
    {
      deviation: { crossVoice: { direction: 'low', amount: 0.04 } },
      crossVoiceHint: 'encourage',
      crossVoiceConflictRatio: 0.1,
    },
  );
  assert.equal(result.densityTier, 'normal');
  assert.equal(result.activeBars, 4);
  assert.match(result.reason, /错峰偏低·填充/);
});

test('activeBars 无收窄证据时每日回补一小节，负证据仍优先', () => {
  const cfg = { ...CFG, barsPerDay: 4 };
  let activeBars = 1;
  const recovered = [];
  for (let day = 1; day <= 4; day += 1) {
    const result = evaluateDay(
      stats({ day, activeBars }), assignments(), cfg, () => 0.999,
      { deviation: { branchChanges: { direction: 'within', amount: 0 } } },
    );
    activeBars = result.activeBars;
    recovered.push(activeBars);
  }
  assert.deepEqual(recovered, [2, 3, 4, 4]);

  const suppressed = evaluateDay(
    stats({ activeBars: 2 }), assignments(), cfg, () => 0.999,
    {
      deviation: {
        branchChanges: { direction: 'within', amount: 0 },
        crossVoice: { direction: 'low', amount: 0.04 },
      },
      crossVoiceHint: 'suppress',
    },
  );
  assert.equal(suppressed.activeBars, 1, '真实抑制证据必须覆盖低优先级恢复');
});

test('Master 生存动作不再修改 activeBars，且现有安全证据仍优先', () => {
  const cfg = { ...CFG, barsPerDay: 4 };
  const rest = evaluateDay(
    stats({ activeBars: 4, densityTier: 'normal' }), assignments(), cfg, () => 0.999,
    {
      survival: { health: { value: 20 }, stamina: { value: 60 }, food: { value: 60 } },
      survivalAction: { id: 'rest', suggestions: [{ dimension: 'activeBars', delta: -99 }] },
    },
  );
  assert.equal(rest.densityTier, 'normal', '资源策略不直接改写音乐密度');
  assert.equal(rest.activeBars, 4, '外部 activeBars delta 必须被 canonical 动作丢弃');
  assert.deepEqual(rest.survivalApplied, []);

  const safetyWins = evaluateDay(
    stats({ activeBars: 3, densityTier: 'normal', silentRatio: 0.9 }), assignments(), cfg, () => 0.999,
    {
      survival: { health: { value: 20 }, stamina: { value: 60 }, food: { value: 60 } },
      survivalAction: 'rest',
    },
  );
  assert.equal(safetyWins.densityTier, 'full', '沉默安全证据 priority=3 必须覆盖休息 priority=0.5');
  assert.equal(safetyWins.activeBars, 4, 'survival 不得阻断既有回补路径');
});

test('rulePlan 真链路把被压低的 activeBars 在 16 日内恢复到满窗', () => {
  const config = { ...CONFIG, agent: { ...CONFIG.agent, silentRaiseThreshold: 1 } };
  const world = createWorld({ config, rng: mulberry32(1701) });
  world.setFlockPlan('pad', { activeBars: 1 });
  const applies = [];
  attachPipelineConductor(world, {
    config,
    rng: () => 0.999,
    ecologyProvider: () => ({
      deviation: {
        branchChanges: { direction: 'within', amount: 0 },
        onsetCount: { direction: 'within', amount: 0 },
        crossVoice: { direction: 'within', amount: 0 },
      },
      crossVoiceHint: 'hold',
    }),
    onApply: (event) => applies.push(event),
  });
  advanceTo(world, 16, 0.02);
  const padBars = applies.map((event) => event.plans.pad.plan.activeBars);
  assert.deepEqual(padBars.slice(0, 3), [2, 3, 4]);
  assert.ok(padBars.slice(3).every((value) => value === config.tempo.barsPerDay));
});

test('rulePlan 真链路消费 ecology deviation，并把 activeBars 应用到计划', () => {
  // 隔离 activeBars 断言：把沉默升档阈值抬到 1，避免首日沉默保护强制保持满窗。
  const config = { ...CONFIG, agent: { ...CONFIG.agent, silentRaiseThreshold: 1 } };
  const world = createWorld({ config, rng: mulberry32(73) });
  const applies = [];
  attachPipelineConductor(world, {
    config,
    rng: () => 0.999,
    ecologyProvider: (treeId) => ({
      deviation: {
        branchChanges: { direction: 'within', amount: 0 },
        onsetCount: { direction: treeId === 'texture' ? 'high' : 'within', amount: 2 },
      },
    }),
    onApply: (event) => applies.push(event),
  });
  advanceTo(world, 2, 0.02);
  const day2 = applies.find((event) => event.day === 2);
  assert.ok(day2);
  assert.equal(day2.plans.texture.plan.activeBars, config.tempo.barsPerDay - 1);
  assert.match(day2.plans.texture.plan.reason, /起音偏高/);
  assert.equal(day2.plans.pad.plan.activeBars, config.tempo.barsPerDay, '带内树仍为满窗');
});

test('seasonMigrationOnly 不进漫游候选（P2-1）', () => {
  const bassCfg = { ...CFG, seasonMigrationOnly: true, roamMutationChance: 1 };
  const d = evaluateDay(stats({ species: 'bass' }), assignments(2), bassCfg, () => 0.01);
  assert.equal(d.mutations.length, 0);
  assert.doesNotMatch(d.reason, /漫游/);
});

test('bass 计划 dwell 不得压出偏好带下限（P1-1 clamp）', () => {
  // 直接测 evaluateDay + 与 rulePlan 相同的 clamp 公式
  const dwellPref = { lo: 16, hi: Number.POSITIVE_INFINITY };
  const bassCfg = {
    ...CONFIG.agent,
    branchCount: 5,
    dwellBase: 16,
    dwellPref,
    seasonMigrationOnly: true,
    dwellBaselineMin: 0.7,
    dwellBaselineMax: 1.4,
    dwellBaselineStep: 0.15,
  };
  // 人为把基线压到下限 0.7 → 16*0.7=11.2 < 16，clamp 后应回 16
  const base = evaluateDay(
    stats({
      species: 'bass',
      meanDwellBeats: 20,
      dwellBaseline: 0.7,
      dwellSampleCount: 3,
      branchLoads: [1, 1, 0, 0, 0],
    }),
    assignments(2),
    bassCfg,
    () => 0.999,
  );
  const raw = 16 * base.dwellBaseline;
  const clamped = Math.max(raw, dwellPref.lo);
  assert.ok(base.dwellBaseline <= 1);
  assert.equal(clamped, 16, `计划 dwell 须 ≥ lo=16，得 ${clamped}（raw=${raw}）`);
});

test('均衡保持：无规则触发时不变异、不调档，理由为保持', () => {
  const d = evaluateDay(stats(), assignments(), CFG, () => 0.999);
  assert.equal(d.mutations.length, 0);
  assert.equal(d.densityTier, 'normal');
  assert.equal(d.dwellBaseline, 1);
  assert.match(d.reason, /保持/);
});

test('pattern 相似度先按树计算再等权平均', () => {
  assert.equal(meanTreePatternSimilarity(
    { pad: [0, 1, 2, 3], melody: [1, 2] },
    { pad: [0, 1, 2, 3], melody: [1, 4] },
  ), 0.75, 'pad=1、melody=0.5，应按树等权为 0.75 而非按鸟数加权');
});

test('Sequence pattern 相似度只比较起音集合，不被共同空格虚高', () => {
  const summary = (cells) => ({
    version: 2, pitchBranchCount: 5, stepCount: 16, occupiedCells: cells,
  });
  assert.equal(meanTreePatternSimilarity(
    { melody: summary([{ pitchBranchId: 0, stepIndex: 0, count: 1 }]) },
    { melody: summary([{ pitchBranchId: 4, stepIndex: 15, count: 1 }]) },
  ), 0);
  assert.equal(meanTreePatternSimilarity(
    { melody: summary([
      { pitchBranchId: 0, stepIndex: 0, count: 1 },
      { pitchBranchId: 1, stepIndex: 4, count: 1 },
    ]) },
    { melody: summary([
      { pitchBranchId: 0, stepIndex: 0, count: 1 },
      { pitchBranchId: 2, stepIndex: 4, count: 1 },
    ]) },
  ), 1 / 3);
});

test('越界 mutation 在应用前过滤并保留 dropped 原因', () => {
  const result = filterMutationBounds([
    { birdId: 1, from: 0, to: 3 },
    { birdId: 2, from: 1, to: 99 },
  ], 5);
  assert.deepEqual(result.accepted, [{ birdId: 1, from: 0, to: 3 }]);
  assert.equal(result.dropped[0].reason, 'branch-out-of-range');
});

test('pad 音级多样性权重：同音级拥挤时软推向未占音级', () => {
  // 枝 0/2 同为 F；当前 {0,2,2} 只占 F，C/A 枝应获得更高权重。
  const weights = padDiversityBranchWeights(
    [53, 60, 65, 69, 72],
    [0, 2, 2],
    [1, 1, 1, 0.35, 0.35],
  );
  assert.equal(weights.length, 5);
  assert.ok(weights.every((weight) => weight > 0 && weight <= 1), '软偏好不得锁死任何枝');
  assert.ok(weights[1] > weights[0]);
  assert.ok(weights[3] > weights[2]);
  assert.ok(weights[4] > weights[2]);
});

test('holdLoops 期满：branch set 未变时强制一只鸟去新枝', () => {
  const birds = [
    { id: 10, homeBranch: 0 },
    { id: 11, homeBranch: 1 },
    { id: 12, homeBranch: 2 },
  ];
  const result = ensurePatternMutation([
    { birdId: 10, from: 0, to: 1 },
    { birdId: 11, from: 1, to: 0 },
  ], birds, 5, () => 0);
  const after = new Map(birds.map((bird) => [bird.id, bird.homeBranch]));
  for (const mutation of result) after.set(mutation.birdId, mutation.to);
  assert.ok([...after.values()].some((branch) => branch === 3 || branch === 4));
  assert.ok(result.some((mutation) => mutation.forced));
});

test('crossVoice suppress 下发 0.5 梯度，不再整树静音', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(91) });
  attachPipelineConductor(world, {
    config: CONFIG,
    ecologyProvider: (treeId) => ({ crossVoiceHint: treeId === 'pad' ? 'suppress' : 'hold' }),
  });
  advanceTo(world, 2, 0.02);
  assert.equal(world.getVocalizeBias('pad'), 0.5);
  assert.equal(world.getVocalizeBias('melody'), 1);
  assert.equal(world.getVocalizeBias('bass'), 1);
  assert.equal(world.getVocalizeBias('texture'), 1);
});

test('holdLoops 保持期内遇生态偏离，允许一项小变自适应', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(92) });
  const melody = world.getSnapshot().trees.find((tree) => tree.id === 'melody');
  const bird = melody.birds[0];
  const applies = [];
  const planFor = (tree) => ({
    mutations: tree.id === 'melody'
      ? [{ birdId: bird.id, from: bird.homeBranch, to: (bird.homeBranch + 1) % 5 }]
      : [],
    densityTier: 'normal',
    dwellBeats: CONFIG.species[tree.species].dwellBeats,
    activeBars: 4,
    holdLoops: 4,
    reason: '测试计划',
  });
  attachPipelineConductor(world, {
    config: CONFIG,
    evaluator: async () => Object.fromEntries(CONFIG.trees.map((tree) => [tree.id, planFor(tree)])),
    ecologyProvider: (treeId) => treeId === 'melody'
      ? { deviation: { branchChanges: { direction: 'low', amount: 2 } } }
      : null,
    onApply: (event) => applies.push(event),
  });
  advanceTo(world, 2, 0.02);
  await new Promise((resolve) => setTimeout(resolve, 5));
  advanceTo(world, 3, 0.02);
  const applied = applies.find((event) => event.day === 3)?.plans.melody;
  assert.equal(applied.held.softened, true);
  assert.equal(applied.plan.mutations.length, 1);
  assert.match(applied.plan.reason, /保持期软适应:换枝偏低/);
});

test('masterInput 优先吃四树生态得分，flock 日统计包含 meanDwellBeats', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(41) });
  const reviews = [];
  const scores = { pad: 0.1, melody: 0.2, bass: 0.3, texture: 0.4 };
  attachPipelineConductor(world, {
    config: CONFIG,
    pipeline: {
      dawnPlan: () => ({
        reviewedDay: null,
        flock: { plan: null, fallback: true },
        master: { decision: null, source: 'rule-fallback', fallback: true },
      }),
      dayReview: (input) => { reviews.push(input); },
    },
    ecologyProvider: (treeId) => ({ score: scores[treeId] }),
  });
  advanceTo(world, 2, 0.02);
  assert.equal(reviews.length, 1);
  // T28：treeScores 为短历史数组（含刚结束当天），非当日标量
  assert.deepEqual(reviews[0].masterInput.observations.treeScores, [[0.1], [0.2], [0.3], [0.4]]);
  assert.ok(Array.isArray(reviews[0].masterInput.observations.harmonyScores[0]));
  assert.equal(reviews[0].masterInput.state.currentColorId, '日光');
  assert.ok(Number.isInteger(reviews[0].masterInput.state.daysInColor));
  assert.ok(reviews[0].flockSnapshot.flocks.every((flock) => Number.isFinite(flock.dailyStats.meanDwellBeats)));
  assert.ok(reviews[0].flockSnapshot.flocks.every((flock) => flock.sequencePattern?.version === 2));
  assert.ok(reviews[0].flockSnapshot.flocks.every((flock) => flock.sequencePattern?.stepCount === 16));
  // P1-A：每个 flock 携带每只鸟当前家枝列表，供模型 mutations.from 取用。
  for (const flock of reviews[0].flockSnapshot.flocks) {
    assert.ok(flock.homeBranches.every((branch) => Number.isInteger(branch) && branch >= 0),
      '复盘时家枝快照保持合法；后续 sequence step 可再改变实时 homeBranch');
  }
});

test('端到端：连续两天低分 → decideMaster 真链路换档（T28 P0）', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(7) });
  const masters = [];
  attachPipelineConductor(world, {
    config: CONFIG,
    // 无 pipeline：黎明直接 decideMaster(mInput)，走真实 observations 短历史
    ecologyProvider: () => ({ score: 0.2 }), // 全树持续低于 LOW_SCORE_FLOOR=0.4
    onMaster: (e) => masters.push(e),
  });
  advanceTo(world, 2, 0.02); // 第 2 天黎明：历史长度 1 → 单日低分只调 tension
  const day2 = masters.find((e) => e.day === 2);
  assert.ok(day2, '第 2 天应有 master 决策');
  assert.match(day2.decision.reason, /当日低分|张力小幅上调/,
    '仅一天历史时不得触发连续低分换档');
  const colorAfterDay2 = day2.frame.color.id;

  advanceTo(world, 3, 0.02); // 第 3 天黎明：历史 [0.2,0.2] → streak=2 → 换档
  const day3 = masters.find((e) => e.day === 3);
  assert.ok(day3);
  assert.match(day3.decision.reason, /连续2日低分/);
  assert.notEqual(day3.decision.colorId, colorAfterDay2, '连续低分应换下一色彩档');
  assert.equal(day3.frame.color.id, day3.decision.colorId);
});

test('master 换季预告生效日触发 bass 成批迁移', () => {
  // 季长 2：第 2 天 = 季末日（决策带 nextSeason → 预告+bass 聚集），第 3 天黎明入夏领迁移
  const CFG = { ...CONFIG, harmony: { ...CONFIG.harmony, defaultSeasonLength: 2 } };
  const world = createWorld({ config: CFG, rng: () => 0 });
  const before = world.getSnapshot().trees.find((tree) => tree.id === 'bass').birds
    .map((bird) => bird.homeBranch);
  const applies = [];
  attachPipelineConductor(world, {
    config: CFG,
    pipeline: {
      dawnPlan: () => ({
        reviewedDay: 1,
        flock: { plan: null, fallback: true },
        master: {
          decision: { colorId: '挂四', tension: 0.4, nextSeason: 'summer', seasonLength: 8, reason: '换季' },
          source: 'llm',
          fallback: false,
        },
      }),
      dayReview: () => {},
    },
    onApply: (event) => applies.push(event),
  });
  advanceTo(world, 3, 0.02);
  const after = world.getSnapshot().trees.find((tree) => tree.id === 'bass').birds
    .map((bird) => bird.homeBranch);
  assert.notDeepEqual(after, before);
  const day3 = applies.find((event) => event.day === 3);
  assert.ok(day3.migrations.some((move) => move.treeId === 'bass'), '入夏黎明 bass 应成批迁移');
});

test('USER 档：黎明跳过 plan/mutations/setFlockPlan/setDensityTier（T31 A）', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(11) });
  world.setTreeControl('pad', 'USER');
  const flockCalls = [];
  const densityCalls = [];
  const origFlock = world.setFlockPlan.bind(world);
  const origDensity = world.setDensityTier.bind(world);
  world.setFlockPlan = (id, plan) => { flockCalls.push(id); return origFlock(id, plan); };
  world.setDensityTier = (id, tier) => { densityCalls.push(id); return origDensity(id, tier); };

  const padBefore = world.getSnapshot().trees.find((t) => t.id === 'pad').birds
    .map((b) => [b.id, b.homeBranch]);
  const applies = [];
  attachPipelineConductor(world, {
    config: CONFIG,
    rng: mulberry32(12),
    onApply: (e) => applies.push(e),
  });
  advanceTo(world, 2, 0.02);
  const day2 = applies.find((e) => e.day === 2);
  assert.ok(day2, '第 2 天应有 onApply');
  assert.equal(day2.plans.pad.source, 'USER');
  assert.deepEqual(day2.plans.pad.plan.mutations, []);
  assert.match(day2.plans.pad.plan.reason, /USER 接管/);
  assert.ok(!flockCalls.includes('pad'), 'USER 树不得 setFlockPlan');
  assert.ok(!densityCalls.includes('pad'), 'USER 树不得 setDensityTier');
  assert.ok(flockCalls.includes('melody'), 'AGENT 树仍应 setFlockPlan');
  assert.ok(densityCalls.includes('melody'), 'AGENT 树仍应 setDensityTier');
  assert.notEqual(day2.plans.melody.source, 'USER');
  const padAfter = world.getSnapshot().trees.find((t) => t.id === 'pad').birds
    .map((b) => [b.id, b.homeBranch]);
  assert.deepEqual(padAfter, padBefore, 'USER 跳过不得改写 homeBranch');
});

test('onApply 显式报告越界变异为 dropped，世界不写入非法家枝', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(52) });
  const padBird = world.getSnapshot().trees.find((tree) => tree.id === 'pad').birds[0];
  const applies = [];
  const basePlan = (tree) => ({
    mutations: [], densityTier: 'normal', dwellBeats: CONFIG.species[tree.species].dwellBeats,
    activeBars: 4, holdLoops: 2, reason: 'test',
  });
  attachPipelineConductor(world, {
    config: CONFIG,
    evaluator: async () => Object.fromEntries(CONFIG.trees.map((tree) => [tree.id, {
      ...basePlan(tree),
      ...(tree.id === 'pad' ? { mutations: [{ birdId: padBird.id, from: 0, to: 99 }] } : {}),
    }])),
    onApply: (event) => applies.push(event),
  });
  advanceTo(world, 2, 0.02);
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  advanceTo(world, 3, 0.02);
  const day3 = applies.find((event) => event.day === 3);
  assert.ok(day3.dropped.some((entry) => entry.treeId === 'pad' && entry.to === 99));
  assert.ok(world.getSnapshot().birds.every((bird) => {
    const tree = world.getSnapshot().trees.find((t) => t.id === bird.treeId);
    return tree?.branches.some((b) => b.id === bird.homeBranch);
  }), '家枝须落在该树真实五条音高枝内');
});

test('bassRootBranchWeights 低枝/根音权重大于高枝（软偏好）', () => {
  const weights = bassRootBranchWeights(5, CONFIG, new Array(5).fill(1));
  assert.equal(weights.length, 5);
  assert.ok(weights[0] > weights[4], '根音枝(0) > 最高枝(4)');
  assert.ok(weights.every((weight, index) => index === 0 || weight <= weights[index - 1]), '权重向高枝单调不增');
  assert.ok(weights.every((w) => w > 0 && w <= 1), '软偏好：全正且≤1');
});

test('Master USER 可切换色彩，季长按日界等待；年度走向不再暴露写接口', () => {
  const config = structuredClone(CONFIG);
  const world = createWorld({ config, rng: mulberry32(91) });
  const masters = [];
  const conductor = attachPipelineConductor(world, {
    config,
    rng: mulberry32(92),
    onMaster: (event) => masters.push(event),
  });
  const initial = conductor.getMasterState();
  const alternateColor = colorOptions(initial.season, config.harmony, 0, 'day')
    .find((color) => color.id !== initial.colorId).id;

  assert.equal(conductor.applyUserColor(alternateColor), false, 'AGENT 档不得旁路写 Master');
  assert.equal(conductor.setMasterControl('USER'), 'USER');
  assert.equal(conductor.applyUserColor(alternateColor), true);
  assert.equal(conductor.getMasterState().colorId, alternateColor);
  assert.equal(masters.at(-1).source, 'USER');
  assert.equal(conductor.setUserSeasonLength(8), true);
  assert.equal(conductor.getMasterState().pendingSeasonLength, 8);
  assert.equal(conductor.setUserProgression, undefined);
  assert.equal(conductor.getMasterState().progression, undefined);

  assert.equal(conductor.setMasterControl('AGENT'), 'AGENT');
  assert.equal(conductor.getMasterState().pendingSeasonLength, null);

  conductor.setMasterControl('USER');
  conductor.setUserSeasonLength(8);
  advanceTo(world, 2, 0.02);
  const applied = conductor.getMasterState();
  assert.equal(applied.seasonLength, 8);
  assert.equal(applied.season, initial.season);
});
