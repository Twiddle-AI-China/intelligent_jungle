import assert from 'node:assert/strict';
import test from 'node:test';

import { createLatentMapRepository } from '../../src/latent/map-repository.js';
import {
  findNeighbors,
  pcaIntent,
  projectRelationsToXY,
  xyIntent,
} from '../../src/latent/projection.js';
import { LATENT_VOICES } from '../../src/latent/voice-config.js';

const map = Object.freeze({
  scale: 10,
  points: Object.freeze([
    Object.freeze({ id: 'left', x: -10, y: 0, px: 0.7, py: 0.7 }),
    Object.freeze({ id: 'center', x: 0, y: 0, px: -0.8, py: 0.8 }),
    Object.freeze({ id: 'top', x: 0, y: 10, px: -0.7, py: -0.7 }),
  ]),
  pca_basis: Object.freeze({
    dims: 3,
    ranges: Object.freeze([
      Object.freeze({ p5: -4, p95: 6 }),
      Object.freeze({ p5: -2, p95: 8 }),
      Object.freeze({ p5: -10, p95: 20 }),
    ]),
  }),
});

test('normalized PCA uses p5 and p95 asymmetrically', () => {
  assert.deepEqual(pcaIntent(map, { x: -0.5, y: 0.5, pca: [-0.25] }).coeffs, [
    -2, 4, -2.5,
  ]);
});

test('XY scales worker coordinates and kNN uses normalized public points', () => {
  assert.deepEqual(findNeighbors(map, { x: -0.1, y: 0 }, 2), [
    { index: 1, id: 'center', distance: 0.1 },
    { index: 0, id: 'left', distance: 0.9 },
  ]);
  assert.deepEqual(xyIntent(map, { x: 2, y: -2, pca: [] }, 2), {
    mode: 'xy', xy: [10, -10], k: 2, neighbors: [1, 0],
  });
});

test('real-map kNN exactly matches worker raw XY distance', () => {
  const repository = createLatentMapRepository({
    assetRoot: new URL('../../../assets/timbre/voice_maps/', import.meta.url),
  });
  for (const voice of ['bass', 'pad', 'melody']) {
    const realMap = repository.getInternal(voice);
    const cursor = { x: 0, y: 0 };
    const actual = findNeighbors(realMap, cursor, 4).map(({ index }) => index);
    const expected = realMap.points.map((point, index) => ({
      index,
      distance: Math.hypot(point.x, point.y),
    })).sort((left, right) => left.distance - right.distance || left.index - right.index)
      .slice(0, 4).map(({ index }) => index);
    assert.deepEqual(actual, expected, voice);
  }
});

test('projection matrices and extents match the current production mapping', () => {
  const relations = [1, 0, 1, 0, 1, 0, 1, 0];
  assert.deepEqual(projectRelationsToXY(relations, LATENT_VOICES.bass.projection), {
    x: 0.3054545454545455,
    y: 0.00549618320610689,
  });
  assert.deepEqual(projectRelationsToXY(new Array(8).fill(0.5), LATENT_VOICES.pad.projection), {
    x: 0, y: 0,
  });
});

test('projection rejects invalid dimensions, values, k, and missing PCA metadata', () => {
  assert.throws(() => projectRelationsToXY([0, 1], LATENT_VOICES.bass.projection), /LATENT_RELATIONS_INVALID/);
  assert.throws(() => findNeighbors(map, { x: Number.NaN, y: 0 }, 2), /LATENT_CURSOR_INVALID/);
  assert.throws(() => findNeighbors(map, { x: 0, y: 0 }, 0), /LATENT_K_INVALID/);
  assert.throws(() => pcaIntent({ ...map, pca_basis: null }, { x: 0, y: 0, pca: [] }), /LATENT_PCA_UNAVAILABLE/);
  assert.throws(() => pcaIntent(map, { x: 0, y: 0, pca: [0, 0] }), /LATENT_PCA_DIMENSION_INVALID/);
  assert.throws(() => pcaIntent(map, { x: 0, y: 0, pca: [Number.NaN] }), /LATENT_PCA_DIMENSION_INVALID/);
});
