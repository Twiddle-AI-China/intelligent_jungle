import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLatentMapRepository } from '../../src/latent/map-repository.js';

const ASSET_ROOT = new URL('../../../assets/timbre/voice_maps/', import.meta.url);

test('voice mapping and public DTO hide worker internals', () => {
  const repository = createLatentMapRepository({ assetRoot: ASSET_ROOT });
  const internal = repository.getInternal('melody');
  assert.equal(internal.assetVoice, 'lead');
  assert.equal(internal.extent, 0.78);
  assert.equal(internal.points.length, 45);
  assert.equal(Object.isFrozen(internal), true);

  const publicMap = repository.getPublicMap('melody', {
    mode: 'xy', cursor: { x: 0.2, y: -0.3, pca: [] }, neighbors: [1, 2],
  });
  assert.deepEqual(Object.keys(publicMap), [
    'voice', 'points', 'range', 'pcaDimensions', 'pcaRanges', 'cursor', 'neighbors',
  ]);
  assert.equal(publicMap.voice, 'melody');
  assert.deepEqual(Object.keys(publicMap.points[0]), ['id', 'x', 'y']);
  assert.equal(publicMap.points[0].x, internal.points[0].x / internal.scale);
  const pcaMap = repository.getPublicMap('melody', {
    mode: 'pca', cursor: { x: 0, y: 0, pca: [] },
  });
  assert.equal(pcaMap.points[0].x, internal.points[0].px);
  assert.equal(Object.isFrozen(publicMap), true);
  const json = JSON.stringify([publicMap, pcaMap]);
  for (const forbidden of ['row', 'checkpointStep', 'basis', '"z"', 'assetRoot', 'configHash']) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
});

test('repository rejects unavailable voices and corrupt maps fail closed', async () => {
  const repository = createLatentMapRepository({ assetRoot: ASSET_ROOT });
  assert.throws(() => repository.getInternal('texture'), /LATENT_VOICE_UNAVAILABLE/);
  assert.throws(() => repository.getInternal('../bass'), /LATENT_VOICE_UNAVAILABLE/);
  assert.throws(() => repository.getInternal('toString'), /LATENT_VOICE_UNAVAILABLE/);

  const directory = await mkdtemp(join(tmpdir(), 'flock-latent-map-'));
  await writeFile(join(directory, 'bass.json'), JSON.stringify({
    schema: 1, voice: 'bass', dim: 2, scale: 1,
    points: [{ id: 'a', x: 0, y: 0, px: Number.NaN, py: 0 }],
    z: [[0, 0]],
  }));
  const corrupt = createLatentMapRepository({ assetRoot: directory });
  assert.throws(() => corrupt.getInternal('bass'), /LATENT_MAP_INVALID/);
});

test('current bass, pad, and melody assets retain frozen golden metadata', () => {
  const repository = createLatentMapRepository({ assetRoot: ASSET_ROOT });
  assert.deepEqual(['bass', 'pad', 'melody'].map((voice) => {
    const map = repository.getInternal(voice);
    return [voice, map.assetVoice, map.points.length, map.pca_basis.dims, map.extent, map.k];
  }), [
    ['bass', 'bass', 44, 10, 0.72, 4],
    ['pad', 'pad', 46, 8, 0.72, 4],
    ['melody', 'lead', 45, 10, 0.78, 4],
  ]);
});
