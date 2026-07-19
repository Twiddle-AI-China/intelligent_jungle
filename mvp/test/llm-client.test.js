import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MINIMAX_SYSTEM_PROMPT,
  MinimaxClient,
  buildFlockFlags,
  extractFirstJsonObject,
  normalizeEcologySnapshot,
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

test('flock 输入携带物种驻留偏好带，prompt 只要求按方向选择并 clamp', () => {
  assert.match(MINIMAX_SYSTEM_PROMPT, /dwellLow=true.*提高 dwellBeats/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /dwellHigh=true.*降低 dwellBeats/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /clamp 到 menu\.dwellBeats/);
  const normalized = normalizeEcologySnapshot({
    flocks: ['melody', 'pad', 'bass', 'texture'].map((species) => ({ species })),
  });
  assert.deepEqual(normalized.flocks.map((flock) => flock.dwellPreferenceBeats), [
    { lo: 0.5, hi: 2 }, { lo: 8 }, { lo: 16 }, { lo: 1, hi: 4 },
  ]);
});

test('activeBars 措辞与执行语义一致：自 0 起硬截断 + 全日静默', () => {
  assert.match(MINIMAX_SYSTEM_PROMPT, /自小节 0 起硬截断/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /与物种时段求交/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /0 表示全日静默/);
});

test('prompt 引导变异只读 flags，from 取自 homeBranches、示例非空', () => {
  assert.match(MINIMAX_SYSTEM_PROMPT, /branchChangesLow=true.*家枝变异/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /最多 menu\.maxMutations 条/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /from 必须来自 homeBranches/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /同一栖枝格局保持 2–8 个循环/);
  assert.doesNotMatch(MINIMAX_SYSTEM_PROMPT, /ecology\.deviation|非 within/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /"mutations":\[\{"from":0,"to":1\}\]/, '形状示例含一条非空变异');
});

test('flock 所有数值判断预计算为布尔 flags，prompt 每个开关都有动作规则', () => {
  const flags = buildFlockFlags({
    tension: 0.8,
    ecology: { deviation: {
      meanDwell: { direction: 'low' },
      branchChanges: { direction: 'high' },
      cohortSize: { direction: 'low' },
    } },
  });
  assert.deepEqual(flags, {
    dwellLow: true, dwellHigh: false,
    branchChangesLow: false, branchChangesHigh: true,
    clusterLow: true, clusterHigh: false,
    tensionHigh: true, tensionLow: false,
  });
  for (const name of Object.keys(flags)) {
    assert.match(MINIMAX_SYSTEM_PROMPT, new RegExp(`${name}=true`), `${name} 必须有显式映射`);
  }
  const inverse = buildFlockFlags({
    tension: 0.2,
    ecology: { deviation: {
      meanDwell: 'high', branchChanges: 'low', clusterSize: 'high',
    } },
  });
  assert.equal(inverse.dwellHigh, true);
  assert.equal(inverse.branchChangesLow, true);
  assert.equal(inverse.clusterHigh, true);
  assert.equal(inverse.tensionLow, true);
  assert.doesNotMatch(MINIMAX_SYSTEM_PROMPT, /偏好带.*(高于|低于)|张力(高|低)时/);
  assert.ok((MINIMAX_SYSTEM_PROMPT.match(/^\d+\)/gm) ?? []).length <= 8, '规则不得超过 8 条');
});

