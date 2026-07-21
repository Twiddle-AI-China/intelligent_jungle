import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BirdAgentClient,
  FLOCK_PLAN_SCHEMA,
  FLOCK_MAX_TOKENS,
  MASTER_DECISION_SCHEMA,
  MASTER_MAX_TOKENS,
  buildMasterDecisionSchema,
  clampStructuredReasons,
  parseStructuredContent,
} from '../src/llm/openai-client.js';
import { chainProviders, normalizeEcologySnapshot } from '../src/llm/client.js';

const BASE = 'http://192.168.9.140:8081';

const flockSnapshot = {
  day: 3,
  flocks: [
    { species: 'pad', energy: 0.6, tension: 0.3, skeletonBranchIds: [0, 1], colorBranchIds: [2, 3], notes: [53, 57] },
    { species: 'melody', energy: 0.8, tension: 0.3, skeletonBranchIds: [0, 1], colorBranchIds: [2, 3] },
  ],
};

const masterInput = {
  menu: {
    seasons: ['spring', 'summer'],
    colorsBySeason: { spring: ['clear', 'mist'], summer: ['humid'] },
    seasonLengthRange: [8, 16],
    tensionRange: [0.2, 0.6],
  },
  state: { season: 'spring', seasonDay: 11, seasonLength: 12, currentColorId: 'clear' },
  observations: { treeScores: [0.7], harmonyScores: [0.9] },
};

function jsonResponse(payload) {
  return {
    ok: true,
    async json() {
      return { choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }] };
    },
  };
}

const flockPlanPayload = {
  flocks: [
    { reason: '密度偏低需要稳住格局', dwellBeats: 6, activeBars: 3, holdLoops: 4, mutations: [], cellMutations: [] },
    { reason: '换枝偏疯压一压活性', dwellBeats: 1.5, activeBars: 2, holdLoops: 4, mutations: [{ from: 0, to: 1 }], cellMutations: [] },
  ],
  master: { ops: [] },
};

test('flock 请求体：json_schema 结构化、reason 首位带 pattern、模型与采样参数固定', async () => {
  const calls = [];
  const client = new BirdAgentClient({
    baseUrl: BASE,
    fetchImpl: async (...args) => { calls.push(args); return jsonResponse(flockPlanPayload); },
  });
  const plan = await client.requestDayPlan(flockSnapshot);
  assert.ok(plan);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `${BASE}/v1/chat/completions`);
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.model, 'bird_agent');
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, FLOCK_MAX_TOKENS);
  assert.equal(body.max_tokens, 512, '正常最坏约 316 token，512 留安全余量且限制空白 runaway');
  assert.equal(body.response_format.type, 'json_schema');
  assert.deepEqual(body.response_format.json_schema, FLOCK_PLAN_SCHEMA);
  const itemProps = Object.keys(FLOCK_PLAN_SCHEMA.schema.properties.flocks.items.properties);
  assert.equal(itemProps[0], 'reason', '自由文本字段必须放 properties 首位（mini-CoT）');
  assert.ok(FLOCK_PLAN_SCHEMA.schema.properties.flocks.items.properties.reason.pattern);
  assert.ok(!JSON.stringify(FLOCK_PLAN_SCHEMA).includes('maxLength'), '限长走 pattern 不用 maxLength');
  assert.deepEqual(
    FLOCK_PLAN_SCHEMA.schema.properties.flocks.items.required,
    ['reason', 'dwellBeats', 'activeBars', 'holdLoops', 'mutations', 'cellMutations'],
  );
  // 泄漏契约：flock 输入走 normalizeEcologySnapshot 白名单，音高键不进请求体。
  const user = JSON.parse(body.messages[1].content);
  assert.equal(user.flocks[0].tension, 0.3);
  assert.deepEqual(user.flocks[0].dwellPreferenceBeats, { lo: 8 });
  assert.deepEqual(user.flocks[1].dwellPreferenceBeats, { lo: 0.5, hi: 2 });
  assert.deepEqual(user.flocks[0].skeletonBranchIds, [0, 1]);
  assert.deepEqual(user.flocks[0].flags, {
    dwellLow: false, dwellHigh: false,
    branchChangesLow: false, branchChangesHigh: false,
    onsetCountLow: false, onsetCountHigh: false,
    intervalRegularityLow: false,
    clusterLow: false, clusterHigh: false,
    tensionHigh: false, tensionLow: true,
  });
  assert.ok(!JSON.stringify(user).includes('"notes"'), '音高字段不得进入 bird_agent 请求');
  assert.deepEqual(plan.flocks[1].mutations, [{ from: 0, to: 1 }], '输出仍过 normalizeWorldPlan');
});

