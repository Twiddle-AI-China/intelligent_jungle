import test from 'node:test';
import assert from 'node:assert/strict';
import {
  comparisonRows,
  embodimentSemitoneDistance,
  runEvaluation,
  runTier,
} from '../eval/harness.js';

test('PAD 具身度量允许最近八度连接，但不放过错枝或其它声部的错音区', () => {
  assert.equal(embodimentSemitoneDistance('pad', 72, 60), 0);
  assert.equal(embodimentSemitoneDistance('pad', 73, 60), 1);
  assert.equal(embodimentSemitoneDistance('pad', 71, 60), 1);
  assert.equal(embodimentSemitoneDistance('bass', 72, 60), 12);
});

test('headless evaluation is bit-for-bit reproducible for the same seed', () => {
  const first = runEvaluation({ seed: 20260720, days: 3 });
  const second = runEvaluation({ seed: 20260720, days: 3 });
  assert.deepEqual(second, first);
});

test('R/C/F-noSequence/F expose finite event-derived metrics and comparison deltas', () => {
  const result = runEvaluation({ seed: 17, days: 3 });
  for (const tier of ['R', 'C', 'F-noSequence', 'F']) {
    assert.equal(result.tiers[tier].days, 3);
    assert.ok(result.tiers[tier].eventCount > 0);
    for (const value of Object.values(result.tiers[tier].metrics)) {
      assert.ok(Number.isFinite(value));
    }
  }
  const rows = comparisonRows(result);
  assert.equal(rows.length, 13);
  assert.ok(rows.every((row) => Number.isFinite(row.FminusR) && Number.isFinite(row.FminusC)));
  assert.ok(rows.every((row) => typeof row.expectation === 'string' && typeof row.passed === 'boolean'));
});

test('机制闸门不再把随机档偶然高分误判为产品失败', () => {
  const result = runEvaluation({ seed: 20260721, days: 16 });
  const rows = comparisonRows(result);
  assert.ok(rows.every((row) => row.passed), rows.filter((row) => !row.passed)
    .map((row) => `${row.metric}:${row.expectation}`).join(', '));
  assert.ok(result.tiers.F.metrics.bassOnsetCountMean > 0);
  assert.ok(result.tiers.F.metrics.activeWindowTreeMin >= 0.75);
  assert.ok(result.tiers.F.metrics.bassCohortPeakMean >= result.tiers.F.metrics.bassCohortP90Mean);
});

test('unknown evaluation tier is rejected', () => {
  assert.throws(() => runTier('X', { days: 1 }), /unknown tier/);
});
