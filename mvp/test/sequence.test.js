import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import {
  activeSequenceCellsAtStep,
  applySequenceCellMutations,
  createSequenceGrid,
  createSequencePatternBridge,
  defaultSequenceDimensions,
  getSequenceCell,
  legacyBranchToSequenceAddress,
  eventToSequenceAddress,
  sequencePatternSummary,
  sequencePlayheadFromPhase,
  setSequenceCell,
} from '../src/sequence.js';

test('cell mutation 原子移动已占格并保留 count', () => {
  const summary = {
    version: 2, pitchBranchCount: 5, stepCount: 16,
    occupiedCells: [
      { pitchBranchId: 1, stepIndex: 2, count: 3 },
      { pitchBranchId: 3, stepIndex: 8, count: 1 },
    ],
  };
  const result = applySequenceCellMutations(summary, [{
    from: { pitchBranchId: 1, stepIndex: 2 },
    to: { pitchBranchId: 2, stepIndex: 5 },
  }], { maxMutations: 2 });
  assert.deepEqual(result.mutations, [{
    from: { pitchBranchId: 1, stepIndex: 2 },
    to: { pitchBranchId: 2, stepIndex: 5 },
  }]);
  assert.deepEqual(result.summary.occupiedCells, [
    { pitchBranchId: 2, stepIndex: 5, count: 3 },
    { pitchBranchId: 3, stepIndex: 8, count: 1 },
  ]);
  assert.deepEqual(summary.occupiedCells[0], { pitchBranchId: 1, stepIndex: 2, count: 3 },
    '输入摘要保持不可变');
});

test('cell mutation 任一越界、空来源、目标占用或链式地址使整批失败', () => {
  const summary = {
    version: 2, pitchBranchCount: 5, stepCount: 16,
    occupiedCells: [
      { pitchBranchId: 1, stepIndex: 2, count: 1 },
      { pitchBranchId: 2, stepIndex: 4, count: 1 },
    ],
  };
  const move = (from, to) => ({ from, to });
  assert.equal(applySequenceCellMutations(summary, [move(
    { pitchBranchId: 5, stepIndex: 2 }, { pitchBranchId: 0, stepIndex: 0 },
  )]), null);
  assert.equal(applySequenceCellMutations(summary, [move(
    { pitchBranchId: 0, stepIndex: 0 }, { pitchBranchId: 0, stepIndex: 1 },
  )]), null);
  assert.equal(applySequenceCellMutations(summary, [move(
    { pitchBranchId: 1, stepIndex: 2 }, { pitchBranchId: 2, stepIndex: 4 },
  )]), null);
  assert.equal(applySequenceCellMutations(summary, [
    move({ pitchBranchId: 1, stepIndex: 2 }, { pitchBranchId: 0, stepIndex: 0 }),
    move({ pitchBranchId: 2, stepIndex: 4 }, { pitchBranchId: 1, stepIndex: 2 }),
  ]), null, '禁止链/交换，避免顺序依赖');
});

test('Sequence v2 默认四声部共用 5 音高枝 × 16 拍时间轴', () => {
  const dimensions = defaultSequenceDimensions();
  assert.deepEqual(dimensions, { pitchBranchCount: 5, stepCount: 16 });
  const grid = createSequenceGrid();
  assert.equal(grid.version, 2);
  assert.deepEqual(Object.keys(grid.voices), CONFIG.trees.map((tree) => tree.id));
  for (const voice of Object.values(grid.voices)) {
    assert.equal(voice.lanes.length, 5);
    assert.ok(voice.lanes.every((lane) => lane.steps.length === 16));
    assert.ok(voice.lanes.every((lane) => lane.steps.every((value) => value == null)));
  }
});

test('原生 v2 事件坐标优先，缺 step 时才从 phase 派生', () => {
  assert.deepEqual(eventToSequenceAddress({
    treeId: 'pad', pitchBranchId: 4, stepIndex: 3, branchId: 0, phase: 0.9,
  }), { treeId: 'pad', pitchBranchId: 4, stepIndex: 3 });
  assert.deepEqual(eventToSequenceAddress({ treeId: 'pad', pitchBranchId: 2, phase: 0.5 }), {
    treeId: 'pad', pitchBranchId: 2, stepIndex: 8,
  });
});

