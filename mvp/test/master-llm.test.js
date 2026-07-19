import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASTER_SYSTEM_PROMPT, MasterLlmClient, normalizeMasterInput } from '../src/master/llm-master.js';

// 新契约输入形态（harmony-season-redesign §3）
const input = {
  menu: {
    seasons: ['spring', 'summer'],
    colorsBySeason: { spring: ['clear', 'mist'], summer: ['humid'] },
    seasonLengthRange: [8, 16],
  },
  state: { season: 'spring', seasonDay: 11, seasonLength: 12, currentColorId: 'clear' },
  observations: {
    treeScores: [0.7, 0.8],
    harmonyScores: [0.92, 0.41],
    patternSimilarity: 0.4,
  },
};

function responseWith(content, extra = {}) {
  return {
    ok: true,
    async json() {
      return {
        base_resp: { status_code: 0 },
        choices: [{ message: { content } }],
        ...extra,
      };
    },
  };
}

test('一次请求返回严格的新菜单 master 决策（季末日换季）', async () => {
  const calls = [];
  const client = new MasterLlmClient({
    apiKey: 'injected-key',
    fetchImpl: async (...args) => {
      calls.push(args);
      return responseWith('```json\n{"colorId":"mist","tension":0.8,"nextSeason":"summer","seasonLength":10,"reason":"季末日换湿润气候"}\n```');
    },
  });
  assert.deepEqual(await client.requestDecision(input), {
    colorId: 'mist',
    tension: 0.8,
    nextSeason: 'summer',
    seasonLength: 10,
    reason: '季末日换湿润气候',
  });
  assert.equal(calls.length, 1);
  const request = JSON.parse(calls[0][1].body);
  assert.equal(request.response_format, undefined);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer injected-key');
  const userInput = JSON.parse(request.messages[1].content);
  assert.deepEqual(userInput.menu.colorsBySeason.spring, ['clear', 'mist']);
  assert.deepEqual(userInput.observations.harmonyScores, [0.92, 0.41], 'H 透传给模型');
  assert.equal(userInput.observations.meanDwell, undefined, 'master 聚合不透传秒制字段');
});

test('prompt 解释新契约：季=固定骨架、色彩档+张力、季末日才换季', () => {
  assert.match(MASTER_SYSTEM_PROMPT, /和声骨架/);
  assert.match(MASTER_SYSTEM_PROMPT, /colorId.*当季.*colors|当季 colors/);
  assert.match(MASTER_SYSTEM_PROMPT, /tension.*张力|张力预算/);
  assert.match(MASTER_SYSTEM_PROMPT, /seasonLengthRange/);
  assert.match(MASTER_SYSTEM_PROMPT, /harmonyScores/);
  assert.match(MASTER_SYSTEM_PROMPT, /只输出一行 JSON/);
  assert.doesNotMatch(MASTER_SYSTEM_PROMPT, /秒/);
  assert.doesNotMatch(MASTER_SYSTEM_PROMPT, /和弦|音符|旋律|music|chord|note/i);
});

test('normalizeMasterInput 宽容读旧字段名并归一菜单', () => {
  const normalized = normalizeMasterInput({
    menu: { seasonPalettes: { spring: ['base'] }, seasonLengthRange: [2, 8] },
    state: { currentSeason: 'spring', daysInSeason: 3 },
    observations: { treeScores: [0.5], harmonyScore: [0.7] },
  });
  assert.deepEqual(normalized.menu, {
    seasons: ['spring'],
    colorsBySeason: { spring: ['base'] },
    seasonLengthRange: [2, 8],
  });
  assert.deepEqual(normalized.state, {
    season: 'spring', seasonDay: 3, seasonLength: null, currentColorId: null,
  });
  assert.deepEqual(normalized.observations.harmonyScores, [0.7]);
});

test('treeScores 与 harmonyScores 仅在上游提供时进入输入摘要', async () => {
  const userInputs = [];
  const client = new MasterLlmClient({
    apiKey: 'key',
    fetchImpl: async (_url, options) => {
      userInputs.push(JSON.parse(JSON.parse(options.body).messages[1].content));
      return responseWith('{"colorId":"mist","tension":0.3,"reason":"平稳"}');
    },
  });
  await client.requestDecision(input);
  await client.requestDecision({ ...input, observations: { patternSimilarity: 0.4 } });
  assert.deepEqual(userInputs[0].observations.treeScores, [0.7, 0.8]);
  assert.deepEqual(userInputs[0].observations.harmonyScores, [0.92, 0.41]);
  assert.equal(Object.hasOwn(userInputs[1].observations, 'treeScores'), false);
  assert.equal(Object.hasOwn(userInputs[1].observations, 'harmonyScores'), false);
});

test('拒绝菜单外色彩、越界张力、非季末日换季与旧形状', async () => {
  const responses = [
    '{"colorId":"neon","tension":0.3,"reason":"发明色彩"}',
    '{"colorId":"mist","tension":2,"reason":"张力越界"}',
    '{"colorId":"mist","tension":0.3,"nextSeason":"summer","seasonLength":99,"reason":"季长越界"}',
    '{"advanceStep":true,"reason":"旧形状"}',
  ];
  let index = 0;
  const client = new MasterLlmClient({
    apiKey: 'key',
    fetchImpl: async () => responseWith(responses[index++]),
  });
  for (const ignored of responses) assert.equal(await client.requestDecision(input), null);
});

test('非季末日的合法换季提议也被拒（state 非季末）', async () => {
  const client = new MasterLlmClient({
    apiKey: 'key',
    fetchImpl: async () => responseWith('{"colorId":"mist","tension":0.3,"nextSeason":"summer","seasonLength":12,"reason":"没到期"}'),
  });
  const notFinal = { ...input, state: { ...input.state, seasonDay: 3 } };
  assert.equal(await client.requestDecision(notFinal), null);
});

test('网络、HTTP、业务与解析失败都返回 null，交给 policy 回落', async () => {
  const outcomes = [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false }),
    async () => responseWith('{}', { base_resp: { status_code: 1001 } }),
    async () => responseWith('not-json'),
  ];
  for (const fetchImpl of outcomes) {
    const client = new MasterLlmClient({ apiKey: 'key', fetchImpl });
    assert.equal(await client.requestDecision(input), null);
  }
});

test('this 敏感的 fetch（浏览器原生）不抛 Illegal invocation', async () => {
  function strictFetch(...args) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation');
    }
    return Promise.resolve(responseWith('{"colorId":"mist","tension":0.3,"reason":"明暗呼吸"}'));
  }
  const client = new MasterLlmClient({ apiKey: 'key', fetchImpl: strictFetch });
  const decision = await client.requestDecision(input);
  assert.ok(decision, '实例方法调用 fetchImpl 不得携带 client 作为 this');
});
