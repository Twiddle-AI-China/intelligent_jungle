import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LATENT_VOICES } from './voice-config.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function invalid() {
  throw new Error('LATENT_MAP_INVALID');
}

function validateMap(raw, config) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || raw.schema !== 1 || raw.voice !== config.assetVoice
    || !Number.isSafeInteger(raw.dim) || raw.dim <= 0
    || !finite(raw.scale) || raw.scale <= 0
    || !Array.isArray(raw.points) || raw.points.length === 0
    || !Array.isArray(raw.z) || raw.z.length !== raw.points.length) invalid();

  const ids = new Set();
  for (let index = 0; index < raw.points.length; index += 1) {
    const point = raw.points[index];
    if (!point || typeof point !== 'object' || Array.isArray(point)
      || typeof point.id !== 'string' || point.id.length === 0 || ids.has(point.id)
      || !finite(point.x) || !finite(point.y) || !finite(point.px) || !finite(point.py)
      || !Array.isArray(raw.z[index]) || raw.z[index].length !== raw.dim
      || raw.z[index].some((value) => !finite(value))) invalid();
    ids.add(point.id);
  }

  const pca = raw.pca_basis;
  if (!pca || typeof pca !== 'object' || !Number.isSafeInteger(pca.dims)
    || pca.dims <= 0 || pca.dims > raw.dim
    || !Array.isArray(pca.basis) || pca.basis.length < pca.dims
    || !Array.isArray(pca.mean) || pca.mean.length !== raw.dim
    || !Array.isArray(pca.ranges) || pca.ranges.length < pca.dims
    || !Array.isArray(pca.explained) || pca.explained.length < pca.dims
    || pca.mean.some((value) => !finite(value))) invalid();
  for (let index = 0; index < pca.dims; index += 1) {
    const range = pca.ranges[index];
    if (!Array.isArray(pca.basis[index]) || pca.basis[index].length !== raw.dim
      || pca.basis[index].some((value) => !finite(value))
      || !range || !finite(range.p5) || !finite(range.p95)
      || range.p5 > 0 || range.p95 < 0 || !finite(pca.explained[index])) invalid();
  }
}

function normalizeRoot(assetRoot) {
  if (assetRoot instanceof URL) {
    if (assetRoot.protocol !== 'file:') throw new Error('LATENT_ASSET_ROOT_INVALID');
    return fileURLToPath(assetRoot);
  }
  if (typeof assetRoot !== 'string' || assetRoot.length === 0) {
    throw new Error('LATENT_ASSET_ROOT_INVALID');
  }
  return assetRoot;
}

function publicCursor(value = {}) {
  const cursor = value.cursor ?? {};
  const number = (candidate) => finite(candidate) ? Math.max(-1, Math.min(1, candidate)) : 0;
  return {
    mode: value.mode === 'pca' ? 'pca' : 'xy',
    x: number(cursor.x),
    y: number(cursor.y),
    pca: Array.isArray(cursor.pca) ? cursor.pca.map(number) : [],
  };
}

export function createLatentMapRepository({ assetRoot } = {}) {
  const root = normalizeRoot(assetRoot);
  const cache = new Map();

  function getInternal(voice) {
    if (typeof voice !== 'string' || !Object.hasOwn(LATENT_VOICES, voice)) {
      throw new Error('LATENT_VOICE_UNAVAILABLE');
    }
    const config = LATENT_VOICES[voice];
    if (cache.has(voice)) return cache.get(voice);
    let raw;
    try {
      raw = JSON.parse(readFileSync(join(root, `${config.assetVoice}.json`), 'utf8'));
      validateMap(raw, config);
    } catch (error) {
      if (error?.message === 'LATENT_MAP_INVALID') throw error;
      throw new Error('LATENT_MAP_INVALID');
    }
    const internal = deepFreeze({ ...raw, ...config });
    cache.set(voice, internal);
    return internal;
  }

  function getPublicMap(voice, state = {}) {
    const map = getInternal(voice);
    const mode = state.mode === 'pca' ? 'pca' : 'xy';
    const neighbors = Array.isArray(state.neighbors)
      ? state.neighbors.filter((index) => Number.isSafeInteger(index)
        && index >= 0 && index < map.points.length)
      : [];
    return deepFreeze({
      voice,
      points: map.points.map((point) => ({
        id: point.id,
        x: mode === 'pca' ? point.px : point.x / map.scale,
        y: mode === 'pca' ? point.py : point.y / map.scale,
      })),
      range: { x: [-1, 1], y: [-1, 1] },
      pcaDimensions: map.pca_basis.dims,
      pcaRanges: map.pca_basis.ranges.slice(0, map.pca_basis.dims).map((range, index) => ({
        p5: range.p5,
        p95: range.p95,
        explained: map.pca_basis.explained[index],
      })),
      cursor: publicCursor({ ...state, mode }),
      neighbors,
    });
  }

  return Object.freeze({ getInternal, getPublicMap });
}
