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
  'F≥C≥R': row.ordered ? 'YES' : `NO ${row.inversion}`,
})));
console.log('\nDiagnostics (lower conflict/grid error is better; blank is descriptive):');
console.table(['R', 'C', 'F'].map((tier) => ({
  tier,
  events: result.tiers[tier].eventCount,
  "H' variance": result.tiers[tier].metrics.harmonyVariance,
  behaviorVariance: result.tiers[tier].metrics.behaviorVariance,
  gridErrorBeats: result.tiers[tier].metrics.rhythmGridErrorBeats,
  conflictRatio: result.tiers[tier].metrics.conflictRatio,
  blankRatio: result.tiers[tier].metrics.blankRatio,
  same: result.tiers[tier].metrics.sameRatio,
  step: result.tiers[tier].metrics.stepRatio,
  leap: result.tiers[tier].metrics.leapRatio,
  melStep: result.tiers[tier].metrics.melodyStepRatio,
  melLeap: result.tiers[tier].metrics.melodyLeapRatio,
})));
const inversions = rows.filter((row) => !row.ordered);
console.log(inversions.length
  ? `\nVerdict: NOT fully ordered; ${inversions.map((row) => `${row.metric}(${row.inversion})`).join(', ')}`
  : '\nVerdict: all primary metrics satisfy F ≥ C ≥ R.');

if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
