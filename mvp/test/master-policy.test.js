import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideMaster,
  getMasterDecisionEvidence,
  normalizeMasterDecision,
} from '../src/master/policy.js';

// 新契约（harmony-season-redesign §3）：季=固定和声骨架，每黎明选 colorId+tension，
// 季末日额外 nextSeason+seasonLength(8..16)。
const menu = {
  seasons: ['spring', 'summer', 'autumn', 'winter'],
  colorsBySeason: {
    spring: ['clear', 'mist', 'dawn'],
    summer: ['humid', 'storm'],
  },
  seasonLengthRange: [8, 16],
};

const midSeason = {
  menu,
  state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'mist' },
  observations: { treeScores: [0.7, 0.8], harmonyScores: [0.9, 0.6] },
};

test('规则兜底（T2.6）：平稳保持当前色，张力随季节进度线性爬升', () => {
  const day0 = decideMaster({ menu, state: { season: 'spring', seasonDay: 0, seasonLength: 12 } });
  assert.equal(day0.colorId, 'clear', '冷启动落菜单首档');
  assert.equal(day0.tension, 0);
  assert.match(day0.reason, /保持色彩档/);
  const day4 = decideMaster(midSeason);
  assert.equal(day4.colorId, 'mist', '有 currentColorId 时平稳不换档');
  assert.equal(day4.tension, 0.36); // 4/11 保留两位
  const held = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 3, seasonLength: 12, currentColorId: 'dawn', daysInColor: 1 },
    observations: { treeScores: [0.7, 0.8] },
  });
  assert.equal(held.colorId, 'dawn', '平稳不再按 seasonDay%n 轮转');
  assert.match(held.reason, /保持色彩档/);
  assert.equal(day4.nextSeason, undefined, '非季末日不得给换季字段');
});

test('规则兜底（T2.7/T4.11）：季末日 rng 季长 + 色彩按日轮转解冻', () => {
  const finalDay = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 11, seasonLength: 12, currentColorId: 'mist' },
    rng: () => 0.0, // → lo=8
  });
  assert.equal(finalDay.nextSeason, 'summer');
  assert.equal(finalDay.seasonLength, 8);
  assert.equal(finalDay.colorId, 'dawn', '11%3 → dawn 解冻轮转，非钉死 mist');
  assert.equal(finalDay.tension, 1);
  assert.match(finalDay.reason, /rng 取样/);
  const hi = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 11, seasonLength: 12 },
    rng: () => 0.999,
  });
  assert.equal(hi.seasonLength, 16);
  const winter = decideMaster({ menu, state: { season: 'winter', seasonDay: 9, seasonLength: 10 } });
  assert.equal(winter.nextSeason, 'spring', '季列表回绕');
});

test('规则兜底：旧字段名（currentSeason/daysInSeason/seasonPalettes）同样可读', () => {
  const legacyMenu = { seasonPalettes: { spring: ['base'] }, seasonLengthRange: [2, 8] };
  const d = decideMaster({
    menu: legacyMenu,
    state: { currentSeason: 'spring', daysInSeason: 2 },
  });
  assert.equal(d.colorId, 'base');
  assert.ok(d.tension >= 0 && d.tension <= 1);
});

test('校验：合法单日决策与季末日换季决策通过', () => {
  const daily = normalizeMasterDecision(
    { colorId: 'mist', tension: 0.35, reason: '明暗呼吸' }, menu, midSeason.state);
  assert.deepEqual(daily, { colorId: 'mist', tension: 0.35, reason: '明暗呼吸' });
  const turning = normalizeMasterDecision(
    { colorId: 'dawn', tension: 1, nextSeason: 'summer', seasonLength: 10, reason: '季末日换季' },
    menu, { season: 'spring', seasonDay: 11, seasonLength: 12 });
  assert.deepEqual(turning, {
    colorId: 'dawn', tension: 1, nextSeason: 'summer', seasonLength: 10, reason: '季末日换季',
  });
});

test('校验：菜单外色彩、越界张力、缺理由一律整单 null', () => {
  const cases = [
    { colorId: 'neon', tension: 0.3, reason: '菜单外色彩' },
    { colorId: 'mist', tension: 1.5, reason: '张力越界' },
    { colorId: 'mist', tension: -0.1, reason: '负张力' },
    { colorId: 'mist', tension: 0.3, reason: '  ' },
    { tension: 0.3, reason: '缺 colorId' },
    { colorId: 'mist', reason: '缺 tension' },
  ];
  for (const raw of cases) assert.equal(normalizeMasterDecision(raw, menu, midSeason.state), null);
});

