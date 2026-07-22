#!/usr/bin/env node
import { comparisonRows, DEFAULT_DAYS, DEFAULT_SEED, runEvaluation } from './harness.js';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const seed = option('seed', DEFAULT_SEED);
const days = option('days', DEFAULT_DAYS);
const result = runEvaluation({ seed, days });
const rows = comparisonRows(result);

console.log(`Latent Cosmos headless evaluation · seed=${seed} · days=${days}`);
console.table(rows.map((row) => ({
  metric: row.metric,
  R: row.R,
  C: row.C,
  F: row.F,
  'F-R': row.FminusR,
  'F-C': row.FminusC,
  '机制闸门': row.expectation,
  结果: row.passed ? 'PASS' : 'FAIL',
})));
console.log('\nDiagnostics (lower conflict/grid error is better; blank is descriptive):');
console.table(['R', 'C', 'F'].map((tier) => ({
  tier,
  events: result.tiers[tier].eventCount,
  'H variance': result.tiers[tier].metrics.harmonyVariance,
  behaviorVariance: result.tiers[tier].metrics.behaviorVariance,
  gridErrorBeats: result.tiers[tier].metrics.rhythmGridErrorBeats,
  conflictRatio: result.tiers[tier].metrics.conflictRatio,
  blankRatio: result.tiers[tier].metrics.blankRatio,
  same: result.tiers[tier].metrics.sameRatio,
  step: result.tiers[tier].metrics.stepRatio,
  leap: result.tiers[tier].metrics.leapRatio,
  melStep: result.tiers[tier].metrics.melodyStepRatio,
  melLeap: result.tiers[tier].metrics.melodyLeapRatio,
  bassOnsets: result.tiers[tier].metrics.bassOnsetCountMean,
  bassRegularity: result.tiers[tier].metrics.bassIntervalRegularityMean,
  bassCohortP90: result.tiers[tier].metrics.bassCohortP90Mean,
  bassCohortPeak: result.tiers[tier].metrics.bassCohortPeakMean,
  survivalBoundary: result.tiers[tier].metrics.survivalBoundaryShare,
  survivalCorrelation: result.tiers[tier].metrics.survivalMaxAbsCorrelation,
  survivalDelta: result.tiers[tier].metrics.survivalMeanAbsDelta,
  survivalRange: `${result.tiers[tier].metrics.survivalMinValue}..${result.tiers[tier].metrics.survivalMaxValue}`,
})));

// T0.3 可听口径（真实发声）：物理列见上方主表；具身因果损失 = 可听 vs mapping 契约的偏差。
console.log('\nAudible 真实发声口径（T0.3；embodiment 越低=栖枝与发声越一致）:');
console.table(['R', 'C', 'F'].map((tier) => ({
  tier,
  'H 均值·可听': result.tiers[tier].metrics.harmonyMeanAudible,
  'H 稳定·可听': result.tiers[tier].metrics.harmonyConsistencyAudible,
  '音高运动·可听': result.tiers[tier].metrics.pitchMotionScoreAudible,
  stepAudible: result.tiers[tier].metrics.stepRatioAudible,
  leapAudible: result.tiers[tier].metrics.leapRatioAudible,
  '具身损失(半音)': result.tiers[tier].metrics.embodimentLossMeanSemitones,
  '偏差时长占比': result.tiers[tier].metrics.embodimentDeviationShare,
  pad损失: result.tiers[tier].metrics.embodimentMeanPad,
  bass损失: result.tiers[tier].metrics.embodimentMeanBass,
})));
console.log('audibleModes:', ['R', 'C', 'F']
  .map((tier) => `${tier}=${JSON.stringify(result.tiers[tier].audibleModes)}`).join('  '));
const failures = rows.filter((row) => !row.passed);
console.log(failures.length
  ? `\nVerdict: mechanism gates FAILED; ${failures.map((row) => `${row.metric}(${row.expectation})`).join(', ')}`
  : '\nVerdict: all mechanism-specific gates passed; R remains diagnostic only.');

if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
