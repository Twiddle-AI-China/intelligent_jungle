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
  assert.ok(Math.abs(Math.hypot(fastPoint.x, fastPoint.y) / Math.hypot(slowPoint.x, slowPoint.y) - 4) < 1e-9);
  assert.ok(slowPoint.y < 0);
});

test('zero random-turn rate follows a stable curved arc', () => {
  const motion = new WanderMotion(() => 0);
  motion.reset({ x: 0, y: 0 }, 0);
  const points = [{ x: 0, y: 0 }];
  for (let frame = 1; frame <= 8; frame += 1) {
    points.push(motion.step(points.at(-1), frame * 100, { speed: 0.5, turnRate: 0 }));
  }
  const headings = points.slice(1).map((point, index) => (
    Math.atan2(point.y - points[index].y, point.x - points[index].x)
  ));
  const bends = headings.slice(1).map((heading, index) => heading - headings[index]);
  assert.ok(bends.every((bend) => bend < -0.09 && bend > -0.11));
});

test('random direction changes target curvature without making a sharp corner', () => {
  const values = [0, 0, 0, 1];
  const turning = new WanderMotion(() => values.shift() ?? 0);
  turning.reset({ x: 0, y: 0 }, 0);
  const first = turning.step({ x: 0, y: 0 }, 100, { speed: 0.5, turnRate: 20 });
  const firstHeading = Math.atan2(first.y, first.x);
  const second = turning.step(first, 200, { speed: 0.5, turnRate: 0 });
  const secondHeading = Math.atan2(second.y - first.y, second.x - first.x);
  assert.ok(firstHeading < 0);
  assert.ok(Math.abs(secondHeading - firstHeading) < 0.1);

  let point = second;
  let laterHeading = secondHeading;
  for (let frame = 3; frame <= 6; frame += 1) {
    const next = turning.step(point, frame * 100, { speed: 0.5, turnRate: 0 });
    laterHeading = Math.atan2(next.y - point.y, next.x - point.x);
    point = next;
  }
  assert.ok(laterHeading > 0);
});

test('wander bends inward softly and remains inside map boundaries', () => {
  const motion = new WanderMotion(() => 0);
  motion.reset({ x: 0.82, y: 0 }, 0);
  const points = [{ x: 0.82, y: 0 }];
  for (let frame = 1; frame <= 20; frame += 1) {
    points.push(motion.step(points.at(-1), frame * 100, {
      speed: 0.7,
      turnRate: 0,
      boundary: 0.88,
    }));
  }
  assert.ok(points.every(({ x, y }) => Math.abs(x) <= 0.88 && Math.abs(y) <= 0.88));
  assert.ok(points.at(-1).x < Math.max(...points.map(({ x }) => x)) - 0.1);
});
