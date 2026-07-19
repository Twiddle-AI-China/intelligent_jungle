// mvp/test/harmony-frame.test.js —— T6 和声内核重构（docs/harmony-season-redesign.md）：
// a) 换季才迁移：季内色彩档日变不迁移家枝，季末日仅 bass 聚集（rally），换季日才大迁移
// b) 色彩档只动色彩枝：季内骨架枝音三日不动，色彩枝随档轮转
// c) 和谐分 H：权重计算、bass 全骨架 = 1、dayReview/masterInput 挂观测
// d) bass 预告：季末日（seasonDay == seasonLength-1）聚集到最低允许枝
// e) frame 输入位：上游 colorId/tension 优先，缺省规则兜底（轮转 + 张力爬升）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world.js';
import { attachPipelineConductor, harmonyScoreFromCounts } from '../src/agent.js';
import { CONFIG } from '../src/config.js';
import { mulberry32, advanceTo } from './helpers.js';

const CFG_L3 = { ...CONFIG, harmony: { ...CONFIG.harmony, defaultSeasonLength: 3 } };
const CFG_L2 = { ...CONFIG, harmony: { ...CONFIG.harmony, defaultSeasonLength: 2 } };

function stubPipeline(decision = null) {
  return {
    dawnPlan: () => ({
      reviewedDay: null,
      flock: { plan: null, fallback: true },
      master: decision ? { decision, source: 'llm', fallback: false } : { decision: null, source: 'rule-fallback', fallback: true },
    }),
    dayReview: () => {},
  };
}

test('a) 换季才迁移：季内零迁移，季末日仅 bass rally，换季日才大迁移', () => {
  const world = createWorld({ config: CFG_L3, rng: mulberry32(7) });
  const applies = [];
  attachPipelineConductor(world, {
    config: CFG_L3,
    rng: mulberry32(8),
    onApply: (e) => applies.push(e),
    // 健康分走平稳轮转基线，避免单日低分把色彩档钉死在 currentColorId
    ecologyProvider: () => ({ score: 0.7 }),
  });

  advanceTo(world, 2, 0.02); // 第 2 天：季内，色彩档轮转
  advanceTo(world, 3, 0.02); // 第 3 天：季末日
  advanceTo(world, 4, 0.02); // 第 4 天：入夏（换季日）

  const day2 = applies.find((e) => e.day === 2);
  const day3 = applies.find((e) => e.day === 3);
  const day4 = applies.find((e) => e.day === 4);
  assert.equal(day2.migrations.length, 0, '季内色彩档日变不得迁移家枝');
  assert.ok(day3.migrations.length > 0 && day3.migrations.every((m) => m.rally === true && m.treeId === 'bass'),
    '季末日只允许 bass 聚集预告');
  assert.ok(day4.migrations.some((m) => !m.rally), '换季日才做 voice-leading 大迁移');
  assert.notEqual(day2.nextChord.id, 'F·本色', '季内中日相对开局轮转色彩档');
  // 季末日决策保留 currentColorId（只挂换季预告），不强制再轮转
  assert.equal(day3.nextChord.id, day2.nextChord.id, '季末日保持当日色彩档');
  assert.equal(day2.nextChord.season, day3.nextChord.season, '季内骨架不动');
  assert.equal(day4.nextChord.season, 'summer');
});

test('b) 色彩档只动色彩枝：骨架枝音季内不动，色彩枝随档日变', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(12) });
  const conductor = attachPipelineConductor(world, {
    config: CONFIG,
    rng: mulberry32(13),
    ecologyProvider: () => ({ score: 0.7 }),
  });
  const k = CONFIG.harmony.skeletonBranches;
  const days = [1, 2, 3].map((day) => {
    advanceTo(world, day, 0.02);
    return conductor.getChord();
  });
  for (let i = 1; i < days.length; i += 1) {
    assert.deepEqual(days[i].notes.slice(0, k), days[0].notes.slice(0, k), '骨架枝整季不动');
    assert.notDeepEqual(days[i].notes.slice(k), days[i - 1].notes.slice(k), '色彩枝每日换档');
  }
});

test('c) 和谐分 H：权重加权，bass 全骨架枝 = 1，无发音 = null', () => {
  // 纯函数：骨架 1.0 / 色彩 0.7 / 框架外 0
  assert.equal(harmonyScoreFromCounts({ skeleton: 2, color: 2, outside: 1 }), (2 + 1.4) / 5);
  assert.equal(harmonyScoreFromCounts({ skeleton: 1, color: 0, outside: 0 }), 1);
  assert.equal(harmonyScoreFromCounts({ skeleton: 0, color: 0, outside: 0 }), null);

  const world = createWorld({ config: CONFIG, rng: mulberry32(3) });
  const conductor = attachPipelineConductor(world, { config: CONFIG, rng: mulberry32(4) });
  advanceTo(world, 1, 0.5); // 第 1 天正午：settle 窗口已过，各树已有落枝发音
  const scores = conductor.getHarmonyScores();
  assert.ok(scores.bass.perchSeconds > 0, 'bass 应有发音秒（长驻在鸣也计入）');
  assert.equal(scores.bass.harmonyScore, 1, 'bass 只栖骨架枝 → H = 1');
  for (const tree of CONFIG.trees) {
    const s = scores[tree.id];
    if (s.perchSeconds > 0) {
      assert.ok(s.harmonyScore > 0 && s.harmonyScore <= 1, `${tree.id} H ∈ (0,1]`);
    }
  }
});

