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
  assert.ok(masters.every((e) => e.source === 'rule-fallback'), '无 key 时 master 全部兜底来源');
  // 和弦仍按进行顺走（master 兜底 = 顺走 + 季节钟）：F(1天)→C(2天)→G(3天)
  assert.equal(masters[masters.length - 1].chord.id, 'G');
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
  assert.equal(conductor.getChord().id, 'G'); // 第 3 天 = spring[2]
});

test('假 master 决策：跳步改变和声游标并标注来源', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(33) });
  const masters = [];
  let calls = 0;
  const pipeline = createAgentPipeline({
    flockScheduler: async () => null,
    masterDecide: async () => {
      calls += 1;
      return { advanceStep: false, jumpToStep: 2, reason: '假 master：跳一步' };
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
  advanceTo(world, 3, 0.1); // 黎明：master 跳步 → spring[2] = G
  await flush();
  const day3 = masters.filter((e) => e.day === 3);
  assert.equal(day3.length, 1);
  assert.equal(day3[0].source, 'llm');
  assert.equal(day3[0].decision.jumpToStep, 2);
  assert.equal(conductor.getChord().id, 'G');
  assert.ok(calls >= 1);
});

test('transportFromPhase：相位 → 小节.拍（4 小节 4/4）', () => {
  assert.deepEqual(transportFromPhase(0, CONFIG.tempo), { bar: 1, beat: 1 });
  assert.deepEqual(transportFromPhase(0.25, CONFIG.tempo), { bar: 2, beat: 1 });
  assert.deepEqual(transportFromPhase(0.5, CONFIG.tempo), { bar: 3, beat: 1 });
  assert.deepEqual(transportFromPhase(0.99, CONFIG.tempo), { bar: 4, beat: 4 });
  assert.deepEqual(transportFromPhase(1.0, CONFIG.tempo), { bar: 1, beat: 1 }); // 归零回卷
});

test('换季链路：季节钟到期，master 兜底顺走也能入夏', async () => {
  const world = createWorld({ config: CONFIG, rng: mulberry32(55) });
  const conductor = attachPipelineConductor(world, {
    config: CONFIG,
    pipeline: nullPipeline(),
    rng: mulberry32(6),
  });
  advanceTo(world, 5, 0.1); // 第 5 天 = 入夏（seasonDays=4）
  await flush();
  const chord = conductor.getChord();
  assert.equal(chord.season, 'summer');
  assert.equal(chord.id, 'Csus4');
});
