// mvp/test/renderer-layout.test.js —— legacy 2×2 兼容导出（computeTreeLayout）回归套件。
// 注意：运行时渲染自单树重构起使用 scene-layout.js 的 computeSceneLayout；
// 运行时布局/相机/年轮/命中的验收测试在 scene-layout.test.js，本文件只锁定兼容导出行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { computeTreeLayout } from '../src/renderer.js';

function overlaps(a, b) {
  return a.cellX < b.cellX + b.cellWidth && a.cellX + a.cellWidth > b.cellX
    && a.cellY < b.cellY + b.cellHeight && a.cellY + a.cellHeight > b.cellY;
}

test('legacy 2×2：四张树贴图按显式 row/col 占满四象限且互不重叠', () => {
  const layout = computeTreeLayout(CONFIG.trees, 1280, 800);
  assert.deepEqual(layout.map(({ row, col }) => [row, col]), [[0, 0], [0, 1], [1, 0], [1, 1]]);
  for (let left = 0; left < layout.length; left += 1) {
    for (let right = left + 1; right < layout.length; right += 1) {
      assert.equal(overlaps(layout[left], layout[right]), false, `${layout[left].id}/${layout[right].id} 不应重叠`);
    }
  }
});

test('legacy 2×2：窄窗口 resize 后贴图矩形与树根仍在各自格内', () => {
  const layout = computeTreeLayout(CONFIG.trees, 520, 640);
  for (const tree of layout) {
    assert.ok(tree.spriteSize > 0);
    assert.ok(tree.spriteX >= tree.cellX && tree.spriteX + tree.spriteSize <= tree.cellX + tree.cellWidth);
    assert.ok(tree.spriteY >= tree.cellY && tree.spriteY + tree.spriteSize <= tree.cellY + tree.cellHeight);
    assert.ok(tree.rootX > tree.cellX && tree.rootX < tree.cellX + tree.cellWidth);
    assert.ok(tree.rootY > tree.cellY && tree.rootY < tree.cellY + tree.cellHeight);
  }
  assert.ok(layout[0].cellX + layout[0].cellWidth < layout[1].cellX);
  assert.ok(layout[0].cellY + layout[0].cellHeight < layout[2].cellY);
});

test('legacy 2×2：每棵树五个贴图锚点由低到高，并准确映射归一化坐标与镜像', () => {
  const layouts = computeTreeLayout(CONFIG.trees, 1280, 800);
  layouts.forEach((layout, treeIndex) => {
    const tree = CONFIG.trees[treeIndex];
    assert.equal(tree.branchAnchors.length, 5);
    assert.equal(layout.branchPoints.length, 5);
    for (let branchId = 0; branchId < 5; branchId += 1) {
      const anchor = tree.branchAnchors[branchId];
      const point = layout.branchPoints[branchId];
      const expectedX = layout.spriteX + (tree.mirror ? 1 - anchor.x : anchor.x) * layout.spriteSize;
      const expectedY = layout.spriteY + anchor.y * layout.spriteSize;
      assert.ok(Math.abs(point.x - expectedX) < 1e-9);
      assert.ok(Math.abs(point.y - expectedY) < 1e-9);
      assert.ok(point.x >= layout.spriteX && point.x <= layout.spriteX + layout.spriteSize);
      if (branchId > 0) assert.ok(point.y < layout.branchPoints[branchId - 1].y, `${tree.id} 枝号越高应越高`);
    }
  });
});

test('legacy 2×2：四树均登记独立 GPT 树/鸟 PNG 与双姿态裁切框', () => {
  for (const tree of CONFIG.trees) {
    assert.match(tree.treeAsset, new RegExp(`tree-${tree.species}\\.png$`));
    assert.match(tree.birdAsset, new RegExp(`bird-${tree.species}\\.png$`));
    for (const pose of ['perched', 'flying']) {
      const frame = tree.birdFrames[pose];
      assert.ok(frame.x >= 0 && frame.y >= 0 && frame.w > 0 && frame.h > 0);
      assert.ok(frame.x + frame.w <= 1 && frame.y + frame.h <= 1);
    }
  }
});

test('legacy 2×2：缺 layout/锚点时仍有四象限与五层兼容兜底，不因素材异常白屏', () => {
  const fallback = computeTreeLayout([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], 800, 600);
  assert.deepEqual(fallback.map(({ row, col }) => [row, col]), [[0, 0], [0, 1], [1, 0], [1, 1]]);
  assert.ok(fallback.every((tree) => tree.branchPoints.length === 5));
});

test('legacy 2×2：特写 focusTreeId 焦点树主舞台更大，其余缩边缘', () => {
  const layout = computeTreeLayout(CONFIG.trees, 1280, 800, { focusTreeId: 'melody' });
  assert.equal(layout[0].id, 'melody');
  assert.ok(layout[0].focused);
  assert.ok(layout.slice(1).every((tree) => !tree.focused));
  assert.ok(layout[0].cellWidth > layout[1].cellWidth);
  assert.ok(layout[0].spriteSize > layout[1].spriteSize);
});

test('legacy 2×2：四树都只有五条音高枝，无 runner 特例', () => {
  const layouts = computeTreeLayout(CONFIG.trees, 1280, 800);
  assert.ok(layouts.every((tree) => tree.branchPoints.length === 5));
  assert.ok(layouts.every((tree) => !('runnerPoints' in tree)));
});
