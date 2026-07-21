// mvp/test/harmony-frame.test.js —— T6 和声内核重构（docs/harmony-season-redesign.md）
// + Wave 2-A（T2.6/T4.11）：平稳期同档保持；季末日色彩轮转解冻。
// a) 换季才迁移：季内平稳不换色不迁移；季末日 bass rally + 色彩解冻；换季日大迁移
// b) 色彩档只动色彩枝：季内骨架枝音不动；平稳期色彩枝保持，非每日换档
// c) 和谐分 H：权重计算、bass 全骨架 = 1、dayReview/masterInput 挂观测
// d) bass 预告：季末日（seasonDay == seasonLength-1）聚集到最低允许枝
// e) frame 输入位：上游 colorId/tension 优先，缺省规则兜底（保持当前色 + 张力爬升）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world.js';
import { attachPipelineConductor, harmonyScoreFromCounts, masterMenuFromConfig } from '../src/agent.js';
import { CONFIG } from '../src/config.js';
import { colorOptions } from '../src/harmony.js';
import { mulberry32, advanceTo } from './helpers.js';

const CFG_L3 = { ...CONFIG, harmony: { ...CONFIG.harmony, defaultSeasonLength: 3 } };
const CFG_L2 = { ...CONFIG, harmony: { ...CONFIG.harmony, defaultSeasonLength: 2 } };

test('旧 config 缺 tensionRange 时 master 菜单兼容 0..1', () => {
  const legacyHarmony = { ...CONFIG.harmony };
  delete legacyHarmony.tensionRange;
  assert.deepEqual(masterMenuFromConfig({ ...CONFIG, harmony: legacyHarmony }).tensionRange, [0, 1]);
});

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

test('a) 每日和弦做 voice-leading，季末 bass rally，换季继续迁移', () => {
  const world = createWorld({ config: CFG_L3, rng: mulberry32(7) });
  const applies = [];
  attachPipelineConductor(world, {
    config: CFG_L3,
    rng: mulberry32(8),
    onApply: (e) => applies.push(e),
    // 健康分走平稳保持基线，避免单日低分抢跑
    ecologyProvider: () => ({ score: 0.7 }),
  });

  advanceTo(world, 2, 0.02); // 第 2 天：季内，平稳保持色彩档
  advanceTo(world, 3, 0.02); // 第 3 天：季末日（解冻轮转 + 换季预告）
  advanceTo(world, 4, 0.02); // 第 4 天：入夏（换季日）

  const day2 = applies.find((e) => e.day === 2);
  const day3 = applies.find((e) => e.day === 3);
  const day4 = applies.find((e) => e.day === 4);
  assert.ok(day2.migrations.some((m) => !m.rally), '日和弦改变应触发最近音级迁移');
  assert.ok(day3.migrations.some((m) => m.rally === true && m.treeId === 'bass'),
    '季末日 bass 聚集预告仍保留');
  assert.ok(day4.migrations.some((m) => !m.rally), '换季日才做 voice-leading 大迁移');
  assert.ok(day2.nextChord.id.startsWith('Gm·'), '第 2 日进入进行第二和弦');
  assert.notEqual(day3.nextChord.id, day2.nextChord.id, '季末日色彩轮转解冻');
  assert.equal(day2.nextChord.season, day3.nextChord.season, '季内骨架不动');
  assert.equal(day4.nextChord.season, 'summer');
});

test('b) 日间四和弦逐日推进，第 5 日回到第一步', () => {
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
  assert.equal(new Set(days.map((chord) => chord.id.split('·')[0])).size, 3);
  advanceTo(world, 5, 0.02);
  const later = conductor.getChord();
  assert.deepEqual(later.notes.slice(0, k), days[0].notes.slice(0, k), '第 5 日回到第一和弦骨架');
});

