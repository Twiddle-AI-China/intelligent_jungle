import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMasterDecision,
  resolveMasterDecisionWithSource,
} from '../src/master/external-master.js';

const masterInput = {
  menu: {
    seasons: ['spring', 'summer'],
    colorsBySeason: { spring: ['clear', 'mist'], summer: ['humid', 'storm'] },
    seasonLengthRange: [8, 16],
    tensionRange: [0.2, 0.6],
  },
  state: { season: 'spring', seasonDay: 11, seasonLength: 12, currentColorId: 'clear' },
  observations: { treeScores: [0.7, 0.8], harmonyScores: [0.9, 0.5], patternSimilarity: 0.3 },
};

test('master 组合器优先采用并规范化 llm 决策', async () => {
  let policyCalls = 0;
  const result = await resolveMasterDecisionWithSource({
    llm: async () => ({ colorId: 'mist', tension: 0.4, reason: '模型选档' }),
    policy: () => {
      policyCalls += 1;
      return { colorId: 'clear', tension: 0.5, reason: '规则轮转' };
    },
  }, masterInput);

  assert.deepEqual(result, {
    decision: { colorId: 'mist', tension: 0.4, reason: '模型选档' },
    source: 'llm',
  });
  assert.equal(policyCalls, 0);
});

test('llm 返回 null、抛错、菜单外色彩或越 tensionRange 时回落 policy', async () => {
  const fallback = { colorId: 'clear', tension: 0.5, reason: '规则轮转' };
  const llmSources = [
    async () => null,
    async () => { throw new Error('offline'); },
    async () => ({ colorId: 'neon', tension: 0.4, reason: '菜单外色彩' }),
    async () => ({ colorId: 'mist', tension: 0.8, reason: '菜单外张力' }),
  ];

  for (const llm of llmSources) {
    assert.deepEqual(await resolveMasterDecisionWithSource({
      llm,
      policy: () => fallback,
    }, masterInput), { decision: fallback, source: 'policy' });
  }
});

test('组合器接受 requestDecision 对象并保持旧接口只返回决策', async () => {
  const llm = {
    async requestDecision() {
      return { colorId: 'mist', tension: 0.6, reason: '对象式来源' };
    },
  };
  assert.deepEqual(await resolveMasterDecision({ llm }, masterInput), {
    colorId: 'mist',
    tension: 0.6,
    reason: '对象式来源',
  });
});

test('没有可用来源或 policy 失败时返回 null 决策与 null 来源', async () => {
  assert.deepEqual(await resolveMasterDecisionWithSource({}, masterInput), {
    decision: null,
    source: null,
  });
  assert.deepEqual(await resolveMasterDecisionWithSource({
    llm: async () => null,
    policy: () => { throw new Error('bad policy'); },
  }, masterInput), { decision: null, source: null });
});
