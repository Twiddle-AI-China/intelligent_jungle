import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CONFIG } from '../src/config.js';
import { VIEW_CONFIG } from '../src/view-config.js';

test('view config is an immutable exact projection of renderer inputs', () => {
  assert.deepEqual(VIEW_CONFIG.tempo, CONFIG.tempo);
  assert.equal(VIEW_CONFIG.tree.trunkHeight, CONFIG.tree.trunkHeight);
  assert.deepEqual(VIEW_CONFIG.trees, CONFIG.trees.map(({
    id, species, treeAsset, birdAsset, mirror,
  }) => ({ id, species, treeAsset, birdAsset, ...(mirror ? { mirror } : {}) })));
  for (const key of Object.keys(VIEW_CONFIG.visual)) {
    assert.deepEqual(VIEW_CONFIG.visual[key], CONFIG.visual[key], key);
  }
  assert.equal(Object.isFrozen(VIEW_CONFIG), true);
  assert.equal(Object.isFrozen(VIEW_CONFIG.visual.singleTree.branchNoteAnchors.pad[0]), true);
});

test('view config production source does not import the domain config', async () => {
  const source = await readFile(new URL('../src/view-config.js', import.meta.url), 'utf8');
  assert.equal(source.includes("from './config.js'"), false);
});