test('master 请求体：当季 colorId / 合法季节 nextSeason 动态收紧为 enum', async () => {
  const calls = [];
  const client = new BirdAgentClient({
    baseUrl: BASE,
    fetchImpl: async (...args) => { calls.push(args); return jsonResponse({
      reason: '季末日换湿润气候', colorId: 'mist', tension: 0.6, nextSeason: 'summer', seasonLength: 10,
    }); },
  });
  const decision = await client.requestDecision(masterInput);
  assert.deepEqual(decision, {
    colorId: 'mist', tension: 0.6, nextSeason: 'summer', seasonLength: 10, reason: '季末日换湿润气候',
  });
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.max_tokens, MASTER_MAX_TOKENS);
  assert.equal(body.max_tokens, 512, 'master 与 flock 共用经实测收敛后的 512 token 预算');
  const requestSchema = body.response_format.json_schema;
  assert.deepEqual(requestSchema.schema.properties.colorId, {
    type: 'string', enum: ['clear', 'mist'],
  });
  assert.deepEqual(requestSchema.schema.properties.tension, {
    type: 'number', minimum: 0.2, maximum: 0.6,
  });
  assert.deepEqual(requestSchema.schema.properties.nextSeason.anyOf, [
    { type: 'string', enum: ['spring', 'summer'] }, { type: 'null' },
  ]);
  assert.match(body.messages[0].content, /仅 seasonFinal=true/);
  assert.match(body.messages[0].content, /seasonFinal=false 时二者都输出 null/);
  assert.match(body.messages[0].content, /不要自行比较 seasonDay 与 seasonLength/);
  const user = JSON.parse(body.messages[1].content);
  assert.equal(user.flags.seasonFinal, true, '季末判断由调用方预计算，不交给模型比较');
  const props = requestSchema.schema.properties;
  assert.equal(Object.keys(props)[0], 'reason');
  assert.deepEqual(props.nextSeason.anyOf, [
    { type: 'string', enum: ['spring', 'summer'] }, { type: 'null' },
  ]);
  assert.deepEqual(props.seasonLength.anyOf, [{ type: 'integer' }, { type: 'null' }]);
  assert.deepEqual(requestSchema.schema.required, ['reason', 'colorId', 'tension', 'nextSeason', 'seasonLength']);
});

test('master schema 的 colorId enum 随当季变化，缺菜单逐字段回退自由 string', () => {
  const spring = buildMasterDecisionSchema({
    menu: masterInput.menu,
    state: { season: 'spring' },
  });
  const summer = buildMasterDecisionSchema({
    menu: masterInput.menu,
    state: { season: 'summer' },
  });
  assert.deepEqual(spring.schema.properties.colorId.enum, ['clear', 'mist']);
  assert.deepEqual(summer.schema.properties.colorId.enum, ['humid']);
  assert.deepEqual(spring.schema.properties.nextSeason.anyOf[0].enum, ['spring', 'summer']);
  assert.equal(MASTER_DECISION_SCHEMA.schema.properties.colorId.enum, undefined,
    '静态 fallback schema 不得被动态构造污染');

  const missingColors = buildMasterDecisionSchema({ menu: { seasons: ['spring'] }, state: { season: 'spring' } });
  assert.deepEqual(missingColors.schema.properties.colorId, { type: 'string' });
  assert.deepEqual(missingColors.schema.properties.nextSeason.anyOf[0], {
    type: 'string', enum: ['spring'],
  });
  const missingAll = buildMasterDecisionSchema({});
  assert.deepEqual(missingAll.schema.properties.colorId, { type: 'string' });
  assert.deepEqual(missingAll.schema.properties.nextSeason.anyOf[0], { type: 'string' });
  assert.deepEqual(missingAll.schema.properties.tension, { type: 'number', minimum: 0, maximum: 1 },
    '旧菜单缺 tensionRange 时保持 0..1 兼容范围');
  assert.ok(!JSON.stringify(missingAll).includes('"enum":[]'));
});

test('可读 scheduler 预算时输出预计耗时诊断', async () => {
  const logs = [];
  const originalDebug = console.debug;
  console.debug = (...args) => { logs.push(args); };
  try {
    const client = new BirdAgentClient({
      baseUrl: BASE,
      fetchImpl: async () => jsonResponse(flockPlanPayload),
    });
    await client.requestDayPlan(flockSnapshot, { schedulerBudgetMs: 3500 });
  } finally {
    console.debug = originalDebug;
  }
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'bird_agent request timing');
  assert.deepEqual(logs[0][1], {
    schema: 'flock_day_plan',
    maxTokens: 512,
    estimatedWorstMs: 12800, // 512@40tok/s≈12.8s（guided decoding 正常会提前结束）
    schedulerBudgetMs: 12000,
    withinBudget: false,
  });
});

