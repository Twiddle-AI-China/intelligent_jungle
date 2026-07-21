import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonRows, runEvaluation, runTier } from '../eval/harness.js';

test('headless evaluation is bit-for-bit reproducible for the same seed', () => {
  const first = runEvaluation({ seed: 20260720, days: 3 });
  const second = runEvaluation({ seed: 20260720, days: 3 });
  assert.deepEqual(second, first);
});

test('R/C/F expose finite event-derived metrics and comparison deltas', () => {
  const result = runEvaluation({ seed: 17, days: 3 });
  for (const tier of ['R', 'C', 'F']) {
    assert.equal(result.tiers[tier].days, 3);
    assert.ok(result.tiers[tier].eventCount > 0);
    for (const value of Object.values(result.tiers[tier].metrics)) {
      assert.ok(Number.isFinite(value));
    }
  }
  const rows = comparisonRows(result);
  assert.equal(rows.length, 9);
  assert.ok(rows.every((row) => Number.isFinite(row.FminusR) && Number.isFinite(row.FminusC)));
  assert.ok(rows.every((row) => typeof row.expectation === 'string' && typeof row.passed === 'boolean'));
});

test('机制闸门不再把随机档偶然高分误判为产品失败', () => {
  const result = runEvaluation({ seed: 20260721, days: 16 });
  const rows = comparisonRows(result);
  assert.ok(rows.every((row) => row.passed), rows.filter((row) => !row.passed)
    .map((row) => `${row.metric}:${row.expectation}`).join(', '));
  assert.ok(result.tiers.F.metrics.bassOnsetCountMean > 0);
  assert.ok(result.tiers.F.metrics.bassCohortPeakMean >= result.tiers.F.metrics.bassCohortP90Mean);
});

test('unknown evaluation tier is rejected', () => {
  assert.throws(() => runTier('X', { days: 1 }), /unknown tier/);
});
