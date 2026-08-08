import test from 'node:test';
import assert from 'node:assert/strict';

import { WanderMotion } from '../web/wander-motion.js';

test('wander speed directly controls distance without creating any pitch state', () => {
  const slow = new WanderMotion(() => 0);
  const fast = new WanderMotion(() => 0);
  slow.reset({ x: 0, y: 0 }, 0);
  fast.reset({ x: 0, y: 0 }, 0);
  const slowPoint = slow.step({ x: 0, y: 0 }, 100, { speed: 0.2, turnRate: 0 });
  const fastPoint = fast.step({ x: 0, y: 0 }, 100, { speed: 0.8, turnRate: 0 });
  assert.ok(fastPoint.x > slowPoint.x * 3.9);
  assert.equal(slowPoint.y, 0);
});

test('random-turn rate can reverse direction while zero keeps a straight path', () => {
  const values = [0, 0, 1];
  const turning = new WanderMotion(() => values.shift() ?? 0);
  turning.reset({ x: 0, y: 0 }, 0);
  const point = turning.step({ x: 0, y: 0 }, 100, { speed: 0.5, turnRate: 20 });
  assert.ok(point.x < 0);
});

test('wander reflects at map boundaries', () => {
  const motion = new WanderMotion(() => 0);
  motion.reset({ x: 0.87, y: 0 }, 0);
  const edge = motion.step({ x: 0.87, y: 0 }, 100, {
    speed: 1,
    turnRate: 0,
    boundary: 0.88,
  });
  const reflected = motion.step(edge, 200, { speed: 1, turnRate: 0, boundary: 0.88 });
  assert.equal(edge.x, 0.88);
  assert.ok(reflected.x < edge.x);
});
