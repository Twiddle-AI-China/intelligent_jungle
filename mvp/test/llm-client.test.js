import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MINIMAX_SYSTEM_PROMPT,
  MinimaxClient,
  extractFirstJsonObject,
} from '../src/llm/client.js';

function responseWith(content, over = {}) {
  return {
    ok: true,
    async json() {
      return {
        base_resp: { status_code: 0 },
        choices: [{ message: { content } }],
        ...over,
      };
    },
  };
}

const snapshot = {
  day: 3,
  dayPhase: 'dusk',
  season: null,
  decisionMenu: {
    dwellBeats: [1, 8],
    activeBars: [1, 4],
    holdLoops: [2, 6],
    maxMutations: 2,
  },
  flocks: [
    { species: 'pad', energy: 0.3, perchFlyRatio: 0.75, treeCondition: { foliage: 0.8 }, dailyStats: { switches: 1, avgDwellBeats: 6, meanDwell: 20 } },
    { species: 'melody', energy: 0.9, perchFlyRatio: 0.25, treeCondition: { pest: 0.4 }, dailyStats: { switches: 5, avgDwellBeats: 1 } },
  ],
};

test('容错提取：跳过坏对象并解析代码围栏中的嵌套 JSON', () => {
  const parsed = extractFirstJsonObject('前缀 {bad json} ```json\n{"flocks":[{"reason":"含 { 括号 }"}],"master":{"ops":[]}}\n``` 尾缀');
  assert.equal(parsed.flocks[0].reason, '含 { 括号 }');
  assert.deepEqual(parsed.master, { ops: [] });
});

test('单次批量请求全部 flock，音乐单位 clamp 且清洗家枝变异建议', async () => {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return responseWith('结果：```json\n{"flocks":[{"dwellBeats":99,"activeBars":9,"holdLoops":4,"mutations":[{"from":4,"to":1},{"from":3,"to":0},{"from":2,"to":1}]},{"dwellBeats":0.1,"activeBars":-2,"holdLoops":6,"mutations":[]}],"master":{"ops":[]}}\n```');
  };
  const client = new MinimaxClient({ apiKey: 'injected-test-key', fetchImpl });
  const plan = await client.requestDayPlan(snapshot);

  assert.equal(calls.length, 1, '整个世界只能发一次请求');
  assert.equal(calls[0][0], 'https://api.minimaxi.com/v1/chat/completions');
  const request = JSON.parse(calls[0][1].body);
  assert.equal(request.response_format, undefined, 'MiniMax 不支持 response_format');
  const requestInput = JSON.parse(request.messages[1].content);
  assert.equal(requestInput.flocks.length, 2);
  assert.deepEqual(requestInput.flocks[0].menu.holdLoops, [2, 6]);
  assert.equal(requestInput.flocks[0].dailyStats.avgDwellBeats, 6);
  assert.equal(requestInput.flocks[0].dailyStats.meanDwell, undefined, '旧秒字段不再送入模型');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer injected-test-key');
  assert.deepEqual(plan, {
    flocks: [
      {
        dwellBeats: 8,
        activeBars: 4,
        holdLoops: 4,
        mutations: [{ from: 4, to: 1 }, { from: 3, to: 0 }],
      },
      { dwellBeats: 1, activeBars: 1, holdLoops: 6, mutations: [] },
    ],
    master: { ops: [] },
  });
});

test('prompt 只含生态词汇，并强制单行 JSON', () => {
  assert.doesNotMatch(MINIMAX_SYSTEM_PROMPT, /音乐|音符|旋律|和弦|music|note|chord|scale/i);
  assert.match(MINIMAX_SYSTEM_PROMPT, /驻留.*拍|活跃.*小节|习性.*昼夜/);
  assert.doesNotMatch(MINIMAX_SYSTEM_PROMPT, /秒/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /只输出一行 JSON/);
});

test('activeBars 措辞与执行语义一致：自 0 起硬截断 + 全日静默', () => {
  assert.match(MINIMAX_SYSTEM_PROMPT, /自小节 0 起硬截断/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /与物种时段求交/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /0 表示全日静默/);
});

test('dwell/active 发生 clamp 时 console.debug 留痕（字段、原值、夹后值）', async (t) => {
  const debug = t.mock.method(console, 'debug', () => {});
  const client = new MinimaxClient({
    apiKey: 'key',
    fetchImpl: async () => responseWith('{"flocks":[{"dwellBeats":99,"activeBars":-2,"holdLoops":4,"mutations":[]},{"dwellBeats":4,"activeBars":2,"holdLoops":4,"mutations":[]}],"master":{"ops":[]}}'),
  });
  const plan = await client.requestDayPlan(snapshot);
  assert.equal(plan.flocks[0].dwellBeats, 8); // menu.dwellBeats [1,8]
  assert.equal(plan.flocks[0].activeBars, 1); // menu.activeBars [1,4]
  const lines = debug.mock.calls.map((c) => c.arguments[0]);
  assert.equal(lines.length, 2, '只有被夹的 flock0 两个字段留痕，flock1 安静');
  assert.match(lines[0], /dwellBeats clamp 99 → 8/);
  assert.match(lines[1], /activeBars clamp -2 → 1/);
});

