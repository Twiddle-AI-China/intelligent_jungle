import assert from 'node:assert/strict';
import test from 'node:test';

import { ecologicalRelations } from '../../src/latent/relations.js';
import { LATENT_ECOLOGY_CONFIG } from '../../src/latent/voice-config.js';

test('ecological relations preserve the eight normalized observable values', () => {
  const tree = {
    id: 'bass-tree', species: 'bass', branches: new Array(5).fill({}),
    birds: [
      { state: 'perched', branchId: 0, energy: 1, dwellBeatTime: 8, switchesUsed: 4, activeToday: true },
      { state: 'flying', branchId: 4, energy: 0, dwellBeatTime: 99, switchesUsed: 4, activeToday: false },
    ],
  };
  const snapshot = {
    trees: [tree, {
      id: 'pad-tree', species: 'pad',
      birds: [{ state: 'flying' }, { state: 'perched' }],
    }, {
      id: 'texture-tree', species: 'texture',
      birds: [{ state: 'flying' }],
    }],
  };
  assert.deepEqual(ecologicalRelations(tree, snapshot, LATENT_ECOLOGY_CONFIG), [
    0.5, 0.5, 0, 0, 1, 0.5, 0.5, 0.5,
  ]);
});

test('relations clamp corrupt and non-finite observations without admitting texture', () => {
  const tree = {
    id: 'melody-tree', species: 'melody', branches: [],
    birds: [{ state: 'perched', branchId: Number.NaN, energy: Infinity, dwellBeatTime: -3, switchesUsed: 99 }],
  };
  const values = ecologicalRelations(tree, { trees: [tree] }, LATENT_ECOLOGY_CONFIG);
  assert.equal(values.length, 8);
  assert.equal(values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1), true);
});
