import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASTER_SYSTEM_PROMPT, MasterLlmClient } from '../src/master/llm-master.js';

const input = {
  menu: {
    progressions: [['a', 'b', 'c']],
    seasonPalettes: { spring: ['clear'], summer: ['humid'] },
    seasonLengthRange: [2, 8],
    cooldownDays: 2,
  },
  state: { currentSeason: 'spring', currentStep: 0, daysInSeason: 3, daysSinceChange: 3 },
  observations: {
    treeScores: [0.7, 0.8],
    patternSimilarity: 0.4,
    avgDwellBeats: [2, 8],
    activeBars: [3, 4],
    holdLoops: [4, 6],
    meanDwell: 22,
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

test('一次请求返回严格的菜单内 master 决策', async () => {
  const calls = [];
  const client = new MasterLlmClient({
    apiKey: 'injected-key',
    fetchImpl: async (...args) => {
      calls.push(args);
      return responseWith('```json\n{"advanceStep":false,"changeSeason":"summer","nextPalette":"humid","reason":"林地需要湿润新气候"}\n```');
    },
  });
  assert.deepEqual(await client.requestDecision(input), {
    advanceStep: false,
    changeSeason: 'summer',
    nextPalette: 'humid',
    reason: '林地需要湿润新气候',
  });
  assert.equal(calls.length, 1);
  const request = JSON.parse(calls[0][1].body);
  assert.equal(request.response_format, undefined);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer injected-key');
  assert.deepEqual(JSON.parse(request.messages[1].content).menu.paths, [['a', 'b', 'c']]);
  const aggregate = JSON.parse(request.messages[1].content).observations;
  assert.deepEqual(aggregate.avgDwellBeats, [2, 8]);
  assert.equal(aggregate.meanDwell, undefined, 'master 聚合不再透传秒制驻留字段');
});

test('prompt 采用季节天气生态语义并要求单行 JSON', () => {
  assert.match(MASTER_SYSTEM_PROMPT, /森林|季节|天气|繁荣/);
  assert.match(MASTER_SYSTEM_PROMPT, /只输出一行 JSON/);
  assert.match(MASTER_SYSTEM_PROMPT, /驻留拍数|活跃小节数|昼夜循环数/);
  assert.doesNotMatch(MASTER_SYSTEM_PROMPT, /秒/);
  assert.doesNotMatch(MASTER_SYSTEM_PROMPT, /和弦|音符|旋律|music|chord|note/i);
});

test('treeScores 仅在上游提供时进入 master 输入摘要', async () => {
  const userInputs = [];
  const client = new MasterLlmClient({
    apiKey: 'key',
    fetchImpl: async (_url, options) => {
      userInputs.push(JSON.parse(JSON.parse(options.body).messages[1].content));
      return responseWith('{"advanceStep":true,"reason":"树况平稳"}');
    },
  });
  await client.requestDecision(input);
  await client.requestDecision({
    ...input,
    observations: { patternSimilarity: 0.4, avgDwellBeats: 4 },
  });
  assert.deepEqual(userInputs[0].observations.treeScores, [0.7, 0.8]);
  assert.equal(Object.hasOwn(userInputs[1].observations, 'treeScores'), false);
});

test('拒绝菜单外季节、色彩、步骤以及同时改变两维', async () => {
  const responses = [
    '{"advanceStep":false,"changeSeason":"winter","nextPalette":"snow","reason":"发明"}',
    '{"advanceStep":false,"changeSeason":"summer","nextPalette":"desert","reason":"发明"}',
    '{"advanceStep":false,"jumpToStep":8,"reason":"越界"}',
    '{"advanceStep":true,"changeSeason":"summer","nextPalette":"humid","reason":"两维"}',
  ];
  let index = 0;
  const client = new MasterLlmClient({
    apiKey: 'key',
    fetchImpl: async () => responseWith(responses[index++]),
  });
  for (const ignored of responses) assert.equal(await client.requestDecision(input), null);
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
    return Promise.resolve(responseWith('{"advanceStep":true,"reason":"顺走一步保持流动"}'));
  }
  const client = new MasterLlmClient({ apiKey: 'key', fetchImpl: strictFetch });
  const decision = await client.requestDecision(input);
  assert.ok(decision, '实例方法调用 fetchImpl 不得携带 client 作为 this');
});