test('flock ecology 复盘按需注入，缺省时整段省略', async () => {
  const userInputs = [];
  const client = new MinimaxClient({
    apiKey: 'key',
    fetchImpl: async (_url, options) => {
      userInputs.push(JSON.parse(JSON.parse(options.body).messages[1].content));
      return responseWith('{"flocks":[{"dwellBeats":4,"activeBars":2,"holdLoops":4,"mutations":[]},{"dwellBeats":2,"activeBars":2,"holdLoops":4,"mutations":[]}],"master":{"ops":[]}}');
    },
  });
  const withEcology = structuredClone(snapshot);
  withEcology.flocks[0].ecology = {
    branchChangesPerLoop: 1.5,
    meanDwellBeats: 6,
    clusterSize: 3,
    score: 0.82,
    deviation: { branchChanges: { direction: 'low', amount: 0.5 } },
    ignored: 'nope',
  };

  await client.requestDayPlan(withEcology);
  await client.requestDayPlan(snapshot);
  assert.deepEqual(userInputs[0].flocks[0].ecology, {
    branchChangesPerLoop: 1.5,
    meanDwellBeats: 6,
    clusterSize: 3,
    score: 0.82,
    deviation: { branchChanges: { direction: 'low', amount: 0.5 } },
  });
  assert.equal(Object.hasOwn(userInputs[1].flocks[0], 'ecology'), false);
});

test('业务错误、数量不符、缺字段、菜单外 holdLoops 或无效 JSON 均返回 null', async () => {
  const contents = [
    responseWith('{}', { base_resp: { status_code: 1001 } }),
    responseWith('{"flocks":[],"master":{"ops":[]}}'),
    responseWith('{"flocks":[{"dwellBeats":4,"activeBars":2,"mutations":[]},{"dwellBeats":1,"activeBars":2,"holdLoops":4,"mutations":[]}],"master":{"ops":[]}}'),
    responseWith('{"flocks":[{"dwellBeats":4,"activeBars":2,"holdLoops":7,"mutations":[]},{"dwellBeats":1,"activeBars":2,"holdLoops":4,"mutations":[]}],"master":{"ops":[]}}'),
    responseWith('{"flocks":[{"dwellBeats":4,"activeBars":2,"holdLoops":4,"mutations":[]},{"dwellBeats":1,"activeBars":2,"holdLoops":4,"mutations":[]}],"master":{"ops":[{"op":"set_population"}]}}'),
    responseWith('not json'),
  ];
  let index = 0;
  const client = new MinimaxClient({ apiKey: 'key', fetchImpl: async () => contents[index++] });
  assert.equal(await client.requestDayPlan(snapshot), null);
  assert.equal(await client.requestDayPlan(snapshot), null);
  assert.equal(await client.requestDayPlan(snapshot), null);
  assert.equal(await client.requestDayPlan(snapshot), null);
  assert.equal(await client.requestDayPlan(snapshot), null);
  assert.equal(await client.requestDayPlan(snapshot), null);
});

test('旧秒制输出字段被忽略：新字段齐全时不透传，仅有旧字段时回落 null', async () => {
  const responses = [
    responseWith('{"flocks":[{"dwellBeats":4,"activeBars":2,"holdLoops":4,"mutations":[],"dwellSeconds":9,"dwellUrgeBias":1},{"dwellBeats":1,"activeBars":1,"holdLoops":3,"mutations":[],"meanDwell":7}],"master":{"ops":[]}}'),
    responseWith('{"flocks":[{"dwellSeconds":4,"activeSeconds":8,"homeSwapSuggestions":[]},{"dwellSeconds":2,"activeSeconds":4,"homeSwapSuggestions":[]}],"master":{"ops":[]}}'),
  ];
  let index = 0;
  const client = new MinimaxClient({ apiKey: 'key', fetchImpl: async () => responses[index++] });
  const plan = await client.requestDayPlan(snapshot);
  assert.deepEqual(plan.flocks[0], { dwellBeats: 4, activeBars: 2, holdLoops: 4, mutations: [] });
  assert.equal(plan.flocks[0].dwellSeconds, undefined);
  assert.equal(await client.requestDayPlan(snapshot), null);
});

test('this 敏感的 fetch（浏览器原生）不抛 Illegal invocation', async () => {
  // 模拟 Chrome 原生 fetch：以非 globalThis 的 this 调用即抛。
  function strictFetch(...args) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation');
    }
    return Promise.resolve(responseWith('{"flocks":[{"dwellBeats":2,"activeBars":2,"holdLoops":4,"mutations":[]},{"dwellBeats":1,"activeBars":1,"holdLoops":3,"mutations":[]}],"master":{"ops":[]}}'));
  }
  const client = new MinimaxClient({ apiKey: 'key', fetchImpl: strictFetch });
  const plan = await client.requestDayPlan(snapshot);
  assert.ok(plan, '实例方法调用 fetchImpl 不得携带 client 作为 this');
});