test('flock homeBranches 透传进请求，缺省时省略该字段', async () => {
  const userInputs = [];
  const client = new MinimaxClient({
    apiKey: 'key',
    fetchImpl: async (_url, options) => {
      userInputs.push(JSON.parse(JSON.parse(options.body).messages[1].content));
      return responseWith('{"flocks":[{"dwellBeats":4,"activeBars":2,"holdLoops":4,"mutations":[{"from":0,"to":3}]},{"dwellBeats":2,"activeBars":2,"holdLoops":4,"mutations":[]}],"master":{"ops":[]}}');
    },
  });
  const withHomes = structuredClone(snapshot);
  withHomes.flocks[0].homeBranches = [0, 0, 3, 4, 4];
  await client.requestDayPlan(withHomes);
  await client.requestDayPlan(snapshot);
  assert.deepEqual(userInputs[0].flocks[0].homeBranches, [0, 0, 3, 4, 4]);
  assert.equal(Object.hasOwn(userInputs[1].flocks[0], 'homeBranches'), false);
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

test('生态 frame 四字段透传：根级兜底、flock 级优先、非法项过滤', async () => {
  const userInputs = [];
  const client = new MinimaxClient({
    apiKey: 'key',
    fetchImpl: async (_url, options) => {
      userInputs.push(JSON.parse(JSON.parse(options.body).messages[1].content));
      return responseWith('{"flocks":[{"dwellBeats":4,"activeBars":2,"holdLoops":4,"mutations":[]},{"dwellBeats":2,"activeBars":2,"holdLoops":4,"mutations":[]}],"master":{"ops":[]}}');
    },
  });
  const framed = structuredClone(snapshot);
  framed.tension = 0.42;
  framed.skeletonBranchIds = [0, 1, 2];
  framed.colorBranchIds = [3, 4];
  framed.colorId = 'mist';
  // flock1 覆盖根级 tension（越界夹到 1）与枝集合（过滤负数/小数/非数）。
  framed.flocks[1].tension = 1.7;
  framed.flocks[1].skeletonBranchIds = [0, -1, 1.5, 'x', 2];
  await client.requestDayPlan(framed);
  await client.requestDayPlan(snapshot); // 无 frame 字段时全部省略

  const [a, b] = userInputs[0].flocks;
  assert.equal(a.tension, 0.42);
  assert.deepEqual(a.skeletonBranchIds, [0, 1, 2]);
  assert.deepEqual(a.colorBranchIds, [3, 4]);
  assert.equal(a.colorId, 'mist');
  assert.equal(b.tension, 1, 'flock 级越界张力夹到 [0,1]');
  assert.deepEqual(b.skeletonBranchIds, [0, 2], '枝 id 只收非负整数');
  for (const flock of userInputs[1].flocks) {
    assert.equal(Object.hasOwn(flock, 'tension'), false);
    assert.equal(Object.hasOwn(flock, 'skeletonBranchIds'), false);
    assert.equal(Object.hasOwn(flock, 'colorBranchIds'), false);
    assert.equal(Object.hasOwn(flock, 'colorId'), false);
  }
});

test('双保险：notes/root/midi/chord 键一律拒绝进请求体', async () => {
  let userInput = null;
  const client = new MinimaxClient({
    apiKey: 'key',
    fetchImpl: async (_url, options) => {
      userInput = JSON.parse(JSON.parse(options.body).messages[1].content);
      return responseWith('{"flocks":[{"dwellBeats":4,"activeBars":2,"holdLoops":4,"mutations":[]},{"dwellBeats":2,"activeBars":2,"holdLoops":4,"mutations":[]}],"master":{"ops":[]}}');
    },
  });
  const dirty = structuredClone(snapshot);
  dirty.flocks[0].notes = [53, 57, 60];
  dirty.flocks[0].root = 53;
  dirty.flocks[0].midi = 60;
  dirty.flocks[0].chord = 'F';
  dirty.flocks[0].treeCondition = { health: 0.8, notes: [60, 64], root: 53 };
  dirty.flocks[0].dailyStats = { switches: 1, midiNoteCount: 3 };
  dirty.notes = [1, 2, 3];
  await client.requestDayPlan(dirty);
  const body = JSON.stringify(userInput);
  for (const key of ['notes', 'root', 'midi', 'chord', 'midiNoteCount']) {
    assert.ok(!body.includes(`"${key}"`), `请求体不得出现 ${key}`);
  }
  assert.equal(userInput.flocks[0].treeCondition.health, 0.8, '生态键正常透传');
  assert.equal(userInput.flocks[0].dailyStats.switches, 1);
});

test('prompt：tension 与骨架/色彩枝集合含义 + 栖枝格局措辞', () => {
  assert.match(MINIMAX_SYSTEM_PROMPT, /骨架枝/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /色彩枝/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /张力/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /skeletonBranchIds/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /colorBranchIds/);
  assert.match(MINIMAX_SYSTEM_PROMPT, /同一栖枝格局保持/);
  assert.doesNotMatch(MINIMAX_SYSTEM_PROMPT, /乐句习性/);
});