test('Agent 迁移桥按日镜像 perch 到网格，不覆盖同格多鸟', () => {
  const bridge = createSequencePatternBridge();
  assert.equal(bridge.feed({ type: 'unperch', treeId: 'pad', branchId: 1, phase: 0 }), false);
  bridge.feed({ type: 'perch', treeId: 'pad', birdId: 1, branchId: 2, phase: 0.25 });
  bridge.feed({ type: 'perch', treeId: 'pad', birdId: 2, branchId: 2, phase: 0.25 });
  const finished = bridge.finishDay();
  assert.equal(getSequenceCell(finished, { treeId: 'pad', pitchBranchId: 2, stepIndex: 4 }).length, 2);
  assert.equal(getSequenceCell(bridge.getCurrent(), {
    treeId: 'pad', pitchBranchId: 2, stepIndex: 4,
  }), null, '新一日从空网格开始');
  assert.deepEqual(sequencePatternSummary(finished, 'pad').occupiedCells, [
    { pitchBranchId: 2, stepIndex: 4, count: 2 },
  ]);
});

test('网格写入不可变；地址严格为 treeId × pitchBranchId × stepIndex', () => {
  const before = createSequenceGrid({ treeIds: ['pad'], pitchBranchCount: 5, stepCount: 8 });
  const address = { treeId: 'pad', pitchBranchId: 3, stepIndex: 6 };
  const after = setSequenceCell(before, address, { birdId: 7, gate: 0.75 });
  assert.equal(getSequenceCell(before, address), null, '旧 pattern 可安全留给相似度评估');
  assert.deepEqual(getSequenceCell(after, address), { birdId: 7, gate: 0.75 });
  assert.notEqual(after, before);
  assert.notEqual(after.voices.pad, before.voices.pad);
  assert.throws(() => setSequenceCell(after, { ...address, pitchBranchId: 5 }), RangeError);
  assert.throws(() => setSequenceCell(after, { ...address, stepIndex: 8 }), RangeError);
});

test('播放头按整日 phase 线性走完时间轴并正确循环', () => {
  assert.deepEqual(sequencePlayheadFromPhase(0, 16), {
    stepIndex: 0, stepProgress: 0, normalizedPhase: 0,
  });
  assert.equal(sequencePlayheadFromPhase(0.25, 16).stepIndex, 4);
  assert.equal(sequencePlayheadFromPhase(0.5, 16).stepIndex, 8);
  assert.equal(sequencePlayheadFromPhase(0.999, 16).stepIndex, 15);
  assert.equal(sequencePlayheadFromPhase(1, 16).stepIndex, 0);
  assert.equal(sequencePlayheadFromPhase(-0.25, 16).stepIndex, 12);
});

test('同一步可读出不同音高枝的复音，所有声部使用相同查询', () => {
  let grid = createSequenceGrid({ treeIds: ['pad', 'melody'], stepCount: 4 });
  grid = setSequenceCell(grid, { treeId: 'pad', pitchBranchId: 0, stepIndex: 2 }, 'root');
  grid = setSequenceCell(grid, { treeId: 'pad', pitchBranchId: 3, stepIndex: 2 }, 'color');
  grid = setSequenceCell(grid, { treeId: 'melody', pitchBranchId: 1, stepIndex: 2 }, true);
  assert.deepEqual(activeSequenceCellsAtStep(grid, 'pad', 2), [
    { treeId: 'pad', pitchBranchId: 0, stepIndex: 2, value: 'root' },
    { treeId: 'pad', pitchBranchId: 3, stepIndex: 2, value: 'color' },
  ]);
  assert.equal(activeSequenceCellsAtStep(grid, 'melody', 2).length, 1);
  assert.deepEqual(activeSequenceCellsAtStep(grid, 'bass', 2), []);
});

test('旧纵枝事件保留音高枝，时间来自当前 phase', () => {
  assert.deepEqual(
    legacyBranchToSequenceAddress({ treeId: 'melody', branchId: 3, phase: 0.5 }),
    { treeId: 'melody', pitchBranchId: 3, stepIndex: 8 },
  );
  assert.equal(legacyBranchToSequenceAddress({ treeId: 'pad', branchId: 99, phase: 0 }), null);
  assert.equal(legacyBranchToSequenceAddress({ branchId: 2, phase: 0 }), null);
});

test('Bass 旧 5–9 runner 地址已删除，只接受统一 0–4 音高枝', () => {
  assert.deepEqual([5, 6, 7, 8, 9].map((branchId) => legacyBranchToSequenceAddress({
    treeId: 'bass', branchId, phase: 0.9,
  })), [null, null, null, null, null]);
  assert.deepEqual(
    legacyBranchToSequenceAddress({ treeId: 'bass', branchId: 2, phase: 0.5 }),
    { treeId: 'bass', pitchBranchId: 2, stepIndex: 8 },
  );
});