test('校验：换季字段只属季末日，且季长必须在范围内', () => {
  const base = { colorId: 'mist', tension: 0.5, reason: 'x' };
  // 非季末日给换季字段 → null
  assert.equal(normalizeMasterDecision(
    { ...base, nextSeason: 'summer', seasonLength: 12 }, menu, midSeason.state), null);
  const finalState = { season: 'spring', seasonDay: 11, seasonLength: 12 };
  // 季长越界 / 缺季长 / 菜单外季节 / 原地换季 → null
  assert.equal(normalizeMasterDecision(
    { ...base, nextSeason: 'summer', seasonLength: 20 }, menu, finalState), null);
  assert.equal(normalizeMasterDecision(
    { ...base, nextSeason: 'summer' }, menu, finalState), null);
  assert.equal(normalizeMasterDecision(
    { ...base, nextSeason: 'venus', seasonLength: 12 }, menu, finalState), null);
  assert.equal(normalizeMasterDecision(
    { ...base, nextSeason: 'spring', seasonLength: 12 }, menu, finalState), null);
  // 不换季却带 seasonLength → null
  assert.equal(normalizeMasterDecision(
    { ...base, seasonLength: 12 }, menu, midSeason.state), null);
});

test('校验：旧 advanceStep 形状不再合法（新菜单已废除顺走/跳步）', () => {
  assert.equal(normalizeMasterDecision(
    { advanceStep: true, reason: '旧契约' }, menu, midSeason.state), null);
});

test('均衡：某树连续两日低分 → 换档（带生态相位），tension 不动（一次一维）', () => {
  // treeScores#1 最低 → phase=1；step=1+(1%2)=2；mist idx=1 → (1+2)%3=0 → clear
  const d = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'mist' },
    observations: { treeScores: [0.7, [0.5, 0.3, 0.2], 0.8], harmonyScores: [0.9, 0.9, 0.9] },
  });
  assert.equal(d.colorId, 'clear', 'phase=1 时 mist 下家为 clear');
  assert.equal(d.tension, 0.36, '换档日 tension 保持基准爬升，不额外上调');
  assert.match(d.reason, /连续2日低分/);
  assert.match(d.reason, /mist→clear/);
  assert.match(d.reason, /treeScores#1/);
  assert.match(d.reason, /相位1/);
});

test('均衡：连续低分且各树同分 → 相位0，行为等同旧顺挂', () => {
  const d = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'mist' },
    observations: { treeScores: [[0.2, 0.2], [0.2, 0.2], [0.2, 0.2]], harmonyScores: [0.9, 0.9, 0.9] },
  });
  assert.equal(d.colorId, 'dawn', 'phase=0（并列取首）时 mist→dawn');
  assert.match(d.reason, /相位0/);
});

test('均衡：仅当日单日低分 → 只小幅上调 tension，不换档（一次一维）', () => {
  const d = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'mist' },
    observations: { treeScores: [0.7, 0.8], harmonyScores: [0.9, 0.35] },
  });
  assert.equal(d.colorId, 'mist', '动 tension 日不换档');
  assert.equal(d.tension, 0.46, '基准 0.36 + 0.1');
  assert.match(d.reason, /当日低分/);
  assert.match(d.reason, /harmonyScores#1/);
});

test('均衡：null 和谐观测不当作 0，不制造低分 streak', () => {
  const d = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'mist' },
    observations: {
      treeScores: [0.7, 0.8],
      harmonyScores: [[null, undefined], null],
    },
  });
  assert.equal(d.colorId, 'mist', '缺失观测不触发均衡换档');
  assert.equal(d.tension, 0.36, '缺失观测不触发单日低分张力补偿');
  assert.doesNotMatch(d.reason, /低分/);
});

test('均衡：null 不重置有效观测历史，两个真实低 H 仍触发', () => {
  // 仅 harmony 低分、treeScores 健康 → phase=0（tree 并列高分取首）
  const d = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'mist' },
    observations: {
      treeScores: [0.7, 0.8],
      harmonyScores: [[0.2, null, 0.2]],
    },
  });
  assert.equal(d.colorId, 'dawn');
  assert.equal(d.tension, 0.36);
  assert.match(d.reason, /harmonyScores#0 连续2日低分/);
});

