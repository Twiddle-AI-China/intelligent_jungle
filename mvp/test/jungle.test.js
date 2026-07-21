import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JUNGLE_ROLE_IDS,
  jungleCuePlan,
  jungleRoleDiversity,
  jungleSliceForCell,
} from '../src/jungle.js';

test('Jungle cell 一格对应一枚 dnber 32-step Amen slice，非法时间安全回落', () => {
  assert.deepEqual(jungleSliceForCell({ roleId: 0, stepIndex: 8, tension: 0 }), {
    amenStep: 0, sliceSteps: 1.35, velocity: 0.92, playbackRate: 0.9,
  });
  assert.equal(jungleSliceForCell({ roleId: 4, stepIndex: 2 }).amenStep, 30);
  assert.equal(jungleSliceForCell({ roleId: 1, stepIndex: undefined }).amenStep, 4);
  assert.doesNotThrow(() => jungleCuePlan({ stepIndex: undefined, seed: Number.NaN }));
});

test('Jungle cue 保留 kick/snare 骨架且相同 cell 可复现', () => {
  const input = { roleId: 0, stepIndex: 4, tension: 0.35, seed: 17 };
  const a = jungleCuePlan(input);
  const b = jungleCuePlan(input);
  assert.deepEqual(a, b);
  assert.ok(a.some((hit) => hit.kind === 'kick' && hit.offsetBeats === 0));
  assert.ok(a.some((hit) => hit.kind === 'snare' && [1, 3].includes(hit.offsetBeats)));
  assert.ok(a.every((hit) => hit.offsetBeats >= 0 && hit.offsetBeats < 4));
});

test('切分枝只在句末增加有限 fill，不把整日随机铺满', () => {
  const base = jungleCuePlan({ roleId: 0, stepIndex: 0, tension: 0.8, seed: 3 });
  const fill = jungleCuePlan({ roleId: 4, stepIndex: 0, tension: 0.8, seed: 3 });
  assert.ok(fill.length > base.length);
  assert.ok(fill.filter((hit) => hit.offsetBeats >= 3.5).length <= 6);
  assert.ok(fill.length < 28, '单 cue 必须保持可听留白');
});

test('鼓角色多样性按 cue 角色而不是音高评分', () => {
  assert.equal(JUNGLE_ROLE_IDS.length, 5);
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
