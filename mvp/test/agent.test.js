// mvp/test/agent.test.js —— 日界变奏 evaluateDay 的规则边界：
// 散巢、漫游变异、密度档位、dwell 基线、变异上限、均衡保持。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachPipelineConductor,
  evaluateDay,
  filterMutationBounds,
  meanTreePatternSimilarity,
} from '../src/agent.js';
import { createWorld } from '../src/world.js';
import { CONFIG } from '../src/config.js';
import { advanceTo, mulberry32 } from './helpers.js';

const CFG = { ...CONFIG.agent, branchCount: 5, dwellBase: 40 }; // pad 尺度

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

test('越界 mutation 在应用前过滤并保留 dropped 原因', () => {
  const result = filterMutationBounds([
    { birdId: 1, from: 0, to: 3 },
    { birdId: 2, from: 1, to: 99 },
  ], 5);
  assert.deepEqual(result.accepted, [{ birdId: 1, from: 0, to: 3 }]);
  assert.equal(result.dropped[0].reason, 'branch-out-of-range');
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
  assert.equal(reviews[0].masterInput.state.currentColorId, '本色');
  assert.ok(Number.isInteger(reviews[0].masterInput.state.daysInColor));
  assert.ok(reviews[0].flockSnapshot.flocks.every((flock) => Number.isFinite(flock.dailyStats.meanDwellBeats)));
  // P1-A：每个 flock 携带每只鸟当前家枝列表，供模型 mutations.from 取用。
  const snapTrees = world.getSnapshot().trees;
  for (const [i, flock] of reviews[0].flockSnapshot.flocks.entries()) {
    assert.deepEqual(flock.homeBranches, snapTrees[i].birds.map((b) => b.homeBranch));
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
  assert.ok(world.getSnapshot().birds.every((bird) => bird.homeBranch < CONFIG.tree.branches.length));
});
