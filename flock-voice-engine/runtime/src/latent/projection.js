function clamp(value, low = -1, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function cursorXY(cursor) {
  if (!cursor || typeof cursor !== 'object'
    || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) {
    throw new Error('LATENT_CURSOR_INVALID');
  }
  return { x: clamp(cursor.x), y: clamp(cursor.y) };
}

function mapPoints(map) {
  if (!map || !Number.isFinite(map.scale) || map.scale <= 0
    || !Array.isArray(map.points) || map.points.length === 0
    || map.points.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
    throw new Error('LATENT_MAP_INVALID');
  }
  return map.points;
}

export function projectRelationsToXY(relations, projection = {}) {
  if (!Array.isArray(relations) || relations.length !== 8
    || relations.some((value) => !Number.isFinite(value))) {
    throw new Error('LATENT_RELATIONS_INVALID');
  }
  const matrix = projection.matrix;
  if (!Array.isArray(matrix) || matrix.length !== 2
    || matrix.some((axis) => !Array.isArray(axis) || axis.length !== 8
      || axis.some((value) => !Number.isFinite(value)))) {
    throw new Error('LATENT_PROJECTION_INVALID');
  }
  const extent = Number(projection.extent);
  if (!Number.isFinite(extent) || extent < 0 || extent > 1) {
    throw new Error('LATENT_PROJECTION_INVALID');
  }
  const centered = relations.map((value) => clamp(value, 0, 1) * 2 - 1);
  const projected = matrix.map((weights, axis) => {
    const denominator = weights.reduce((sum, weight) => sum + Math.abs(weight), 0) || 1;
    const bias = Number(projection.bias?.[axis]) || 0;
    const value = centered.reduce((sum, input, index) => sum + input * weights[index], 0);
    return clamp(bias + (value / denominator) * extent, -extent, extent);
  });
  return Object.freeze({ x: projected[0], y: projected[1] });
}

export function findNeighbors(map, cursor, k) {
  const points = mapPoints(map);
  const position = cursorXY(cursor);
  if (!Number.isSafeInteger(k) || k <= 0 || k > points.length) {
    throw new Error('LATENT_K_INVALID');
  }
  return Object.freeze(points.map((point, index) => ({
    index,
    id: point.id,
    distance: Math.hypot(
      point.x / map.scale - position.x,
      point.y / map.scale - position.y,
    ),
  })).sort((left, right) => left.distance - right.distance || left.index - right.index)
    .slice(0, k).map(Object.freeze));
}

export function xyIntent(map, cursor, k) {
  if (!Number.isFinite(map?.scale) || map.scale <= 0) throw new Error('LATENT_MAP_INVALID');
  const position = cursorXY(cursor);
  const neighbors = findNeighbors(map, position, k).map(({ index }) => index);
  return Object.freeze({
    mode: 'xy',
    xy: Object.freeze([position.x * map.scale, position.y * map.scale]),
    k,
    neighbors: Object.freeze(neighbors),
  });
}

export function pcaIntent(map, cursor) {
  const position = cursorXY(cursor);
  const pca = map?.pca_basis;
  if (!pca || !Number.isSafeInteger(pca.dims) || pca.dims < 2
    || !Array.isArray(pca.ranges) || pca.ranges.length < pca.dims) {
    throw new Error('LATENT_PCA_UNAVAILABLE');
  }
  if (!Array.isArray(cursor.pca) || cursor.pca.length > pca.dims - 2
    || cursor.pca.some((value) => !Number.isFinite(value))) {
    throw new Error('LATENT_PCA_DIMENSION_INVALID');
  }
  const normalized = [position.x, position.y, ...cursor.pca];
  const coeffs = [];
  for (let index = 0; index < pca.dims; index += 1) {
    const value = index < normalized.length ? normalized[index] : 0;
    const range = pca.ranges[index];
    if (!Number.isFinite(value) || !Number.isFinite(range?.p5) || !Number.isFinite(range?.p95)) {
      throw new Error('LATENT_CURSOR_INVALID');
    }
    const bounded = clamp(value);
    coeffs.push(bounded < 0 ? -bounded * range.p5 : bounded * range.p95);
  }
  return Object.freeze({ mode: 'pca', coeffs: Object.freeze(coeffs) });
}
