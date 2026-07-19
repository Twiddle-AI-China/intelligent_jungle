// mvp/test/pipeline.test.js —— Phase 1.8 LLM 真实接线（mock，不用真实 key）：
// 无 key 纯规则运行、假 LLM flock 计划黎明生效、假 master 决策改和声游标、transport 折算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world.js';
import { attachPipelineConductor } from '../src/agent.js';
import { createAgentPipeline } from '../src/llm/integration.js';
import { decideMaster } from '../src/master/policy.js';
import { transportFromPhase } from '../src/harmony.js';
import { CONFIG } from '../src/config.js';
import { mulberry32, advanceTo } from './helpers.js';

function nullPipeline() {
  return createAgentPipeline({
    flockScheduler: async () => null,
    masterDecide: async () => null,
    masterFallback: (input) => decideMaster(input),
  });
}

const flush = () => new Promise((r) => { setTimeout(r, 5); });

test('无 key：纯规则运行——flock 规则计划 + master 兜底决策，来源标注规则层', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(9) });
  const events = [];
  attachPipelineConductor(world, {
    config: CONFIG,
    pipeline: nullPipeline(),
    rng: mulberry32(3),
    onApply: (e) => events.push({ kind: 'apply', ...e }),
    onMaster: (e) => events.push({ kind: 'master', ...e }),
  });
  advanceTo(world, 3, 0.1);
  await flush();
  const applies = events.filter((e) => e.kind === 'apply');
  const masters = events.filter((e) => e.kind === 'master');
  assert.ok(applies.length >= 2, '每个黎明一次生效');
  for (const a of applies) {
    for (const treeId of Object.keys(a.plans)) {
      assert.ok(/规则/.test(a.plans[treeId].source), `无 key 时 ${treeId} 应规则来源`);
    }
  }
  assert.ok(masters.length >= 2);
  assert.ok(masters.every((e) => e.source === 'policy'), '无 key 时 master 全部由 policy 兜底');
  // T6：季=单骨架——第 3 天仍在春季 F 骨架，色彩档每日轮转（档位由 master 兜底
  // 按最近一轮复盘状态选取，断言契约部分：骨架不动 + 档在风盘内）
  const lastChord = masters[masters.length - 1].chord;
  assert.equal(lastChord.season, 'spring');
  const [skeletonId, colorId] = lastChord.id.split('·');
  assert.equal(skeletonId, 'F');
  assert.ok(CONFIG.harmony.bySeason.spring.colors.some((c) => c.id === colorId), '色彩档须在当季风盘内');
});

test('LLM 空壳全灭时 policy 连续低分决策进入 buildFrame 与 master 日志', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(71) });
  const masters = [];
  const pipeline = createAgentPipeline({
    flockScheduler: async () => null,
    masterDecide: async () => ({ decision: null, source: null }),
    masterFallback: (input) => decideMaster(input),
  });
  attachPipelineConductor(world, {
    config: CONFIG,
    pipeline,
    rng: mulberry32(72),
    ecologyProvider: () => ({ score: 0.2 }),
    onMaster: (event) => masters.push(event),
  });

  advanceTo(world, 2, 0.02);
  await flush();
  advanceTo(world, 3, 0.02);
  await flush();
  advanceTo(world, 4, 0.02);
  await flush();

  const lowScore = masters.find((event) => /\u8fde续2日低分/.test(event.decision?.reason ?? ''));
  assert.ok(lowScore, 'master 日志路径应保留 policy 低分换档 reason');
  assert.equal(lowScore.source, 'policy');
  assert.equal(lowScore.frame.color.id, lowScore.decision.colorId, 'buildFrame 应消费 policy colorId');
  assert.equal(lowScore.frame.tension, lowScore.decision.tension, 'buildFrame 应消费 policy tension');
});