test('服务端忽略 reason pattern 时后验截到 30 字，不丢弃完整 flock/master 决策', async () => {
  const verbose = '这是一段明显超过三十个中文字的冗长生态解释用于模拟服务端未执行字符串模式约束但数值决策完整';
  const flockPayload = structuredClone(flockPlanPayload);
  flockPayload.flocks[0].reason = verbose;
  const flockClient = new BirdAgentClient({
    baseUrl: BASE,
    retryDelayMs: 0,
    fetchImpl: async () => jsonResponse(flockPayload),
  });
  assert.ok(await flockClient.requestDayPlan(flockSnapshot), '长 reason 不应让 flock 整包回落 null');

  const masterClient = new BirdAgentClient({
    baseUrl: BASE,
    retryDelayMs: 0,
    fetchImpl: async () => jsonResponse({
      reason: verbose,
      colorId: 'mist',
      tension: 0.4,
      nextSeason: null,
      seasonLength: null,
    }),
  });
  const decision = await masterClient.requestDecision({
    ...masterInput,
    state: { ...masterInput.state, seasonDay: 3 },
  });
  assert.equal(Array.from(decision.reason).length, 30);
  assert.equal(decision.reason, Array.from(verbose).slice(0, 30).join(''));

  const raw = { flocks: [{ reason: verbose }] };
  clampStructuredReasons(raw, FLOCK_PLAN_SCHEMA);
  assert.equal(Array.from(raw.flocks[0].reason).length, 30, 'flock 自由文本也执行同一后验');
});

test('master 输出仍过 normalizeMasterDecision：菜单外 colorId 判 null 并沿用上次决策', async () => {
  const responses = [
    { reason: '明暗呼吸稳一手', colorId: 'mist', tension: 0.4, nextSeason: null, seasonLength: null },
    { reason: '发明一个色彩档', colorId: 'neon', tension: 0.4, nextSeason: null, seasonLength: null },
  ];
  let index = 0;
  const client = new BirdAgentClient({ baseUrl: BASE, retryDelayMs: 0, fetchImpl: async () => jsonResponse(responses[index++]) });
  const good = await client.requestDecision({ ...masterInput, state: { ...masterInput.state, seasonDay: 3 } });
  assert.equal(good.colorId, 'mist');
  const bad = await client.requestDecision({ ...masterInput, state: { ...masterInput.state, seasonDay: 3 } });
  assert.equal(bad.colorId, 'mist', '非法输出回落上次有效决策');
});

test('parseStructuredContent 剥离 think 前缀与截断 think', () => {
  assert.deepEqual(parseStructuredContent('<think>推理中…</think>{"a":1}'), { a: 1 });
  assert.deepEqual(parseStructuredContent('<think>未闭合推理 {"a":1}'), null, '截断 think 后无 JSON 即 null');
  assert.deepEqual(parseStructuredContent('前缀 {"b":2} 尾'), { b: 2 });
  assert.equal(parseStructuredContent('not json'), null);
  assert.equal(parseStructuredContent(null), null);
});

test('parseStructuredContent 救回尾部空白 runaway 与缺失闭合符', async () => {
  const truncated = `${JSON.stringify({
    reason: '所有开关为假温和轮转',
    colorId: 'mist',
    tension: 0.35,
    nextSeason: null,
    seasonLength: null,
  }).slice(0, -1)}${' \n'.repeat(200)}`;
  assert.deepEqual(parseStructuredContent(truncated), {
    reason: '所有开关为假温和轮转',
    colorId: 'mist',
    tension: 0.35,
    nextSeason: null,
    seasonLength: null,
  });
  assert.deepEqual(
    parseStructuredContent('```json\n{"reason":"短句跑路'),
    { reason: '短句跑路' },
    '未闭合普通字符串与对象可只补引号/括号',
  );

  const client = new BirdAgentClient({
    baseUrl: BASE,
    retryDelayMs: 0,
    fetchImpl: async () => jsonResponse(truncated),
  });
  const decision = await client.requestDecision({
    ...masterInput,
    state: { ...masterInput.state, seasonDay: 3 },
  });
  assert.deepEqual(decision, {
    colorId: 'mist', tension: 0.35, reason: '所有开关为假温和轮转',
  }, 'salvage 后完整决策仍须通过既有 normalize 才采用');
});

