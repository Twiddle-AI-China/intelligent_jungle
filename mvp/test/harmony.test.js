// mvp/test/harmony.test.js —— 和声层（§3.5.1）：和弦进行按日推进、换季换色彩、
// 家枝最近音级迁移（voice-leading）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chordForDay, seasonForDay, migrateAssignments } from '../src/harmony.js';
import { CONFIG } from '../src/config.js';

test('和弦进行按日推进：默认春季 F→C→G→Am 循环，五音升序', () => {
  const ids = [1, 2, 3, 4, 5, 6].map((d) => chordForDay(d).id);
  assert.deepEqual(ids.slice(0, 4), ['F', 'C', 'G', 'Am']); // 第 1–4 天（春季）
  assert.equal(ids[4], 'Csus4'); // 第 5 天入夏：进行换色彩
  for (let d = 1; d <= 8; d += 1) {
    const { notes } = chordForDay(d);
    assert.equal(notes.length, 5, '每和弦五枝音');
    assert.ok(notes.every((n, i) => i === 0 || n > notes[i - 1]), '音高升序');
  }
});

test('季节 = 色彩变体：4 天一季，春 major → 夏 sus → 秋 m7 → 冬 minor → 回春', () => {
  assert.equal(seasonForDay(1).id, 'spring');
  assert.equal(seasonForDay(4).id, 'spring');
  assert.equal(seasonForDay(5).id, 'summer');
  assert.equal(seasonForDay(9).id, 'autumn');
  assert.equal(seasonForDay(13).id, 'winter');
  assert.equal(seasonForDay(17).id, 'spring'); // 四季循环
  // 色彩确实不同：同日序号在不同季节给出不同和弦质量
  assert.notEqual(chordForDay(1).id, chordForDay(5).id);
  assert.notEqual(chordForDay(5).id, chordForDay(9).id);
});

test('家枝最近音级迁移：Am→F 时鸟搬到新和弦里离旧音最近的枝', () => {
  const am = { notes: [57, 60, 64, 69, 72] };   // A3 C4 E4 A4 C5
  const f = { notes: [53, 57, 60, 65, 69] };    // F3 A3 C4 F4 A4
  const assignments = [
    { birdId: 0, homeBranch: 0 }, // 57 → F 里 57 在枝1（差 0）
    { birdId: 1, homeBranch: 2 }, // 64 → 最近 65（枝3，差 1）
    { birdId: 2, homeBranch: 4 }, // 72 → 最近 69（枝4，差 3）
    { birdId: 3, homeBranch: 1 }, // 60 → 60 在枝2（差 0）
  ];
  const m = migrateAssignments(am, f, assignments);
  assert.deepEqual(m.map((x) => [x.birdId, x.to]), [[0, 1], [1, 3], [2, 4], [3, 2]]);
  assert.equal(m[1].semitoneShift, 1); // 64→65
});

test('迁移是保守的：同和弦迁移全部保持原位（差 0 优先）', () => {
  const am = { notes: [57, 60, 64, 69, 72] };
  const assignments = [0, 1, 2, 3, 4].map((b) => ({ birdId: b, homeBranch: b }));
  const m = migrateAssignments(am, am, assignments);
  assert.ok(m.every((x) => x.from === x.to && x.semitoneShift === 0));
});

test('换季音色差异可辨：四季首日和弦根音/音程结构不同', () => {
  const firsts = [1, 5, 9, 13].map((d) => chordForDay(d));
  const signatures = new Set(firsts.map((c) => c.notes.map((n) => n - c.notes[0]).join(',')));
  assert.equal(signatures.size, 4, '四季和弦色彩应互不相同');
  assert.ok(CONFIG.harmony.seasonDays === 4);
});
