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
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => Number.isFinite(row.FminusR) && Number.isFinite(row.FminusC)));
});

test('unknown evaluation tier is rejected', () => {
  assert.throws(() => runTier('X', { days: 1 }), /unknown tier/);
});
