import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_BADGES,
  appendToDays,
  createTimelinePanel,
  formatDecisionRow,
} from '../src/timeline.js';

test('formatDecisionRow 徽标按来源映射：规则 / LLM / 外部', () => {
  assert.equal(formatDecisionRow({ source: 'rule' }).badge, '规则');
  assert.equal(formatDecisionRow({ source: 'llm' }).badge, 'LLM');
  assert.equal(formatDecisionRow({ source: 'external' }).badge, '外部');
  // 未认识来源：有值则透传，缺省回落规则徽标。
  assert.equal(formatDecisionRow({ source: 'policy-x' }).badge, 'policy-x');
  assert.equal(formatDecisionRow({}).badge, SOURCE_BADGES.rule);
});

test('formatDecisionRow 标题为 actor + action，flock 带 flockId', () => {
  assert.equal(
    formatDecisionRow({ actor: 'master', action: 'advanceStep' }).title,
    'master advanceStep',
  );
  assert.equal(
    formatDecisionRow({ actor: 'flock', flockId: 2, action: 'mutateHomeBranch' }).title,
    'flock·2 mutateHomeBranch',
  );
  assert.equal(formatDecisionRow({ actor: 'flock', action: 'hold' }).title, 'flock hold');
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

test('createTimelinePanel 无 document 时返回 null 不 throw', () => {
  assert.equal(createTimelinePanel({ container: {} }), null);
  assert.equal(createTimelinePanel(), null);
});
