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

test('dwell 基线：平均驻留偏短 → 上调并夹在边界内', () => {
  const short = evaluateDay(stats({ meanDwell: 5 }), assignments(), CFG, () => 0.999);
  assert.ok(short.dwellBaseline > 1);
  const long = evaluateDay(stats({ meanDwell: 200, dwellBaseline: 1 }), assignments(), CFG, () => 0.999);
  assert.ok(long.dwellBaseline < 1);
  assert.ok(long.dwellBaseline >= CFG.dwellBaselineMin && long.dwellBaseline <= CFG.dwellBaselineMax);
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
  assert.deepEqual(reviews[0].masterInput.observations.treeScores, [0.1, 0.2, 0.3, 0.4]);
  assert.ok(reviews[0].flockSnapshot.flocks.every((flock) => Number.isFinite(flock.dailyStats.meanDwellBeats)));
});

test('master 换季生效日触发 bass 成批迁移', () => {
  const world = createWorld({ config: CONFIG, rng: () => 0 });
  const before = world.getSnapshot().trees.find((tree) => tree.id === 'bass').birds
    .map((bird) => bird.homeBranch);
  const applies = [];
  attachPipelineConductor(world, {
    config: CONFIG,
    pipeline: {
      dawnPlan: () => ({
        reviewedDay: 1,
        flock: { plan: null, fallback: true },
        master: {
          decision: { advanceStep: false, changeSeason: 'summer', nextPalette: 'base', reason: '换季' },
          source: 'llm',
          fallback: false,
        },
      }),
      dayReview: () => {},
    },
    onApply: (event) => applies.push(event),
  });
  advanceTo(world, 2, 0.02);
  const after = world.getSnapshot().trees.find((tree) => tree.id === 'bass').birds
    .map((bird) => bird.homeBranch);
  assert.notDeepEqual(after, before);
  assert.ok(applies[0].migrations.some((move) => move.treeId === 'bass'));
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