test('salvage 不猜半个值，且补全后仍走 normalize 校验', async () => {
  assert.equal(parseStructuredContent('{"reason":"完整","tension":0.'), null, '半个数值不得误救');
  assert.equal(parseStructuredContent('{"reason":"完整","nextSeason":tru'), null, '半个 literal 不得误救');

  const invalidTruncated = `${JSON.stringify({
    reason: '菜单外色彩不能采用',
    colorId: 'neon',
    tension: 0.4,
    nextSeason: null,
    seasonLength: null,
  }).slice(0, -1)}   `;
  let calls = 0;
  const client = new BirdAgentClient({
    baseUrl: BASE,
    retryDelayMs: 0,
    fetchImpl: async () => { calls += 1; return jsonResponse(invalidTruncated); },
  });
  const decision = await client.requestDecision({
    ...masterInput,
    state: { ...masterInput.state, seasonDay: 3 },
  });
  assert.equal(decision, null, '语法补全成功也不得绕过菜单/schema normalize');
  assert.equal(calls, 1, '语法已补全时不因后续业务校验失败而重复请求');

  const missingFields = new BirdAgentClient({
    baseUrl: BASE,
    retryDelayMs: 0,
    fetchImpl: async () => jsonResponse('{"reason":"字段残缺不可采用","colorId":"mist"   '),
  });
  assert.equal(await missingFields.requestDecision({
    ...masterInput,
    state: { ...masterInput.state, seasonDay: 3 },
  }), null, '仅补结构不能补造缺失字段');
});

test('健康检查：非 200 或异常即离线', async () => {
  const ok = new BirdAgentClient({ baseUrl: BASE, fetchImpl: async () => ({ ok: true }) });
  assert.equal(await ok.checkHealth(), true);
  const bad = new BirdAgentClient({ baseUrl: BASE, fetchImpl: async () => ({ ok: false }) });
  assert.equal(await bad.checkHealth(), false);
  const down = new BirdAgentClient({ baseUrl: BASE, fetchImpl: async () => { throw new Error('refused'); } });
  assert.equal(await down.checkHealth(), false);
});

test('失败退避重试一次；重试也失败则沿用上次 flock 决策', async () => {
  let calls = 0;
  const flaky = new BirdAgentClient({
    baseUrl: BASE,
    retryDelayMs: 0,
    fetchImpl: async () => { calls += 1; return jsonResponse(flockPlanPayload); },
  });
  await flaky.requestDayPlan(flockSnapshot);
  assert.equal(calls, 1, '首次成功不重试');

  let failures = 0;
  const failing = new BirdAgentClient({
    baseUrl: BASE,
    retryDelayMs: 0,
    fetchImpl: async () => { failures += 1; throw new Error('offline'); },
  });
  failing.lastFlockPlan = { flocks: [{ dwellBeats: 4, activeBars: 2, holdLoops: 4, mutations: [] }], master: { ops: [] } };
  const reused = await failing.requestDayPlan(flockSnapshot);
  assert.equal(failures, 2, '恰好重试一次');
  assert.deepEqual(reused, failing.lastFlockPlan, '沿用上次决策兜底');
});

test('chainProviders：bird 失败落 MiniMax，顺序即优先级', async () => {
  const order = [];
  const bird = { requestDayPlan: async () => { order.push('bird'); return null; } };
  const minimax = { requestDayPlan: async () => { order.push('minimax'); return { flocks: [] }; } };
  const chain = chainProviders(bird, minimax);
  assert.deepEqual(await chain.requestDayPlan({}), { flocks: [] });
  assert.deepEqual(order, ['bird', 'minimax']);

  const masterChain = chainProviders(
    { requestDecision: async () => null },
    { requestDecision: async () => ({ colorId: 'clear', tension: 0.5, reason: '规则占位' }) },
  );
  assert.equal((await masterChain.requestDecision({})).colorId, 'clear');
  // 全灭 → null（调用方走规则兜底）
  assert.equal(await chainProviders({ requestDayPlan: async () => { throw new Error('x'); } }).requestDayPlan({}), null);
});

test('this 敏感的 fetch（浏览器原生）不抛 Illegal invocation', async () => {
  function strictFetch(...args) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation');
    }
    return Promise.resolve(jsonResponse(flockPlanPayload));
  }
  const client = new BirdAgentClient({ baseUrl: BASE, retryDelayMs: 0, fetchImpl: strictFetch });
  assert.ok(await client.checkHealth(), 'checkHealth 亦经脱敏包装');
  const plan = await client.requestDayPlan(flockSnapshot);
  assert.ok(plan, '实例方法调用 fetchImpl 不得携带 client 作为 this');
});