test('c2) dayReview 与 masterInput 挂和谐分观测与生态投影四字段（无音高泄漏）', () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(41) });
  const reviews = [];
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
  });
  advanceTo(world, 2, 0.02);
  assert.equal(reviews.length, 1);
  const snap = reviews[0].flockSnapshot;
  // 生态投影平铺根级（勿嵌 harmonicFrame）：枝 id + 张力 + colorId；MIDI 不得进 LLM 快照
  assert.equal(Object.hasOwn(snap, 'harmonicFrame'), false, 'flock 链不得出现 harmonicFrame 键');
  for (const key of ['tension', 'skeletonBranchIds', 'colorBranchIds', 'colorId']) {
    assert.ok(Object.hasOwn(snap, key), `dayReview flockSnapshot 根级应携带 ${key}`);
  }
  const k = CONFIG.harmony.skeletonBranches;
  assert.deepEqual(snap.skeletonBranchIds, Array.from({ length: k }, (_, i) => i));
  assert.deepEqual(snap.colorBranchIds, Array.from(
    { length: CONFIG.tree.branches.length - k }, (_, i) => k + i,
  ));
  assert.ok(Number.isFinite(snap.tension));
  assert.ok(CONFIG.harmony.bySeason.spring.colors.some((c) => c.id === snap.colorId));
  const snapshotJson = JSON.stringify(snap);
  assert.ok(!snapshotJson.includes('"notes"'), 'flockSnapshot 不得携带任何音高数组');
  for (const flock of snap.flocks) {
    assert.ok('harmonyScore' in flock, '每个 flock 携带 harmonyScore 观测位');
  }
  assert.equal(reviews[0].masterInput.observations.harmonyScores.length, CONFIG.trees.length);
  // master 菜单兼容位为中性 id（和弦名不进菜单）
  assert.deepEqual(reviews[0].masterInput.menu.progressions, CONFIG.harmony.seasons.map((s) => [s]));
});

test('d) bass 预告：季末日聚集到最低允许枝，次日黎明领迁移', () => {
  const world = createWorld({ config: CFG_L2, rng: () => 0.999 });
  const conductor = attachPipelineConductor(world, { config: CFG_L2, rng: () => 0.999 });
  advanceTo(world, 2, 0.02); // 第 2 天 = 季末日（seasonDay 1 == seasonLength-1）
  const frame = conductor.getFrame();
  assert.equal(frame.seasonDay, frame.seasonLength - 1, '应处于季末日');
  const bass = world.getSnapshot().trees.find((t) => t.id === 'bass');
  assert.ok(bass.birds.every((b) => b.homeBranch === 0), 'bass 季末日应全部聚集到最低允许枝');
  advanceTo(world, 3, 0.02); // 次日黎明：换季生效
  assert.equal(conductor.getChord().season, 'summer');
});

test('e) frame 输入位：上游 colorId/tension 优先，缺省规则兜底', () => {
  // 上游给 colorId 不给 tension：色彩档用上游，张力走规则爬升
  const world = createWorld({ config: CONFIG, rng: mulberry32(21) });
  const conductor = attachPipelineConductor(world, {
    config: CONFIG,
    pipeline: stubPipeline({ colorId: '九度', reason: '上游指定色彩档' }),
  });
  advanceTo(world, 2, 0.02);
  const frame = conductor.getFrame();
  assert.equal(frame.color.id, '九度', '上游 colorId 落入当季风盘');
  const expected = CONFIG.harmony.tensionBase
    + (CONFIG.harmony.tensionPeak - CONFIG.harmony.tensionBase) * (1 / (frame.seasonLength - 1));
  assert.ok(Math.abs(frame.tension - expected) < 1e-9, 'tension 缺省时按季节进度爬升');

  // 上游 colorId 不在当季风盘 → 规则轮转兜底
  const world2 = createWorld({ config: CONFIG, rng: mulberry32(22) });
  const conductor2 = attachPipelineConductor(world2, {
    config: CONFIG,
    pipeline: stubPipeline({ colorId: '不存在的档', tension: 0.9, reason: '越菜单' }),
  });
  advanceTo(world2, 2, 0.02);
  const frame2 = conductor2.getFrame();
  const palette = CONFIG.harmony.bySeason.spring.colors.map((c) => c.id);
  assert.ok(palette.includes(frame2.color.id), '菜单外 colorId 回退轮转档');
  assert.equal(frame2.tension, 0.9, '上游合法 tension 优先');
});

test('e2) evaluator 钩子第二参为 { season, colorId }（不带和弦名/音高）', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(31) });
  const ctxs = [];
  attachPipelineConductor(world, {
    config: CONFIG,
    rng: mulberry32(32),
    evaluator: async (stats, ctx) => {
      ctxs.push(ctx);
      return Object.fromEntries(CONFIG.trees.map((t) => [t.id, {
        mutations: [], densityTier: 'normal', dwellBeats: CONFIG.species[t.species].dwellBeats,
        activeBars: 4, holdLoops: 4, reason: 'stub',
      }]));
    },
  });
  advanceTo(world, 2, 0.02);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctxs.length, 1);
  assert.deepEqual(Object.keys(ctxs[0]).sort(), ['colorId', 'season']);
  assert.equal(ctxs[0].season, 'spring');
  assert.ok(CONFIG.harmony.bySeason.spring.colors.some((c) => c.id === ctxs[0].colorId));
});
