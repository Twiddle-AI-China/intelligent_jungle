const DEFAULT_VIEW_HALF = 0.84;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Fit one model's asymmetric raw XY bounds into the shared visual viewport. */
export function createMapTransform(points, viewHalf = DEFAULT_VIEW_HALF) {
  const raw = points.map((point) => ({ x: finite(point.x), y: finite(point.y) }));
  const xs = raw.length ? raw.map((point) => point.x) : [0];
  const ys = raw.length ? raw.map((point) => point.y) : [0];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const halfSpan = {
    x: Math.max(1e-6, (maxX - minX) / 2),
    y: Math.max(1e-6, (maxY - minY) / 2),
  };
  const fittedHalf = Math.max(0.1, Math.min(0.95, finite(viewHalf)));

  function toView(point) {
    return {
      x: (finite(point.x) - center.x) / halfSpan.x * fittedHalf,
      y: (finite(point.y) - center.y) / halfSpan.y * fittedHalf,
    };
  }

  function toMap(point) {
    return {
      x: center.x + finite(point.x) / fittedHalf * halfSpan.x,
      y: center.y + finite(point.y) / fittedHalf * halfSpan.y,
    };
  }

  function distanceSquared(first, second) {
    const a = toMap(first);
    const b = toMap(second);
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  }

  return Object.freeze({ center, halfSpan, viewHalf: fittedHalf, toView, toMap, distanceSquared });
}
