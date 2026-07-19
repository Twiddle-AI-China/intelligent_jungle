// mvp/test/renderer-layout.test.js —— 渲染器树布局纯函数：N 树（≥2）数据驱动排布。
// 契约：xOffset/mirror/drawScale 全部来自 config.trees（快照透传），渲染器不发明布局。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTreeLayout } from '../src/renderer.js';

const V = { treeHeightRatio: 0.72 };
const IMG = { w: 1536, h: 1024 }; // tree-alpha.png 实际尺寸
const W = 1280;
const H = 800;

const TWO_TREES = [
  { id: 'pad', xOffset: -0.22, mirror: false, drawScale: 1.0 },
  { id: 'melody', xOffset: 0.22, mirror: true, drawScale: 0.94 },
];
const FOUR_TREES = [
  { id: 'bass', xOffset: -0.33, mirror: false, drawScale: 0.9 },
  { id: 'pad', xOffset: -0.11, mirror: true, drawScale: 0.86 },
  { id: 'melody', xOffset: 0.11, mirror: false, drawScale: 0.82 },
  { id: 'texture', xOffset: 0.33, mirror: true, drawScale: 0.78 },
];

test('N 树布局：数量与顺序完全跟随输入（2 树与 4 树）', () => {
  for (const trees of [TWO_TREES, FOUR_TREES]) {
    const layout = computeTreeLayout(trees, W, H, V, IMG.w, IMG.h);
    assert.equal(layout.length, trees.length);
    assert.deepEqual(layout.map((l) => l.id), trees.map((t) => t.id));
  }
});

test('锚点 = 画布中心 + xOffset×画布高，四树锚点全在画布内且按 xOffset 升序', () => {
  const layout = computeTreeLayout(FOUR_TREES, W, H, V, IMG.w, IMG.h);
  for (let i = 0; i < FOUR_TREES.length; i += 1) {
    assert.equal(layout[i].anchorPx, W / 2 + FOUR_TREES[i].xOffset * H);
    assert.ok(layout[i].anchorPx >= 0 && layout[i].anchorPx <= W, `树 ${layout[i].id} 锚点越界`);
    if (i > 0) assert.ok(layout[i].anchorPx > layout[i - 1].anchorPx, '锚点顺序应与 xOffset 一致');
  }
});

test('drawScale 生效且缺省为 1：绘制尺寸 = 贴图 × H×treeHeightRatio×drawScale/imgH', () => {
  const layout = computeTreeLayout([
    { id: 'a', xOffset: 0 },
    { id: 'b', xOffset: 0.1, drawScale: 0.5 },
  ], W, H, V, IMG.w, IMG.h);
  const base = (H * V.treeHeightRatio) / IMG.h;
  assert.equal(layout[0].scale, base);
  assert.equal(layout[1].scale, base * 0.5);
  assert.equal(layout[0].dh, H * V.treeHeightRatio);
  assert.equal(layout[1].dw, IMG.w * base * 0.5);
});

test('mirror 标志透传（缺省 false）', () => {
  const layout = computeTreeLayout(FOUR_TREES, W, H, V, IMG.w, IMG.h);
  assert.deepEqual(layout.map((l) => l.mirror), [false, true, false, true]);
});