test('黄昏色彩只由 Master 显式决定，Master USER 不被自动改色', () => {
  const quietWorld = createWorld({ config: CONFIG, rng: mulberry32(101) });
  const quiet = attachPipelineConductor(quietWorld, {
    config: CONFIG,
    pipeline: stubPipeline({ colorId: '开放', tension: 0.3, duskColorShift: false, reason: '保持日内色彩' }),
  });
  advanceTo(quietWorld, 2, 0.02);
  const quietBefore = quiet.getChord().id;
  advanceTo(quietWorld, 2, 0.55);
  assert.equal(quiet.getChord().id, quietBefore, 'Master 选择 false 时黄昏保持当日色彩');
  assert.equal(quiet.getFrame().period, 'day');

  const shiftWorld = createWorld({ config: CONFIG, rng: mulberry32(102) });
  const shifted = attachPipelineConductor(shiftWorld, {
    config: CONFIG,
    pipeline: stubPipeline({ colorId: '开放', tension: 0.3, duskColorShift: true, reason: '需要日内对比' }),
  });
  advanceTo(shiftWorld, 2, 0.02);
  const shiftBefore = shifted.getChord().id;
  advanceTo(shiftWorld, 2, 0.55);
  assert.notEqual(shifted.getChord().id, shiftBefore, 'Master 选择 true 时才切夜间色彩');
  assert.equal(shifted.getFrame().period, 'night');
  advanceTo(shiftWorld, 3, 0.55);
  assert.equal(shifted.getFrame().period, 'day', '同一四日循环内第二次请求被硬门禁拦截');
  advanceTo(shiftWorld, 5, 0.55);
  assert.equal(shifted.getFrame().period, 'night', '进入下一四日循环且间隔满两天后可再次换色');

  const userWorld = createWorld({ config: CONFIG, rng: mulberry32(103) });
  const user = attachPipelineConductor(userWorld, {
    config: CONFIG,
    pipeline: stubPipeline({ colorId: '开放', tension: 0.3, duskColorShift: true, reason: '外部请求换色' }),
  });
  user.setMasterControl('USER');
  advanceTo(userWorld, 2, 0.02);
  const userBefore = user.getChord().id;
  advanceTo(userWorld, 2, 0.55);
  assert.equal(user.getChord().id, userBefore, 'Master USER 时黄昏不得自动改色');
});

