import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExternalMaster,
  resolveMasterDecision,
  resolveMasterDecisionWithSource,
} from '../src/master/external-master.js';

const masterInput = {
  menu: {
    progressions: [['a', 'b', 'c']],
    seasonPalettes: { spring: ['clear', 'mist'], summer: ['humid'] },
    seasonLengthRange: [2, 8],
    cooldownDays: 2,
  },
  state: {
    currentSeason: 'spring',
    currentStep: 0,
    daysInSeason: 4,
    daysSinceChange: 3,
  },
  observations: { treeScores: [0.7, 0.8], patternSimilarity: 0.3 },
};

function responseWith(value) {
  return { ok: true, async json() { return value; } };
}

test('external master POST 成功并映射为既有菜单决策', async () => {
  const calls = [];
  const external = createExternalMaster({
    endpoint: 'https://master.example/decision',
    headers: { Authorization: 'Bearer injected' },
    timeoutMs: 100,
    fetchImpl: async (...args) => {
      calls.push(args);
      return responseWith({
        action: 'jumpToStep',
        params: { step: 2 },
        reason: '让树况重新均衡',
      });
    },
  });
  assert.deepEqual(await external.requestDecision(masterInput), {
    advanceStep: false,
    jumpToStep: 2,
    reason: '让树况重新均衡',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://master.example/decision');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer injected');
  const posted = JSON.parse(calls[0][1].body);
  assert.deepEqual(posted.menu.paths, masterInput.menu.progressions);
  assert.deepEqual(posted.observations.treeScores, [0.7, 0.8]);
});

test('external master 超时返回 null', async () => {
  const external = createExternalMaster({
    endpoint: 'https://master.example/decision',
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true });
    }),
  });
  assert.equal(await external.requestDecision(masterInput), null);
});

test('external master 坏 JSON、非法 action 和菜单外 params 均返回 null', async () => {
  const fetches = [
    async () => ({ ok: true, async json() { throw new SyntaxError('bad json'); } }),
    async () => responseWith({ action: 'inventWeather', params: {}, reason: '越权' }),
    async () => responseWith({ action: 'jumpToStep', params: { step: 99 }, reason: '越界' }),
  ];
  for (const fetchImpl of fetches) {
    const external = createExternalMaster({ endpoint: 'https://master.example', fetchImpl });
    assert.equal(await external.requestDecision(masterInput), null);
  }
});

test('未配置 endpoint 时直接返回 null 且不访问网络', async () => {
  let calls = 0;
  const external = createExternalMaster({ fetchImpl: async () => { calls += 1; } });
  assert.equal(await external.requestDecision(masterInput), null);
  assert.equal(calls, 0);
});

test('组合器按 external → llm → policy 顺序回落', async () => {
  const order = [];
  const llmDecision = { advanceStep: true, reason: '模型顺走' };
  assert.deepEqual(await resolveMasterDecision({
    external: async () => { order.push('external'); return null; },
    llm: async () => { order.push('llm'); return llmDecision; },
    policy: () => { order.push('policy'); return { advanceStep: true, reason: '规则顺走' }; },
  }, masterInput), llmDecision);
  assert.deepEqual(order, ['external', 'llm']);

  order.length = 0;
  const fallback = { advanceStep: true, reason: '规则顺走' };
  assert.deepEqual(await resolveMasterDecision({
    external: async () => { order.push('external'); throw new Error('offline'); },
    llm: async () => { order.push('llm'); return null; },
    policy: () => { order.push('policy'); return fallback; },
  }, masterInput), fallback);
  assert.deepEqual(order, ['external', 'llm', 'policy']);
});

test('resolveMasterDecisionWithSource 三源命中各自标签，全灭返回 null 源', async () => {
  const viaLlm = await resolveMasterDecisionWithSource({
    external: async () => null,
    llm: async () => ({ advanceStep: true, reason: '模型顺走' }),
    policy: () => ({ advanceStep: true, reason: '规则顺走' }),
  }, masterInput);
  assert.deepEqual(viaLlm, {
    decision: { advanceStep: true, reason: '模型顺走' },
    source: 'llm',
  });

  const viaExternal = await resolveMasterDecisionWithSource({
    external: async () => ({ advanceStep: true, reason: '外部顺走' }),
    llm: async () => ({ advanceStep: true, reason: '模型顺走' }),
  }, masterInput);
  assert.deepEqual(viaExternal, {
    decision: { advanceStep: true, reason: '外部顺走' },
    source: 'external',
  });

  const viaPolicy = await resolveMasterDecisionWithSource({
    external: async () => { throw new Error('offline'); },
    llm: async () => null,
    policy: () => ({ advanceStep: true, reason: '规则顺走' }),
  }, masterInput);
  assert.deepEqual(viaPolicy, {
    decision: { advanceStep: true, reason: '规则顺走' },
    source: 'policy',
  });

  assert.deepEqual(await resolveMasterDecisionWithSource({}, masterInput), {
    decision: null,
    source: null,
  });
  // 旧接口行为不变：只回决策。
  assert.deepEqual(await resolveMasterDecision({
    llm: async () => ({ advanceStep: true, reason: '模型顺走' }),
  }, masterInput), { advanceStep: true, reason: '模型顺走' });
});
