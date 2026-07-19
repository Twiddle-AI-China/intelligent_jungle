import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMaster, normalizeMasterDecision } from '../src/master/policy.js';

const menu = {
  progressions: [
    ['spring-0', 'spring-1', 'spring-2', 'spring-3'],
    ['summer-0', 'summer-1', 'summer-2', 'summer-3'],
  ],
  seasonPalettes: {
    spring: ['clear'],
    summer: ['humid', 'storm'],
  },
  seasonLengthRange: [2, 6],
  cooldownDays: 2,
};

const stable = {
  menu,
  state: { currentSeason: 'spring', currentStep: 1, daysInSeason: 1, daysSinceChange: 3 },
  observations: { treeScores: [0.7, 0.65, 0.8, 0.62], patternSimilarity: 0.3 },
};

test('均衡：最低树况连续低于健康带时先跳步，不同时换季', () => {
  const decision = decideMaster({
    ...stable,
    state: { ...stable.state, daysInSeason: 3 },
    observations: { treeScores: [0.8, 0.25, 0.72, 0.6], patternSimilarity: 0.9 },
  });
  assert.deepEqual(decision.jumpToStep, 3);
  assert.equal(decision.advanceStep, false);
  assert.equal(decision.changeSeason, undefined);
  assert.match(decision.reason, /健康带/);
});

test('新鲜：达到最短季长且图样高度相似时换到菜单中的下一季色彩', () => {
  const decision = decideMaster({
    ...stable,
    state: { ...stable.state, daysInSeason: 3 },
    observations: { ...stable.observations, patternSimilarity: 0.92 },
  });
  assert.deepEqual(decision, {
    advanceStep: false,
    changeSeason: 'summer',
    nextPalette: 'humid',
    reason: '同一生态景观相似度持续偏高，换季恢复新鲜感',
  });
});

test('平稳：冷却期阻止到期换季，兜底只顺走一步', () => {
  const decision = decideMaster({
    ...stable,
    state: { ...stable.state, daysInSeason: 7, daysSinceChange: 1 },
  });
  assert.equal(decision.advanceStep, true);
  assert.equal(decision.changeSeason, undefined);
  assert.equal(decision.jumpToStep, undefined);
  assert.match(decision.reason, /冷却期/);
});

test('默认顺走，到季长上限且冷却结束则换季', () => {
  assert.equal(decideMaster(stable).advanceStep, true);
  const expired = decideMaster({
    ...stable,
    state: { ...stable.state, daysInSeason: 6 },
  });
  assert.equal(expired.advanceStep, false);
  assert.equal(expired.changeSeason, 'summer');
  assert.equal(expired.jumpToStep, undefined);
});

test('决策规范化拒绝同时改变两维与菜单外选择', () => {
  assert.equal(normalizeMasterDecision({
    advanceStep: true,
    changeSeason: 'summer',
    nextPalette: 'humid',
    reason: '同时改变',
  }, menu, stable.state), null);
  assert.equal(normalizeMasterDecision({
    advanceStep: false,
    changeSeason: 'summer',
    nextPalette: 'humid',
    reason: '冷却期违规',
  }, menu, { ...stable.state, daysInSeason: 3, daysSinceChange: 1 }), null);
  assert.equal(normalizeMasterDecision({
    advanceStep: false,
    changeSeason: 'winter',
    nextPalette: 'invented',
    reason: '菜单之外',
  }, menu, stable.state), null);
  assert.equal(normalizeMasterDecision({
    advanceStep: false,
    jumpToStep: 99,
    reason: '越界步骤',
  }, menu, stable.state), null);
});
