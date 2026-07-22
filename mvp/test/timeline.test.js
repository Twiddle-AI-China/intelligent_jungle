import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_BADGES,
  appendToDays,
  createTimelinePanel,
  formatDecisionRow,
  isNearScrollBottom,
  sanitizeReasonText,
} from '../src/timeline.js';

test('formatDecisionRow 将实现来源改写成产品世界观徽标', () => {
  assert.equal(formatDecisionRow({ source: 'rule' }).badge, '林群');
  assert.equal(formatDecisionRow({ source: 'llm' }).badge, '林群');
  assert.equal(formatDecisionRow({ source: 'external' }).badge, '协作');
  assert.equal(formatDecisionRow({ source: 'user' }).badge, '接管');
  // 未认识来源不得把 provider/policy 名称泄露到产品 UI。
  assert.equal(formatDecisionRow({ source: 'policy-x' }).badge, '林群');
  assert.equal(formatDecisionRow({}).badge, SOURCE_BADGES.rule);
});

test('formatDecisionRow 标题使用林群世界观，flock 带 flockId', () => {
  assert.equal(
    formatDecisionRow({ actor: 'master', action: 'advanceStep' }).title,
    '季节意图 advanceStep',
  );
  assert.equal(
    formatDecisionRow({ actor: 'flock', flockId: 2, action: 'mutateHomeBranch' }).title,
    '声部·2 mutateHomeBranch',
  );
  assert.equal(formatDecisionRow({ actor: 'flock', action: 'hold' }).title, '声部 hold');
});

test('formatDecisionRow reason 超 60 字截断加省略号，短文本原样', () => {
  const short = '密度偏离带下沿，提高 dwell 基线';
  const row = formatDecisionRow({ reason: short });
  assert.equal(row.reasonShort, short);
  assert.equal(row.reasonFull, short);

  const long = '长'.repeat(80);
  const longRow = formatDecisionRow({ reason: long });
  assert.equal(longRow.reasonShort, `${'长'.repeat(60)}…`);
  assert.equal(longRow.reasonFull, long);
  // 恰好 60 字不截断。
  const exact = '字'.repeat(60);
  assert.equal(formatDecisionRow({ reason: exact }).reasonShort, exact);
});

test('formatDecisionRow 缺省字段容错：空 entry 不 throw', () => {
  const row = formatDecisionRow();
  assert.deepEqual(Object.keys(row).sort(), ['badge', 'reasonFull', 'reasonShort', 'title']);
  assert.equal(row.title, '— —');
  assert.equal(row.reasonShort, '');
  assert.equal(row.reasonFull, '');
  assert.equal(formatDecisionRow({ reason: 42 }).reasonFull, '42');
});

test('appendToDays 同天归入同组，新天开新组', () => {
  let days = [];
  days = appendToDays(days, { day: 1, action: 'a' });
  days = appendToDays(days, { day: 1, action: 'b' });
  days = appendToDays(days, { day: 2, action: 'c' });
  assert.equal(days.length, 2);
  assert.deepEqual(days[0].entries.map((e) => e.action), ['a', 'b']);
  assert.deepEqual(days[1].entries.map((e) => e.action), ['c']);
});

test('appendToDays 超过 maxDays 裁掉最老的天', () => {
  let days = [];
  for (let day = 1; day <= 16; day += 1) {
    days = appendToDays(days, { day, action: `d${day}` }, 14);
  }
  assert.equal(days.length, 14);
  assert.equal(days[0].day, 3);
  assert.equal(days[13].day, 16);
  // 裁到天粒度：向最后一天追加仍归同组，组数不超上限。
  days = appendToDays(days, { day: 16, action: 'extra' }, 14);
  assert.equal(days.length, 14);
  assert.equal(days[13].entries.length, 2);
});

test('appendToDays 容错：坏 days、缺 day、坏 maxDays 不 throw', () => {
  const days = appendToDays(null, { action: 'x' }, 'bad');
  assert.equal(days.length, 1);
  assert.equal(days[0].day, 0);
  assert.equal(appendToDays([], { day: 1 }, 0).length, 1);
});

test('自动跟随只在接近底部时成立', () => {
  assert.equal(isNearScrollBottom({ scrollHeight: 500, scrollTop: 276, clientHeight: 200 }), true);
  assert.equal(isNearScrollBottom({ scrollHeight: 500, scrollTop: 200, clientHeight: 200 }), false);
  assert.equal(isNearScrollBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 140 }), true);
});

test('createTimelinePanel 无 document 时返回 null 不 throw', () => {
  assert.equal(createTimelinePanel({ container: {} }), null);
  assert.equal(createTimelinePanel(), null);
});

test('展示层兜底：泄漏的实现措辞整条换成中性文案，规则层术语原样通过', () => {
  for (const leak of [
    '仅根据提供的标志和优先级规则进行决策', '当前状态：季节为春季',
    'LLM 输出 JSON', '按 policy fallback 处理', 'provider 不可达', 'debug: schema 校验失败',
  ]) {
    assert.equal(sanitizeReasonText(leak), '林群未给出可读说明', `应兜底：${leak}`);
    assert.equal(formatDecisionRow({ reason: leak }).reasonFull, '林群未给出可读说明');
  }
  // 规则层自己写的音乐/行为术语必须原样保留——这是可调试性的主要来源。
  for (const keep of [
    '密度偏离带下沿，提高 dwell 基线', '换季冷却期（第 1/2 天），色彩按日轮转解冻',
    '季末日：选定菜单中的下一季，季长 rng 取样 8', '树况平稳：保持色彩档 base，张力随季节进度爬升',
    '漫游:鸟5 家枝2→4（注入小变异）',
  ]) assert.equal(sanitizeReasonText(keep), keep, `不得误伤：${keep}`);
  assert.equal(sanitizeReasonText(null), '');
  assert.equal(sanitizeReasonText(42), '42');
});