test('c) 和谐分 H 保留原始语义：色彩=0.7、混合=0.85、骨架=1、无发音=null', () => {
  const weights = { skeleton: 1, color: 0.7, outside: 0 };
  assert.equal(harmonyScoreFromCounts({ skeleton: 0, color: 1, outside: 0 }, weights, 0.7), 0.7);
  assert.ok(Math.abs(harmonyScoreFromCounts(
    { skeleton: 1, color: 1, outside: 0 }, weights, 0.7,
  ) - 0.85) < 1e-12);
  assert.equal(harmonyScoreFromCounts({ skeleton: 1, color: 0, outside: 0 }, weights, 0.7), 1);
  assert.equal(harmonyScoreFromCounts({ skeleton: 0, color: 0, outside: 0 }, weights, 0.7), null);
  assert.ok(Math.abs(harmonyScoreFromCounts(
    { skeleton: 2, color: 2, outside: 1 }, weights, 0.7,
  ) - 0.68) < 1e-12, '框架外发音按 0 权重进入原始加权平均');

  const world = createWorld({ config: CONFIG, rng: mulberry32(3) });
  const conductor = attachPipelineConductor(world, { config: CONFIG, rng: mulberry32(4) });
  advanceTo(world, 1, 0.5); // 第 1 天正午：settle 窗口已过，各树已有落枝发音
  const scores = conductor.getHarmonyScores();
  assert.ok(scores.bass.perchSeconds > 0, 'bass 应有发音秒（长驻在鸣也计入）');
  assert.ok(scores.bass.harmonyScore >= 0.7 && scores.bass.harmonyScore <= 1,
    'bass 共用 0–4 音高枝，骨架/色彩均按原始 H 权重计入');
  for (const tree of CONFIG.trees) {
    const s = scores[tree.id];
    if (s.perchSeconds > 0) {
      assert.ok(s.harmonyScore >= 0 && s.harmonyScore <= 1, `${tree.id} H ∈ [0,1]`);
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
  assert.ok(colorOptions('spring').some((c) => c.id === snap.colorId));
  const snapshotJson = JSON.stringify(snap);
  assert.ok(!snapshotJson.includes('"notes"'), 'flockSnapshot 不得携带任何音高数组');
  for (const flock of snap.flocks) {
    assert.ok('harmonyScore' in flock, '每个 flock 携带 harmonyScore 观测位');
  }
  assert.equal(reviews[0].masterInput.observations.harmonyScores.length, CONFIG.trees.length);
  // master 菜单兼容位为中性 id（和弦名不进菜单）
  assert.deepEqual(reviews[0].masterInput.menu.progressions, CONFIG.harmony.seasons.map((s) => [s]));
  assert.deepEqual(reviews[0].masterInput.menu.tensionRange, CONFIG.harmony.tensionRange,
    '生产 master 菜单下发唯一张力范围');
});

test('d) bass 预告：季末日聚集到最低允许枝，次日黎明领迁移', () => {
  const world = createWorld({ config: CFG_L2, rng: () => 0.999 });
  const conductor = attachPipelineConductor(world, { config: CFG_L2, rng: () => 0.999 });
  advanceTo(world, 2, 0.02); // 第 2 天 = 季末日（seasonDay 1 == seasonLength-1）
  const frame = conductor.getFrame();
  assert.equal(frame.seasonDay, frame.seasonLength - 1, '应处于季末日');
  const bass = world.getSnapshot().trees.find((t) => t.id === 'bass');
  assert.ok(bass.birds.every((b) => b.homeBranch === Math.min(...(CFG_L2.species.bass.allowedBranches ?? [0]))),
    'bass 季末日应全部聚集到最低音高枝');
  advanceTo(world, 3, 0.02); // 次日黎明：换季生效
  assert.equal(conductor.getChord().season, 'summer');
});

test('e) frame 输入位：上游 colorId/tension 优先，缺省规则兜底', () => {
  // 上游给 colorId 不给 tension：色彩档用上游，张力走规则爬升
  const world = createWorld({ config: CONFIG, rng: mulberry32(21) });
  const conductor = attachPipelineConductor(world, {
    config: CONFIG,
    pipeline: stubPipeline({ colorId: '开放', reason: '上游指定色彩档' }),
  });
  advanceTo(world, 2, 0.02);
  const frame = conductor.getFrame();
  assert.equal(frame.color.id, '开放', '上游 colorId 落入当日风盘');
  const expected = CONFIG.harmony.tensionRange[0]
    + (CONFIG.harmony.tensionRange[1] - CONFIG.harmony.tensionRange[0]) * (1 / (frame.seasonLength - 1));
  assert.ok(Math.abs(frame.tension - expected) < 1e-9, 'tension 缺省时按季节进度爬升');

  // 上游 colorId 不在当季风盘 → 规则轮转兜底
  const world2 = createWorld({ config: CONFIG, rng: mulberry32(22) });
  const conductor2 = attachPipelineConductor(world2, {
    config: CONFIG,
    pipeline: stubPipeline({ colorId: '不存在的档', tension: 0.9, reason: '越菜单' }),
  });
  advanceTo(world2, 2, 0.02);
  const frame2 = conductor2.getFrame();
  const palette = colorOptions('spring', CONFIG.harmony, 1, 'day').map((c) => c.id);
  assert.ok(palette.includes(frame2.color.id), '菜单外 colorId 回退规则兜底档');
  assert.equal(frame2.tension, CONFIG.harmony.tensionRange[1], '上游 tension 夹到共享菜单上沿');
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
  assert.ok(colorOptions('spring').some((c) => c.id === ctxs[0].colorId));
});
