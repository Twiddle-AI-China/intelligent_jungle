import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { beatPulseFromPhase, resolveBirdFacing, visualDayFactorFromPhase } from '../src/renderer.js';

function next(previous, x, overrides = {}) {
  return resolveBirdFacing(previous, {
    state: 'flying',
    x,
    rootX: 100,
    deadZone: 1,
    confirmationFrames: 2,
    ...overrides,
  });
}

test('飞鸟朝向忽略死区内抖动，并持久保持上一次方向', () => {
  let state = next(null, 40);
  assert.equal(state.facing, 1);
  state = next(state, 40.7);
  assert.equal(state.facing, 1);
  state = next(state, 40.1);
  assert.equal(state.facing, 1);
  assert.equal(state.candidateFacing, null);
});

test('飞鸟仅在连续两帧确认反向运动后翻转', () => {
  let state = next(null, 50);
  state = next(state, 53);
  assert.equal(state.facing, 1);

  state = next(state, 50);
  assert.equal(state.facing, 1, '第一帧反向位移只记录候选方向');
  state = next(state, 47);
  assert.equal(state.facing, -1, '连续第二帧反向位移才真正翻转');

  state = next(state, 48);
  assert.equal(state.facing, -1, '单帧反向位移不能再次翻转');
  state = next(state, 47.5);
  assert.equal(state.facing, -1, '死区内位移会取消候选翻转');
});

test('栖鸟始终朝树干，静止时保持已有朝向', () => {
  const leftOfTrunk = resolveBirdFacing(null, { state: 'perched', x: 70, rootX: 100 });
  assert.equal(leftOfTrunk.facing, 1);
  const rightOfTrunk = resolveBirdFacing(leftOfTrunk, { state: 'perched', x: 130, rootX: 100 });
  assert.equal(rightOfTrunk.facing, -1);
  const centered = resolveBirdFacing(rightOfTrunk, { state: 'perched', x: 100, rootX: 100 });
  assert.equal(centered.facing, -1);
});

test('视觉昼夜在整日四个象限内分段线性变化', () => {
  assert.equal(visualDayFactorFromPhase(0), 0.5);
  assert.equal(visualDayFactorFromPhase(0.125), 0.75);
  assert.equal(visualDayFactorFromPhase(0.25), 1);
  assert.equal(visualDayFactorFromPhase(0.5), 0.5);
  assert.equal(visualDayFactorFromPhase(0.75), 0);
  assert.equal(visualDayFactorFromPhase(0.875), 0.25);
  assert.equal(visualDayFactorFromPhase(1), 0.5);
});

test('正拍脉冲快速衰减，且小节第一拍强于普通拍', () => {
  const tempo = { barsPerDay: 4, beatsPerBar: 4 };
  assert.equal(beatPulseFromPhase(0, tempo), 1);
  assert.equal(beatPulseFromPhase(1 / 16, tempo), 0.58);
  assert.ok(beatPulseFromPhase(0.03 / 16, tempo) < 1);
  assert.ok(beatPulseFromPhase(0.03 / 16, tempo) > beatPulseFromPhase(0.08 / 16, tempo));
  assert.ok(CONFIG.visual.beatFlashAlpha >= 0.08, '完整场景亮闪需达到可感知强度');
});

test('日月直接使用 Linux Antiquity 第三方 SVG，且保持弱背景比例', () => {
  assert.match(CONFIG.visual.celestialAssets.sun, /linux-antiquity\/sun\.svg$/);
  assert.match(CONFIG.visual.celestialAssets.moon, /linux-antiquity\/moon\.svg$/);
  assert.ok(CONFIG.visual.celestialRadiusRatio <= 0.055);
  assert.ok(CONFIG.visual.sunAlpha <= 0.4);
  assert.ok(CONFIG.visual.moonAlpha <= 0.35);
});

test('四季背景使用项目自有塔罗 SVG，并只消费 ink/accent 两种绘制色', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entries = Object.entries(CONFIG.visual.backgroundAssets);
  assert.deepEqual(entries.map(([season]) => season), ['spring', 'summer', 'autumn', 'winter']);
  for (const [season, asset] of entries) {
    assert.match(asset, /^assets\/tarot\/bg-(spring|summer|autumn|winter)\.svg$/);
    const svg = fs.readFileSync(path.join(root, asset), 'utf8');
    assert.match(svg, /viewBox="0 0 1600 1000"/);
    assert.doesNotMatch(svg, /<image\b|\.jpe?g|\.png/i, `${season} 不得内嵌写实位图`);
    const colors = [...svg.matchAll(/#[0-9A-Fa-f]{6}/g)].map((match) => match[0].toUpperCase());
    assert.ok(colors.length > 0);
    assert.ok(colors.every((color) => ['#2E3E8F', '#E75C26'].includes(color)), `${season} 只允许 ink/accent`);
  }
});
