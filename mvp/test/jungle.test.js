import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AMEN_TRANSIENT_STEPS,
  JUNGLE_PITCH_SEMITONES,
  jungleEditPlan,
  jungleGrainPlan,
  jungleRoleDiversity,
  jungleSliceForCell,
} from '../src/jungle.js';

test('Amen 16 格读取 dnber 瞬态表，句尾保留第 31 格', () => {
  assert.equal(AMEN_TRANSIENT_STEPS.length, 16);
  assert.equal(jungleSliceForCell({ stepIndex: 3 }).amenStep, 6);
  assert.equal(jungleSliceForCell({ stepIndex: 15 }).amenStep, 31);
});

test('Jungle 编辑由密度、冲突、相似度和张力证据决定', () => {
  assert.equal(jungleEditPlan({ onsetCount: 9, conflictRatio: 0.06 }).breakEdit, 'dropout');
  const repeat = jungleEditPlan({ onsetCount: 6, patternSimilarity: 0.9, tension: 0.8 });
  assert.equal(repeat.breakEdit, 'repeat4');
  assert.equal(repeat.toneEdit, 'reverse');
  assert.equal(jungleEditPlan({ day: 4, tension: 0.5 }).toneEdit, 'dub');
});

test('Jungle：步进决定 Amen offset，音高枝只决定移调', () => {
  const low = jungleSliceForCell({ pitchBranchId: 0, stepIndex: 6, tension: 0 });
  const root = jungleSliceForCell({ pitchBranchId: 2, stepIndex: 6, tension: 0 });
  const high = jungleSliceForCell({ pitchBranchId: 4, stepIndex: 6, tension: 0 });
  assert.equal(low.amenStep, 12);
  assert.equal(root.amenStep, 12);
  assert.equal(high.amenStep, 12);
  assert.ok(Math.abs(root.jungleBpm - 120) < 1e-9);
  assert.ok(Math.abs(root.outputSeconds - 0.5) < 1e-9);
  assert.ok(Math.abs(root.tempoRate - ((2.742857142857143 / 8) / 0.5)) < 1e-9);
  assert.equal(root.playbackRate, 1, '原调枝粒内不移调');
  assert.ok(low.playbackRate < root.playbackRate);
  assert.ok(high.playbackRate > root.playbackRate);
  assert.deepEqual(JUNGLE_PITCH_SEMITONES, [-7, -3, 0, 3, 7]);
});

test('Jungle：所有音高严格占一个双速拍，时值不随 pitch 变化', () => {
  const slices = JUNGLE_PITCH_SEMITONES.map((_, pitchBranchId) => (
    jungleSliceForCell({ pitchBranchId, stepIndex: 15, tension: 0.8 })
  ));
  assert.deepEqual(new Set(slices.map((slice) => slice.outputSeconds)), new Set([0.5]));
  assert.ok(slices.every((slice) => slice.amenStep === 31));
  assert.equal(jungleSliceForCell({ masterBpm: 50 }).outputSeconds, 0.6);
  assert.equal(jungleSliceForCell({ masterBpm: 90 }).outputSeconds, 1 / 3,
    'Master 90 / Jungle 180 仍严格是一个 Jungle 拍');
  assert.doesNotThrow(() => jungleSliceForCell({ stepIndex: undefined, pitchBranchId: Number.NaN }));
});

test('Jungle：Amen 原生 8 拍长度随 Master tempo 重采样到下一步', () => {
  const slow = jungleSliceForCell({
    pitchBranchId: 2, masterBpm: 50, amenDurationSeconds: 4, amenNativeBeats: 8,
  });
  const fast = jungleSliceForCell({
    pitchBranchId: 2, masterBpm: 90, amenDurationSeconds: 4, amenNativeBeats: 8,
  });
  assert.equal(slow.playbackRate, 1, '原调颗粒不因 tempo 改变音高');
  assert.equal(fast.playbackRate, 1, '原调颗粒不因 tempo 改变音高');
  assert.ok(Math.abs(slow.tempoRate - (0.5 / 0.6)) < 1e-9);
  assert.ok(Math.abs(fast.tempoRate - (0.5 / (1 / 3))) < 1e-9);
  for (const slice of [slow, fast]) {
    const grains = jungleGrainPlan(slice);
    const last = grains.at(-1);
    assert.ok(Math.abs(last.sourceOffset + last.sourceTimelineDuration - 0.5) < 1e-9,
      '无论 tempo 都完整映射 Amen 原生一拍');
  }
});

test('Jungle：不同音高枝共用同一输出时间轴，只改颗粒内移调', () => {
  const slices = [0, 2, 4].map((pitchBranchId) => jungleSliceForCell({
    pitchBranchId, masterBpm: 70, amenDurationSeconds: 4, amenNativeBeats: 8,
  }));
  const plans = slices.map((slice) => jungleGrainPlan(slice));
  const timelines = plans.map((plan) => plan.map((grain) => [
    grain.outputOffset, grain.outputDuration, grain.sourceOffset, grain.sourceTimelineDuration,
  ]));
  assert.deepEqual(timelines[1], timelines[0]);
  assert.deepEqual(timelines[2], timelines[0]);
  for (const plan of plans) {
    assert.ok(plan.every((grain) => Math.abs(
      grain.sourceDuration / grain.playbackRate - grain.outputDuration,
    ) < 1e-9), '每个移调颗粒的实际输出时值不变');
  }
  assert.ok(plans[0][0].playbackRate < plans[1][0].playbackRate);
  assert.ok(plans[2][0].playbackRate > plans[1][0].playbackRate);
});

test('Jungle 音高覆盖沿用 roleDiversity 字段兼容旧评分契约', () => {
  assert.equal(jungleRoleDiversity([
    { pitchBranchId: 0, stepIndex: 0 },
    { pitchBranchId: 1, stepIndex: 4 },
    { pitchBranchId: 2, stepIndex: 8 },
  ]), 1);
  assert.equal(jungleRoleDiversity([
    { pitchBranchId: 0, stepIndex: 0 },
    { pitchBranchId: 0, stepIndex: 4 },
    { pitchBranchId: 0, stepIndex: 8 },
  ]), 1 / 3);
});
