import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DayPlanScheduler, MIN_DAY_PLAN_TIMEOUT_MS } from '../src/llm/scheduler.js';
import { chainProviders } from '../src/llm/client.js';

const PLAN = { flocks: [{ dwellBeats: 4, activeBars: 2, holdLoops: 4, mutations: [] }] };

test('超时：即使 client 忽略 AbortSignal 也在期限后返回 null', async () => {
  const client = { requestDayPlan: () => new Promise(() => {}) };
  const scheduler = new DayPlanScheduler({ client, timeoutMs: 20, minTimeoutMs: 1 });
  const started = Date.now();
  assert.equal(await scheduler.requestDayPlan({ day: 1 }), null);
  assert.ok(Date.now() - started < 250, '不能被永不结束的 fetch 卡住');
  assert.equal(scheduler.getState().consecutiveFailures, 1);
});

test('重入：并发黄昏调用复用同一个 Promise，只请求一次', async () => {
  let calls = 0;
  let release;
  const client = {
    requestDayPlan: () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  };
  const scheduler = new DayPlanScheduler({ client, timeoutMs: 200, minTimeoutMs: 1 });
  const first = scheduler.requestDayPlan({ day: 2 });
  const second = scheduler.requestDayPlan({ day: 2 });
  assert.equal(first, second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  release(PLAN);
  assert.equal(await first, PLAN);
  assert.equal(scheduler.getState().consecutiveFailures, 0);
});

test('指数退避：前两次失败后分别等待 1/2 个昼夜', async () => {
  let calls = 0;
  const client = { requestDayPlan: async () => { calls += 1; return null; } };
  const scheduler = new DayPlanScheduler({ client, timeoutMs: 100, minTimeoutMs: 1, circuitFailureThreshold: 9 });

  assert.equal(await scheduler.requestDayPlan({ day: 1 }), null); // next=2
  assert.equal(await scheduler.requestDayPlan({ day: 1 }), null); // 同日退避，不请求
  assert.equal(calls, 1);
  assert.equal(await scheduler.requestDayPlan({ day: 2 }), null); // next=4
  assert.equal(await scheduler.requestDayPlan({ day: 3 }), null); // 仍退避
  assert.equal(calls, 2);
  assert.deepEqual(scheduler.getState(), {
    consecutiveFailures: 2,
    nextAllowedDay: 4,
    circuitOpenUntilDay: 0,
    inFlight: false,
  });
});

test('断路器：连续 3 次失败后冷却 5 昼夜，半开成功后清零', async () => {
  const outcomes = [null, null, null, PLAN];
  let calls = 0;
  const client = { requestDayPlan: async () => outcomes[calls++] };
  const scheduler = new DayPlanScheduler({ client, timeoutMs: 100, minTimeoutMs: 1 });

  await scheduler.requestDayPlan({ day: 1 });
  await scheduler.requestDayPlan({ day: 2 });
  await scheduler.requestDayPlan({ day: 4 }); // 第三败：open until day 9
  assert.equal(calls, 3);
  assert.equal(scheduler.getState().circuitOpenUntilDay, 9);
  assert.equal(await scheduler.requestDayPlan({ day: 8 }), null);
  assert.equal(calls, 3, '冷却期不应调用 client');

  assert.equal(await scheduler.requestDayPlan({ day: 9 }), PLAN);
  assert.equal(calls, 4);
  assert.deepEqual(scheduler.getState(), {
    consecutiveFailures: 0,
    nextAllowedDay: 9,
    circuitOpenUntilDay: 0,
    inFlight: false,
  });
});

test('provider 链：bird 耗时失败后 MiniMax 成功仍产出计划，不计断路失败', async () => {
  const calls = [];
  const client = chainProviders(
    { async requestDayPlan() {
      calls.push('bird');
      await new Promise((resolve) => setTimeout(resolve, 60));
      return null;
    } },
    { async requestDayPlan() {
      calls.push('minimax');
      await new Promise((resolve) => setTimeout(resolve, 40));
      return PLAN;
    } },
  );
  // 按 1:100 缩时复现 6s + 4s；请求的 8s 预算被调度器下限抬到 12s。
  const scheduler = new DayPlanScheduler({ client, timeoutMs: 80, minTimeoutMs: 120 });
  assert.equal(scheduler.timeoutMs, 120);
  assert.equal(await scheduler.requestDayPlan({ day: 1 }), PLAN);
  assert.deepEqual(calls, ['bird', 'minimax']);
  assert.equal(scheduler.getState().consecutiveFailures, 0);
  assert.equal(scheduler.getState().circuitOpenUntilDay, 0);

  scheduler.timeoutMs = 80;
  assert.equal(scheduler.timeoutMs, 120, 'BPM 变更后的运行期赋值也必须遵守下限');
  assert.equal(MIN_DAY_PLAN_TIMEOUT_MS, 12000);
});
