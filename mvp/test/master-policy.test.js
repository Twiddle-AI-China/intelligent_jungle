import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMaster, normalizeMasterDecision } from '../src/master/policy.js';

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

test('规则兜底：色彩档按日轮转，张力随季节进度线性爬升', () => {
  const day0 = decideMaster({ menu, state: { season: 'spring', seasonDay: 0, seasonLength: 12 } });
  assert.equal(day0.colorId, 'clear');
  assert.equal(day0.tension, 0);
  const day4 = decideMaster(midSeason);
  assert.equal(day4.colorId, 'mist'); // colors[4 % 3]
  assert.equal(day4.tension, 0.36); // 4/11 保留两位
  const wrap = decideMaster({ menu, state: { season: 'spring', seasonDay: 3, seasonLength: 12 } });
  assert.equal(wrap.colorId, 'clear', '3 % 3 轮转回绕到首档');
  assert.equal(day4.nextSeason, undefined, '非季末日不得给换季字段');
});

test('规则兜底：季末日给下一季与范围中值季长', () => {
  const finalDay = decideMaster({ menu, state: { season: 'spring', seasonDay: 11, seasonLength: 12 } });
  assert.equal(finalDay.nextSeason, 'summer');
  assert.equal(finalDay.seasonLength, 12); // (8+16)/2
  assert.equal(finalDay.tension, 1);
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

test('均衡：某树连续两日低分 → 换下一档而非轮转原档，tension 不动（一次一维）', () => {
  const d = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'mist' },
    observations: { treeScores: [0.7, [0.5, 0.3, 0.2], 0.8], harmonyScores: [0.9, 0.9, 0.9] },
  });
  assert.equal(d.colorId, 'dawn', 'mist 的下一档（colors=[clear,mist,dawn]）');
  assert.equal(d.tension, 0.36, '换档日 tension 保持基准爬升，不额外上调');
  assert.match(d.reason, /连续2日低分/);
  assert.match(d.reason, /mist→dawn/);
  assert.match(d.reason, /treeScores#1/);
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

test('新鲜：同档天数腻值累积触发换档；相似度偏高同样触发', () => {
  const byDays = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'clear', daysInColor: 4 },
    observations: { treeScores: [0.7, 0.8] },
  });
  assert.equal(byDays.colorId, 'mist');
  assert.match(byDays.reason, /已连续4天/);
  const bySimilarity = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'clear' },
    observations: { treeScores: [0.7, 0.8], patternSimilarity: 0.9 },
  });
  assert.equal(bySimilarity.colorId, 'mist');
  assert.match(bySimilarity.reason, /相似度/);
  // 未到腻值阈值：维持轮转基线
  const fresh = decideMaster({
    menu,
    state: { season: 'spring', seasonDay: 4, seasonLength: 12, currentColorId: 'clear', daysInColor: 1 },
    observations: { treeScores: [0.7, 0.8], patternSimilarity: 0.3 },
  });
  assert.equal(fresh.colorId, 'mist', '季内第 5 天轮转 colors[4%3]=mist');
});

test('平稳：换季后冷却 2 天内不动任何维（低分/腻值均被抑制）', () => {
  const d = decideMaster({
    menu,
    state: { season: 'summer', seasonDay: 1, seasonLength: 12, currentColorId: 'humid', daysSinceChange: 1 },
    observations: { treeScores: [[0.3, 0.2, 0.1]], patternSimilarity: 0.95 },
  });
  assert.equal(d.colorId, 'humid', '冷却期不换档');
  assert.match(d.reason, /冷却期/);
  // 冷却结束（第 2 天之后）恢复干预
  const after = decideMaster({
    menu,
    state: { season: 'summer', seasonDay: 3, seasonLength: 12, currentColorId: 'humid', daysSinceChange: 3 },
    observations: { treeScores: [[0.3, 0.2, 0.1]] },
  });
  assert.equal(after.colorId, 'storm', 'humid 的下一档');
});