test('健康检查 3s 上限：挂起/慢响应都按时 resolve false，绝不阻塞启动（T19 回归）', async () => {
  // 永不 resolve 的 fetch（vLLM 重启期接 socket 不应答的场景）
  const hanging = new BirdAgentClient({
    baseUrl: BASE,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  const t0 = Date.now();
  assert.equal(await hanging.checkHealth({ timeoutMs: 50 }), false);
  assert.ok(Date.now() - t0 < 1000, '挂起的健康检查必须在超时预算内返回');

  // 慢响应（超过预算才 200）
  const slow = new BirdAgentClient({
    baseUrl: BASE,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true }), 200);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
    }),
  });
  assert.equal(await slow.checkHealth({ timeoutMs: 50 }), false);
  // 默认预算 3s 内正常 200 仍判在线
  assert.equal(await slow.checkHealth(), true);
});

test('e2e：agent 根级生态投影 → normalizeEcologySnapshot → HTTP 含四字段且无 notes/midi（T24 P0/P1）', async () => {
  // 模拟 agent.flockInput 真实产出：四字段平铺根级（无 harmonicFrame 嵌套），并掺音高脏键。
  const agentShaped = {
    day: 5,
    dayPhase: 'dawn',
    season: 'spring',
    tension: 0.55,
    skeletonBranchIds: [0, 1, 2],
    colorBranchIds: [3, 4],
    colorId: 'clear',
    notes: [53, 57, 60],
    midi: 60,
    flocks: [
      {
        species: 'pad',
        energy: 0.6,
        perchFlyRatio: 0.7,
        homeBranches: [0, 1],
        treeCondition: { health: 0.8, notes: [60] },
        dailyStats: { switches: 1 },
        notes: [53],
        midi: 53,
      },
      {
        species: 'melody',
        energy: 0.8,
        perchFlyRatio: 0.3,
        homeBranches: [2],
        treeCondition: { health: 0.5 },
        dailyStats: { switches: 3 },
      },
    ],
  };

  const normalized = normalizeEcologySnapshot(agentShaped);
  assert.equal(Object.hasOwn(normalized, 'harmonicFrame'), false);
  assert.equal(normalized.flocks[0].tension, 0.55);
  assert.deepEqual(normalized.flocks[0].skeletonBranchIds, [0, 1, 2]);
  assert.deepEqual(normalized.flocks[0].colorBranchIds, [3, 4]);
  assert.equal(normalized.flocks[0].colorId, 'clear');
  assert.equal(normalized.flocks[1].tension, 0.55, '根级投影应兜底到每个 flock');
  assert.equal(normalized.flocks[1].colorId, 'clear');

  // 嵌套 harmonicFrame 不得被白名单读出（契约：平铺根级，不兼容旧嵌套）。
  const nestedOnly = normalizeEcologySnapshot({
    day: 1,
    flocks: [{ species: 'pad', energy: 0.5, perchFlyRatio: 0.5 }],
    harmonicFrame: {
      tension: 0.9,
      skeletonBranchIds: [0, 1],
      colorBranchIds: [2, 3],
      colorId: 'mist',
    },
  });
  for (const key of ['tension', 'skeletonBranchIds', 'colorBranchIds', 'colorId']) {
    assert.equal(Object.hasOwn(nestedOnly.flocks[0], key), false, `嵌套 harmonicFrame.${key} 不得泄漏进 normalize`);
  }

  const calls = [];
  const client = new BirdAgentClient({
    baseUrl: BASE,
    fetchImpl: async (...args) => { calls.push(args); return jsonResponse(flockPlanPayload); },
  });
  await client.requestDayPlan(agentShaped);
  const body = JSON.parse(calls[0][1].body);
  const user = JSON.parse(body.messages[1].content);
  // 请求体样例契约：每 flock 含四字段，无 notes/midi。
  for (const flock of user.flocks) {
    assert.equal(flock.tension, 0.55);
    assert.deepEqual(flock.skeletonBranchIds, [0, 1, 2]);
    assert.deepEqual(flock.colorBranchIds, [3, 4]);
    assert.equal(flock.colorId, 'clear');
  }
  const raw = JSON.stringify(user);
  for (const key of ['notes', 'midi', 'harmonicFrame']) {
    assert.ok(!raw.includes(`"${key}"`), `HTTP 用户消息不得含 ${key}`);
  }
});