test('假 LLM flock 计划：白天复盘返回，下个黎明生效并标注 LLM', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(21) });
  const applies = [];
  // flocks[0] → pad 树（config.trees 顺序），契约 {dwellBeats, activeBars, holdLoops, mutations[]}。
  // 数量必须与 config.trees 一致：少于树数会被 mapFlockPlan 整包判 null（P1-3）。
  const llmPlan = {
    flocks: [{
      dwellBeats: 44,
      activeBars: 4,
      holdLoops: 4,
      mutations: [{ from: 0, to: 3 }],
    },
    { dwellBeats: 4, activeBars: 4, holdLoops: 4, mutations: [] },
    { dwellBeats: 4, activeBars: 4, holdLoops: 4, mutations: [] },
    { dwellBeats: 4, activeBars: 4, holdLoops: 4, mutations: [] }],
  };
  const pipeline = createAgentPipeline({
    flockScheduler: async () => llmPlan,
    masterDecide: async () => null, // master 走兜底
    masterFallback: (input) => decideMaster(input),
  });
  const conductor = attachPipelineConductor(world, {
    config: CONFIG,
    pipeline,
    rng: mulberry32(4),
    onApply: (e) => applies.push(e),
  });

  advanceTo(world, 2, 0.1); // 第 2 天黎明：复盘发起（LLM 立刻返回）
  await flush();
  advanceTo(world, 3, 0.1); // 第 3 天黎明：LLM 计划生效
  await flush();
  const day3 = applies.filter((e) => e.day === 3);
  assert.equal(day3.length, 1);
  assert.equal(day3[0].plans.pad.source, 'LLM');
  assert.equal(day3[0].plans.pad.plan.dwellBeats, 44, '契约字段 dwellBeats 透传');
  // mutations [{from:0,to:3}] 映射到 pad 树家枝在 0 的鸟 → 搬到 3
  const pad = world.getSnapshot().trees.find((t) => t.id === 'pad');
  assert.ok(pad.birds.some((b) => b.homeBranch === 3), 'pad 树应有鸟家枝迁到 3');
  // T6：第 3 天仍在春季 F 骨架（季=单和弦），色彩档在风盘内轮转
  const chord3 = conductor.getChord();
  assert.equal(chord3.season, 'spring');
  assert.ok(chord3.id.startsWith('F·'), '季内骨架不动');
  assert.ok(CONFIG.harmony.bySeason.spring.colors.some((c) => chord3.id.endsWith(c.id)), '色彩档须在风盘内');
});

test('假 master 决策：色彩档与张力进入 harmonicFrame 并标注来源', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(33) });
  const masters = [];
  let calls = 0;
  const pipeline = createAgentPipeline({
    flockScheduler: async () => null,
    masterDecide: async () => {
      calls += 1;
      return { colorId: '九度', tension: 0.8, reason: '假 master：高张力九度档' };
    },
    masterFallback: (input) => decideMaster(input),
  });
  const conductor = attachPipelineConductor(world, {
    config: CONFIG,
    pipeline,
    rng: mulberry32(5),
    onMaster: (e) => masters.push(e),
  });

  advanceTo(world, 2, 0.1); // 发起复盘
  await flush();
  advanceTo(world, 3, 0.1); // 黎明：master 色彩档/张力生效
  await flush();
  const day3 = masters.filter((e) => e.day === 3);
  assert.equal(day3.length, 1);
  assert.equal(day3[0].source, 'llm');
  assert.equal(day3[0].decision.colorId, '九度');
  assert.equal(conductor.getChord().id, 'F·九度', '上游 colorId 落入当季风盘');
  assert.equal(conductor.getFrame().tension, 0.8, '上游 tension 直接进入 frame');
  assert.ok(calls >= 1);
});

test('transportFromPhase：相位 → 小节.拍（4 小节 4/4）', () => {
  assert.deepEqual(transportFromPhase(0, CONFIG.tempo), { bar: 1, beat: 1 });
  assert.deepEqual(transportFromPhase(0.25, CONFIG.tempo), { bar: 2, beat: 1 });
  assert.deepEqual(transportFromPhase(0.5, CONFIG.tempo), { bar: 3, beat: 1 });
  assert.deepEqual(transportFromPhase(0.99, CONFIG.tempo), { bar: 4, beat: 4 });
  assert.deepEqual(transportFromPhase(1.0, CONFIG.tempo), { bar: 1, beat: 1 }); // 归零回卷
});

test('换季链路：季末日 master 兜底给预告，次日黎明入夏', async () => {
  // 缩短兜底季长让测试快进：第 4 天 = 季末日（兜底决策给 nextSeason=summer），第 5 天入夏
  const CFG = { ...CONFIG, harmony: { ...CONFIG.harmony, defaultSeasonLength: 4 } };
  const world = createWorld({ config: CFG, rng: mulberry32(55) });
  const conductor = attachPipelineConductor(world, {
    config: CFG,
    pipeline: nullPipeline(),
    rng: mulberry32(6),
  });
  advanceTo(world, 5, 0.1);
  await flush();
  const chord = conductor.getChord();
  assert.equal(chord.season, 'summer');
  assert.equal(chord.id, 'C·挂四'); // 夏季 C 骨架 · 风盘首档
  assert.equal(conductor.getFrame().seasonDay, 0, '入夏首日 seasonDay 归零');
});
