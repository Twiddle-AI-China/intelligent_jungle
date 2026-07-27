import {
  jungleEditPlan, jungleGrainPlan, jungleSliceForCell,
} from '../src/jungle.js';

const cases = [];
for (let stepIndex = 0; stepIndex < 16; stepIndex += 1) {
  for (let pitchBranchId = 0; pitchBranchId < 5; pitchBranchId += 1) {
    const input = {
      pitchBranchId, stepIndex, tension: 0.63, masterBpm: 72,
      tempoMultiplier: 2, amenDurationSeconds: 2.742857142857143, amenNativeBeats: 8,
    };
    const slice = jungleSliceForCell(input);
    const grainOptions = { grainSeconds: 0.1, overlap: 0.5 };
    cases.push({ input, slice, grainOptions, grains: jungleGrainPlan(slice, grainOptions) });
  }
}
const editInputs = [
  { day: 1, tension: .2, onsetCount: 2, conflictRatio: 0, patternSimilarity: .2 },
  { day: 2, tension: .8, onsetCount: 10, conflictRatio: .1, patternSimilarity: .9 },
  { day: 3, tension: .8, onsetCount: 4, conflictRatio: 0, patternSimilarity: .9 },
  { day: 4, tension: .5, onsetCount: 2, conflictRatio: 0, patternSimilarity: .2 },
];
process.stdout.write(`${JSON.stringify({ cases, edits: editInputs.map((input) => ({
  input, output: jungleEditPlan(input),
})) })}\n`);
