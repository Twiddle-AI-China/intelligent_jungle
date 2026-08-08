import test from 'node:test';
import assert from 'node:assert/strict';

import { createMapTransform } from '../web/map-transform.js';

test('each asymmetric map fills both visual axes independently', () => {
  const transform = createMapTransform([
    { x: 10, y: -2 },
    { x: 30, y: 2 },
    { x: 24, y: 0 },
  ]);
  assert.deepEqual(transform.toView({ x: 10, y: -2 }), { x: -0.84, y: -0.84 });
  assert.deepEqual(transform.toView({ x: 30, y: 2 }), { x: 0.84, y: 0.84 });
});

test('visual cursor round-trips to the exact model map coordinate', () => {
  const transform = createMapTransform([
    { x: 4, y: -8 },
    { x: 16, y: 2 },
  ]);
  const raw = { x: 12.25, y: -3.75 };
  const restored = transform.toMap(transform.toView(raw));
  assert.ok(Math.abs(restored.x - raw.x) < 1e-12);
  assert.ok(Math.abs(restored.y - raw.y) < 1e-12);
});

test('neighbor distances remain those of the raw model map after visual fitting', () => {
  const transform = createMapTransform([
    { x: 0, y: 0 },
    { x: 100, y: 2 },
  ]);
  const first = transform.toView({ x: 45, y: 0.4 });
  const second = transform.toView({ x: 48, y: 1.4 });
  assert.ok(Math.abs(transform.distanceSquared(first, second) - 10) < 1e-12);
});
