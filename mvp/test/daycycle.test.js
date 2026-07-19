// mvp/test/daycycle.test.js —— 日循环验收性质（Phase 1.9 双树版）：
// a) 循环继承（音高空间）：相邻两天 pattern 相似但非全同
// b) pad 平均驻留 ≫ melody 平均驻留（同一世界两棵树对照）
// c) 日内换枝次数不超过物种配额
// d) 评估流水线时序：第 N 天复盘第 N−1 天 → 第 N+1 天黎明生效（含规则兜底）
// e) holdLoops 乐句保持期：保持期内 melody 不变异，期满小变（邻枝优先、≤上限）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world.js';
import { attachPipelineConductor } from '../src/agent.js';
import { chordForDay } from '../src/harmony.js';
import { CONFIG } from '../src/config.js';
import { mulberry32, advanceTo } from './helpers.js';

// pad 树当日正午的栖枝 pattern 翻成音高：{birdId: midi}（仅栖着的活跃鸟）
function middayPatternMidi(world, day, treeId = 'pad') {
  const s = advanceTo(world, day, 0.25);
  const chord = chordForDay(day);
  const tree = s.trees.find((t) => t.id === treeId);
  return Object.fromEntries(
    tree.birds.filter((b) => b.state === 'perched' && b.activeToday)
      .map((b) => [b.id, chord.notes[b.branchId]]),
  );
}

function similarity(p1, p2) {
  const keys = Object.keys(p1).filter((k) => k in p2);
  if (!keys.length) return 0;
  const same = keys.filter((k) => Math.abs(p1[k] - p2[k]) <= 2).length;
  return same / keys.length;
}

function firstDawnStats(world) {
  return new Promise((resolve) => {
    world.on('dawn', (e) => resolve(e.stats)); // 第一个黎明即带第 1 天日终统计
    advanceTo(world, 2, 0.01);
  });
}

test('a) 循环继承（音高空间）：换和弦后相邻两天 pattern 平均相似 ≥0.5 且非全同', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(2024) });
  attachPipelineConductor(world, { config: CONFIG, rng: mulberry32(99) });

  const days = [1, 2, 3, 4].map((d) => middayPatternMidi(world, d));
  // normal 档按 pad 五鸟容量比例化为 3；归巢错落容许正午仍有 1 只在途。
  for (const p of days) assert.ok(Object.keys(p).length >= 2, '每天 pattern 应有比例化后的有效规模');
  const sims = [0, 1, 2].map((i) => similarity(days[i], days[i + 1]));
  const mean = sims.reduce((s, v) => s + v, 0) / sims.length;
  assert.ok(mean >= 0.5, `相邻三天平均音高相似度 ${mean.toFixed(2)} 应 ≥ 0.5（voice-leading 继承）`);
  assert.ok(Math.min(...sims) >= 0.3, `单日相似度不应崩塌（${sims.map((s) => s.toFixed(2))}）`);
  assert.notDeepEqual(days[0], days[1], '换和弦后 pattern 不应原样重播');
});

test('b) pad 平均驻留显著大于 melody（≥3 倍，同一世界两树对照）', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(11) });
  const stats = await firstDawnStats(world);
  const pad = stats.trees.pad;
  const melody = stats.trees.melody;
  assert.ok(pad.dwellSampleCount > 0 && melody.dwellSampleCount > 0, '两树都应有驻留样本');
  assert.ok(pad.meanDwell > melody.meanDwell * 3,
    `pad ${pad.meanDwell.toFixed(1)}s 应 ≥ 3× melody ${melody.meanDwell.toFixed(1)}s`);
});

test('c) 日内换枝次数不超过物种配额', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(5) });
  const stats = await firstDawnStats(world);
  assert.equal(stats.trees.pad.switches, 0, 'pad 配额 0：日内零换枝');
  for (const [birdId, n] of Object.entries(stats.trees.melody.perBirdSwitches)) {
    assert.ok(n <= CONFIG.species.melody.switchQuota,
      `鸟${birdId} 换枝 ${n} 次超过配额 ${CONFIG.species.melody.switchQuota}`);
  }
  assert.ok(stats.trees.melody.switches > 0, 'melody 应当确有换枝行为');
});

