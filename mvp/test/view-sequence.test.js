import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  defaultViewSequenceDimensions,
  sequencePlayheadForViewTree,
} from '../src/view-sequence.js';

test('view sequence dimensions derive step geometry without domain imports', () => {
  assert.deepEqual(defaultViewSequenceDimensions(), {
    pitchBranchCount: 5, stepCount: 16,
  });
  assert.deepEqual(defaultViewSequenceDimensions({
    pitchBranchCount: 7, barsPerDay: 3, beatsPerBar: 5,
  }), { pitchBranchCount: 7, stepCount: 15 });
});

test('view playhead respects supplied non-default dimensions and texture rate', () => {
  const dimensions = defaultViewSequenceDimensions({ barsPerDay: 2, beatsPerBar: 3 });
  assert.deepEqual(sequencePlayheadForViewTree({
    phase: 0.5, treeId: 'pad', species: 'pad',
  }, dimensions), { stepIndex: 3, stepProgress: 0, normalizedPhase: 0.5 });
  assert.deepEqual(sequencePlayheadForViewTree({
    phase: 0.5, treeId: 'texture', species: 'texture',
  }, dimensions), { stepIndex: 0, stepProgress: 0, normalizedPhase: 0.5 });
});

test('view sequence source has no domain sequence dependency', async () => {
  const source = await readFile(new URL('../src/view-sequence.js', import.meta.url), 'utf8');
  assert.equal(source.includes("from './sequence.js'"), false);
});
