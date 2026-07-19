import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentPipeline } from '../src/llm/integration.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function snapshot(day = 4) {
  return {
    day,
    flockSnapshot: { day, flocks: [{ species: 'pad' }] },
    masterInput: { menu: {}, state: { currentStep: 1 }, observations: {} },
  };
}

const flockPlan = (tag = 4) => ({
  flocks: [{ dwellBeats: tag, activeBars: 2, holdLoops: 4, mutations: [] }],
});

test('计划在黎明前就绪时，两条链同步领取 LLM 结果', async () => {
  let clock = 100;
  const pipeline = createAgentPipeline({
    flockScheduler: { requestDayPlan: async () => flockPlan() },
    masterDecide: async () => ({ advanceStep: true, reason: 'ready' }),
    masterFallback: () => ({ advanceStep: true, reason: 'fallback' }),
    now: () => clock++,
  });
  await pipeline.dayReview(snapshot());
  const plan = pipeline.dawnPlan();
  assert.deepEqual(plan.flock, { plan: flockPlan(), source: 'llm', fallback: false });
  assert.deepEqual(plan.master, {
    decision: { advanceStep: true, reason: 'ready' }, source: 'llm', fallback: false,
  });
  assert.deepEqual(plan.fallback, { flock: false, master: false });
});

test('未就绪先返回规则标记，错过黎明的响应延后到下一天', async () => {
  const flock = deferred();
  const master = deferred();
  const pipeline = createAgentPipeline({
    flockScheduler: { requestDayPlan: () => flock.promise },
    masterDecide: () => master.promise,
    masterFallback: () => ({ advanceStep: true, reason: '同步兜底' }),
    now: () => 10,
  });
  const review = pipeline.dayReview(snapshot());
  const firstDawn = pipeline.dawnPlan();
  assert.deepEqual(firstDawn.fallback, { flock: true, master: true });
  assert.equal(firstDawn.flock.plan, null);
  assert.equal(firstDawn.master.decision.reason, '同步兜底');

  flock.resolve(flockPlan(6));
  master.resolve({ advanceStep: false, reason: '迟到但保留' });
  await review;
  const nextDawn = pipeline.dawnPlan();
  assert.deepEqual(nextDawn.fallback, { flock: false, master: false });
  assert.deepEqual(nextDawn.flock.plan, flockPlan(6));
  assert.equal(nextDawn.master.decision.reason, '迟到但保留');
});

test('flock 失败不影响 master 结果', async () => {
  const pipeline = createAgentPipeline({
    flockScheduler: { requestDayPlan: async () => null },
    masterDecide: async () => ({ advanceStep: true, reason: 'master 正常' }),
    masterFallback: () => ({ advanceStep: false, reason: 'master fallback' }),
  });
  await pipeline.dayReview(snapshot());
  const plan = pipeline.dawnPlan();
  assert.equal(plan.flock.fallback, true);
  assert.equal(plan.master.fallback, false);
  assert.equal(plan.master.decision.reason, 'master 正常');
});

test('master 异常不影响 flock 结果，并同步调用 masterFallback', async () => {
  const pipeline = createAgentPipeline({
    flockScheduler: { requestDayPlan: async () => flockPlan(2) },
    masterDecide: async () => { throw new Error('offline'); },
    masterFallback: (input) => ({ advanceStep: true, reason: `fallback-step-${input.state.currentStep}` }),
  });
  await pipeline.dayReview(snapshot());
  const plan = pipeline.dawnPlan();
  assert.equal(plan.flock.fallback, false);
  assert.equal(plan.master.fallback, true);
  assert.equal(plan.master.decision.reason, 'fallback-step-1');
});

test('flock 计划数量与输入 flock 数不符时整包判 null 走兜底', async () => {
  const pipeline = createAgentPipeline({
    flockScheduler: {
      // 输入只有 1 个 flock，调度器却回了 2 个：半套/错位计划必须整体丢弃。
      requestDayPlan: async () => ({
        flocks: [
          { dwellBeats: 4, activeBars: 2, holdLoops: 4, mutations: [] },
          { dwellBeats: 2, activeBars: 2, holdLoops: 4, mutations: [] },
        ],
      }),
    },
    masterDecide: async () => ({ advanceStep: true, reason: 'master 正常' }),
    masterFallback: () => ({ advanceStep: true, reason: 'fallback' }),
  });
  const review = await pipeline.dayReview(snapshot());
  assert.equal(review.flock, null);
  const plan = pipeline.dawnPlan();
  assert.equal(plan.flock.fallback, true);
  assert.equal(plan.flock.plan, null);
  assert.equal(plan.master.fallback, false);
});

test('masterDecide 返回 {decision, source} 形状时来源标签穿透', async () => {
  const decision = { advanceStep: false, jumpToStep: 2, reason: '外部跳步' };
  const pipeline = createAgentPipeline({
    flockScheduler: { requestDayPlan: async () => flockPlan() },
    masterDecide: async () => ({ decision, source: 'external' }),
    masterFallback: () => ({ advanceStep: true, reason: 'fallback' }),
  });
  await pipeline.dayReview(snapshot());
  const plan = pipeline.dawnPlan();
  assert.deepEqual(plan.master, { decision, source: 'external', fallback: false });
});

test('流水线只透传音乐单位契约，旧秒字段缺少新字段时标记 flock 回落', async () => {
  const pipeline = createAgentPipeline({
    flockScheduler: {
      requestDayPlan: async () => ({ flocks: [{ dwellSeconds: 3, activeSeconds: 8, holdDays: 4 }] }),
    },
    masterDecide: async () => ({ advanceStep: true, reason: 'master 正常' }),
    masterFallback: () => ({ advanceStep: true, reason: 'fallback' }),
  });
  await pipeline.dayReview(snapshot());
  const plan = pipeline.dawnPlan();
  assert.equal(plan.flock.fallback, true);
  assert.equal(plan.master.fallback, false);
});