test('新鲜：主指标=同档连续天数；相似度仅辅助佐证，不独立触发换档', () => {
  // 同档 ≥3 天 → 换档（T2.6 复活：平稳不再日更，腻值通道可触发）
  const byDays = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'clear', daysInColor: 4 },
    observations: { treeScores: [0.7, 0.8] },
  });
  assert.equal(byDays.colorId, 'mist');
  assert.match(byDays.reason, /已连续4天/);
  // 同档达标且相似度仍高 → 理由带相似度佐证
  const corroborated = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'clear', daysInColor: 3 },
    observations: { treeScores: [0.7, 0.8], patternSimilarity: 0.9 },
  });
  assert.equal(corroborated.colorId, 'mist');
  assert.match(corroborated.reason, /已连续3天/);
  assert.match(corroborated.reason, /相似度 0\.90 仍高/);
  // 相似度偏高但同档仅 1 天 → 不独立触发，平稳保持当前色
  const simOnly = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'clear', daysInColor: 1 },
    observations: { treeScores: [0.7, 0.8], patternSimilarity: 0.95 },
  });
  assert.equal(simOnly.colorId, 'clear', '未达腻值则保持当前色');
  assert.match(simOnly.reason, /保持色彩档/);
  // 同档 2 天 + 高相似度 → 仍不换档
  const twoDays = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 3, seasonLength: 12, currentColorId: 'clear', daysInColor: 2 },
    observations: { treeScores: [0.7, 0.8], patternSimilarity: 0.95 },
  });
  assert.equal(twoDays.colorId, 'clear');
  assert.match(twoDays.reason, /保持色彩档/);
});

test('均衡：单日低分的张力微调优先于新鲜换档（腻值不得抢跑）', () => {
  const d = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'mist', daysInColor: 5 },
    observations: { treeScores: [0.7, 0.8], harmonyScores: [0.9, 0.35], patternSimilarity: 0.95 },
  });
  assert.equal(d.colorId, 'mist', '单日低分日只动 tension，色彩档不换');
  assert.equal(d.tension, 0.46, '基准 0.36 + 0.1');
  assert.match(d.reason, /当日低分/);
});

test('平稳（T4.11）：冷却期色彩按日轮转解冻；低分/腻值干预仍抑制', () => {
  const d = decideMaster({
    menu,
    state: { season: 'summer', seasonDay: 1, seasonLength: 12, currentColorId: 'humid', daysSinceChange: 1 },
    observations: { treeScores: [[0.3, 0.2, 0.1]], patternSimilarity: 0.95 },
  });
  assert.equal(d.colorId, 'storm', '冷却期 colors[1%2]=storm 解冻，不钉死 humid');
  assert.match(d.reason, /冷却期/);
  assert.match(d.reason, /轮转解冻/);
  // 冷却结束（第 2 天之后）恢复干预：连续低分 → 换档
  const after = decideMaster({
    menu,
    state: { season: 'summer', seasonDay: 3, seasonLength: 12, currentColorId: 'humid', daysSinceChange: 3 },
    observations: { treeScores: [[0.3, 0.2, 0.1]] },
  });
  assert.equal(after.colorId, 'storm', 'humid 的下一档（相位0）');
});

test('T2.8：换色下家带生态相位（最低分树索引偏移，永不落回当前档）', () => {
  // treeScores#2 最低 → phase=2；step=1+(2%2)=1；mist→dawn（若用 +1+phase 会 mist→mist）
  const d = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'mist', daysInColor: 1 },
    observations: { treeScores: [0.8, 0.7, [0.1, 0.1]], harmonyScores: [0.9, 0.9, 0.9] },
  });
  assert.equal(d.colorId, 'dawn', 'phase=2 → step=1，mist→dawn');
  assert.notEqual(d.colorId, 'mist');
  assert.match(d.reason, /相位2/);
  assert.match(d.reason, /连续2日低分/);
});

test('policy 只读证据与真实 state/observations 三观字段同源', () => {
  const decision = decideMaster({
    menu,
    state: {
      season: 'spring', seasonDay: 4, seasonLength: 12,
      currentColorId: 'clear', daysInColor: 4, daysSinceChange: 3,
    },
    observations: {
      treeScores: [0.8, [0.5, 0.3, 0.2]], harmonyScores: [0.9], patternSimilarity: 0.9,
    },
  });
  assert.deepEqual(getMasterDecisionEvidence(decision), {
    balance: { maxStreak: 2, lowestToday: 0.2, lowLabel: 'treeScores#1', scoreFloor: 0.4 },
    freshness: {
      daysInColor: 4, patternSimilarity: 0.9, bored: 4,
      boredDays: 3, similarityThreshold: 0.82,
    },
    stability: { daysSinceChange: 3, cooldownDays: 2, inCooldown: false },
  });
  assert.equal(Object.isFrozen(getMasterDecisionEvidence(decision)), true);
  assert.equal(getMasterDecisionEvidence({ colorId: 'llm' }), null, '非 policy 决策不猜测依据');
});