test('d) 流水线时序：第 N 天复盘第 N−1 天 → 第 N+1 天黎明生效；无就绪计划走兜底', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(31) });
  const events = [];
  const dayLength = CONFIG.tempo.barsPerDay * CONFIG.tempo.beatsPerBar * 60 / CONFIG.tempo.defaultBpm;
  const slowEvaluator = (stats) => new Promise((resolve) => {
    setTimeout(() => resolve({
      pad: { mutations: [], densityTier: 'normal', dwellBeats: 40, activeBars: 4, holdLoops: 4, reason: 'LLM pad' },
      melody: { mutations: [], densityTier: 'normal', dwellBeats: 1.2, activeBars: 4, holdLoops: 4, reason: 'LLM melody' },
    }), dayLength * 1000 * 0.6 / 100); // 测试环境压缩
  });
  attachPipelineConductor(world, {
    config: CONFIG,
    rng: mulberry32(77),
    evaluator: slowEvaluator,
    onApply: (e) => events.push(e),
  });

  advanceTo(world, 2, 0.02);
  await new Promise((r) => setTimeout(r, 10));
  const day2 = events.filter((e) => e.day === 2);
  assert.equal(day2.length, 1, '第 2 天黎明恰好一次生效');
  assert.match(day2[0].plans.pad.source, /兜底/, '无就绪计划时黎明走规则层即时兜底');

  await new Promise((r) => setTimeout(r, dayLength * 10 * 0.6 + 50));
  advanceTo(world, 3, 0.02);
  await new Promise((r) => setTimeout(r, 10));
  const day3 = events.filter((e) => e.day === 3);
  assert.equal(day3.length, 1);
  assert.equal(day3[0].plans.pad.source, 'LLM', '已就绪的最新计划在第 3 天黎明生效');
  assert.equal(day3[0].plans.melody.source, 'LLM');
  assert.equal(day3[0].plans.pad.reviewedDay, 1);
});

test('e) holdLoops：保持期内 melody 不变异，期满小变（邻枝优先、≤上限）', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(64) });
  const melodyBirds = world.getSnapshot().trees.find((t) => t.id === 'melody').birds.map((b) => b.id);
  const applies = [];
  // 每次评估都给 melody 三个变异（邻枝/跨枝/第三只），holdLoops=2
  const evaluator = async () => ({
    pad: { mutations: [], densityTier: 'normal', dwellBeats: 40, activeBars: 4, holdLoops: 4, reason: 'pad 保持' },
    melody: {
      mutations: [
        { birdId: melodyBirds[0], from: 0, to: 3 }, // 跨 3 枝（非邻枝）
        { birdId: melodyBirds[1], from: 1, to: 2 }, // 邻枝
        { birdId: melodyBirds[2], from: 2, to: 4 }, // 第三个（应被上限裁掉）
      ],
      densityTier: 'normal',
      dwellBeats: 1.2,
      activeBars: 4,
      holdLoops: 2,
      reason: 'melody 变异',
    },
  });
  const conductor = attachPipelineConductor(world, {
    config: CONFIG,
    rng: mulberry32(88),
    evaluator,
    onApply: (e) => applies.push(e),
  });

  for (const day of [2, 3, 4, 5, 6, 7, 8, 9]) {
    advanceTo(world, day, 0.02);
    await new Promise((r) => setTimeout(r, 5));
  }

  const melodyMutationsOf = (day) => applies.find((e) => e.day === day)?.plans.melody.plan.mutations ?? [];
  // 保持期（counter 0→4）：第 2–5 天 melody 全部不变异
  for (const day of [2, 3, 4, 5]) {
    assert.equal(melodyMutationsOf(day).length, 0, `第 ${day} 天应保持期内不变异`);
  }
  // 第 6 天期满：小变（≤上限、邻枝优先、 evaluator 给的 holdLoops=2 生效）
  const m6 = melodyMutationsOf(6);
  assert.ok(m6.length >= 1 && m6.length <= CONFIG.agent.holdMutationMax, `期满小变 ≤ ${CONFIG.agent.holdMutationMax}`);
  assert.ok(Math.abs(m6[0].to - m6[0].from) === 1, '期满小变邻枝优先');
  // 变异日不计入新周期：第 7–8 天恰好保持 H=2 个完整循环，第 9 天再期满。
  assert.equal(melodyMutationsOf(7).length, 0, '新保持期第 1 个完整循环不变异');
  assert.equal(melodyMutationsOf(8).length, 0, '新保持期第 2 个完整循环不变异');
  assert.ok(melodyMutationsOf(9).length >= 1, '保持恰好 H=2 个循环后才再次变异');
  assert.equal(conductor.getHoldState('melody').loops, 2, '期满采纳 evaluator 的 holdLoops=2');
});
