// mvp/test/scene-layout.test.js —— 单树纵向世界坐标、相机与年轮（§3/§4/§6 Worker A）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import {
  VOICE_ORDER, RING_RANGES,
  computeSceneLayout, computeWorldMetrics,
  clampViewportY, focusViewportY, visibleVoiceAt, voiceCenterWorldY,
} from '../src/scene-layout.js';
import { createRenderer } from '../src/renderer.js';

const W = 1280;
const H = 720;

// ---- 纯布局：世界坐标 ----

test('四声部带自上而下 pad→melody→bass→texture，带高一致且纵向连续无拼接缝', () => {
  const layouts = computeSceneLayout(CONFIG.trees, W, H);
  assert.deepEqual(layouts.map((l) => l.id), [...VOICE_ORDER]);
  const { bandHeight, margin, worldHeight } = computeWorldMetrics(H);
  assert.ok(layouts.every((l) => l.bandHeight === bandHeight));
  assert.equal(layouts[0].bandTop, margin);
  for (let i = 1; i < layouts.length; i += 1) {
    assert.equal(layouts[i].bandTop, layouts[i - 1].bandTop + bandHeight, '相邻声部带必须连续');
  }
  assert.equal(layouts.at(-1).bandTop + bandHeight, worldHeight - margin);
  // 固定 worldY 中心：同一视口尺寸下与 viewportY 无关
  const shifted = computeSceneLayout(CONFIG.trees, W, H, { viewportY: 100 });
  layouts.forEach((l, i) => assert.equal(shifted[i].worldY, l.worldY));
});

test('枝群单侧且左右交替：pad 右 / melody 左 / bass 右 / texture 左', () => {
  const layouts = computeSceneLayout(CONFIG.trees, W, H);
  const expectSide = { pad: 1, melody: -1, bass: 1, texture: -1 };
  for (const layout of layouts) {
    assert.equal(layout.side, expectSide[layout.id]);
    assert.equal(layout.branchPoints.length, 5);
    for (const point of layout.branchPoints) {
      const delta = (point.x - layout.trunkX) * layout.side;
      assert.ok(delta > 0, `${layout.id} 枝必须在树干${layout.side > 0 ? '右' : '左'}侧`);
    }
    // 枝号越高（音越高）位置越高
    for (let j = 1; j < 5; j += 1) {
      assert.ok(layout.branchPoints[j].y < layout.branchPoints[j - 1].y);
    }
  }
});

test('投影契约：screenY = worldY - viewportY，viewportY 越界被 clamp', () => {
  const vY = 137;
  const layouts = computeSceneLayout(CONFIG.trees, W, H, { viewportY: vY });
  for (const layout of layouts) {
    assert.equal(layout.screenY, layout.worldY - vY);
    assert.equal(layout.cellY, layout.bandTop - vY);
  }
  const { worldHeight } = computeWorldMetrics(H);
  assert.equal(clampViewportY(-50, H), 0);
  assert.equal(clampViewportY(1e9, H), worldHeight - H);
  assert.equal(clampViewportY(NaN, H), 0);
});

test('相机吸附：focusViewportY 使目标声部居中，visibleVoiceAt 四声部互斥可达', () => {
  for (const id of VOICE_ORDER) {
    const vY = focusViewportY(id, H);
    assert.equal(visibleVoiceAt(vY, H), id);
    // 吸附后声部中心落在视口中央
    assert.ok(Math.abs(voiceCenterWorldY(id, H) - (vY + H / 2)) < 1e-9, `${id} 应居中`);
  }
  // 连续位置（滚动中）合法：两声部之间取更近者
  const padC = voiceCenterWorldY('pad', H);
  const melodyC = voiceCenterWorldY('melody', H);
  const mid = (padC + melodyC) / 2 - H / 2;
  assert.ok(['pad', 'melody'].includes(visibleVoiceAt(mid, H)));
});

test('Bass runner 保留 5–9：五节点单侧、西→东升序、近似水平', () => {
  const layouts = computeSceneLayout(CONFIG.trees, W, H);
  const bass = layouts.find((l) => l.id === 'bass');
  assert.deepEqual(bass.runnerPoints.map((p) => p.branchId), [5, 6, 7, 8, 9]);
  for (let i = 1; i < bass.runnerPoints.length; i += 1) {
    assert.ok(bass.runnerPoints[i].x > bass.runnerPoints[i - 1].x, 'runner 节点西→东');
    assert.ok(Math.abs(bass.runnerPoints[i].y - bass.runnerPoints[0].y) < 1e-9);
    assert.ok(bass.runnerPoints[i].x > bass.trunkX, 'bass 枝群在右侧');
  }
  for (const other of layouts.filter((l) => l.id !== 'bass')) {
    assert.equal(other.runnerPoints.length, 0, '非 bass 声部无 runner 点');
  }
});

test('Bass runner 节点 x 使用 runnerAnchors 真实归一化坐标（映射到树干→枝梢区间）', () => {
  const layouts = computeSceneLayout(CONFIG.trees, W, H);
  const bass = layouts.find((l) => l.id === 'bass');
  const anchors = CONFIG.trees.find((t) => t.id === 'bass').runnerAnchors;
  assert.equal(bass.runnerPoints.length, anchors.length);
  // (x - trunkX) 与 anchor.x 成同一比例（带内跨度一致），不做等距硬编
  const ratios = bass.runnerPoints.map((p, i) => (p.x - bass.trunkX) / anchors[i].x);
  for (let i = 1; i < ratios.length; i += 1) {
    assert.ok(Math.abs(ratios[i] - ratios[0]) < 1e-9, `节点 ${i} 应按 anchor.x 等比映射`);
  }
  // 锚点间距不等则节点间距也不等（0.16 等距锚点下表现为均匀；改动锚点会反映到布局）
  const span = ratios[0];
  for (let i = 0; i < anchors.length; i += 1) {
    assert.ok(Math.abs(bass.runnerPoints[i].x - (bass.trunkX + anchors[i].x * span)) < 1e-9);
  }
});

test('每声部固定三枚年轮：EQ 三环同心 + FX + Volume，键名与混音参数对齐', () => {
  const layouts = computeSceneLayout(CONFIG.trees, W, H);
  for (const layout of layouts) {
    const ids = layout.rings.map((r) => r.controlId);
    assert.deepEqual(ids, ['eqLowDb', 'eqMidDb', 'eqHighDb', 'reverbSend', 'gain']);
    const [low, mid, high] = layout.rings;
    assert.ok(low.x === mid.x && mid.x === high.x && low.y === mid.y && mid.y === high.y, 'EQ 三环同心');
    assert.ok(low.rOuter < mid.rOuter && mid.rOuter < high.rOuter, 'EQ 内/中/外 = low/mid/high');
    for (const ring of layout.rings) {
      assert.ok(RING_RANGES[ring.controlId], `${ring.controlId} 需有值域`);
      assert.ok(ring.label, `${ring.controlId} 需有可访问名称`);
    }
  }
});

test('窄屏 390px：布局仍成立，年轮行不溢出画布', () => {
  const layouts = computeSceneLayout(CONFIG.trees, 390, 700);
  assert.equal(layouts.length, 4);
  for (const layout of layouts) {
    for (const ring of layout.rings) {
      assert.ok(ring.x - ring.rOuter >= 0 && ring.x + ring.rOuter <= 390, `${layout.id}/${ring.controlId} 溢出`);
    }
    assert.ok(layout.branchPoints.every((p) => p.x >= 0 && p.x <= 390));
  }
});

// ---- Renderer 相机 / 命中 / 年轮接口（stub canvas）----

function createStubCanvas(width = W, height = H) {
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, {
    get(target, prop) {
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
      return () => {};
    },
    set() { return true; },
  });
  return { width, height, getContext: () => context };
}

function stubSnapshot() {
  return {
    simTime: 0, daylight: 1, phase: 0.25, season: 'spring',
    trees: CONFIG.trees.map((tree) => ({ id: tree.id, birds: [] })),
    birds: [],
  };
}

test('相机接口：set/get/move/focusVoice/getVisibleVoice，滚动不切 USER', () => {
  const renderer = createRenderer(createStubCanvas(), CONFIG);
  assert.equal(renderer.getViewportY(), 0);
  assert.equal(renderer.setViewportY(1e9), clampViewportY(1e9, H));
  assert.equal(renderer.setViewportY(-5), 0);
  // moveViewportBy 以带高为单位：+1.2 下移到 melody 区
  renderer.setViewportY(0);
  renderer.moveViewportBy(1.2);
  assert.equal(renderer.getVisibleVoice(), 'melody');
  renderer.moveViewportBy(-0.7);
  assert.equal(renderer.getVisibleVoice(), 'pad');
  // focusVoice 吸附但不改变 USER 焦点
  assert.equal(renderer.getFocusTree(), null);
  assert.equal(renderer.focusVoice('texture'), 'texture');
  assert.equal(renderer.getVisibleVoice(), 'texture');
  assert.equal(renderer.getFocusTree(), null, '浏览不得切换 USER 焦点');
  assert.equal(renderer.focusVoice('nope'), null);
});

test('显式接管：setFocusTree 吸附相机到该声部并保留焦点语义', () => {
  const renderer = createRenderer(createStubCanvas(), CONFIG);
  renderer.render(stubSnapshot());
  assert.equal(renderer.setFocusTree('bass'), 'bass');
  assert.equal(renderer.getVisibleVoice(), 'bass');
  assert.equal(renderer.getFocusTree(), 'bass');
  assert.equal(renderer.toggleFocusTree('bass'), null, '再次点选释放');
  assert.equal(renderer.getFocusTree(), null);
});

test('hitTest 契约保留：branch 返回 {type,treeId,branchId}，bass runner 5–9 可命中', () => {
  const renderer = createRenderer(createStubCanvas(), CONFIG);
  const snapshot = stubSnapshot();
  renderer.render(snapshot);
  const layouts = computeSceneLayout(CONFIG.trees, W, H, { viewportY: 0 });
  const pad = layouts.find((l) => l.id === 'pad');
  const hitBranch = renderer.hitTest(pad.branchPoints[2].x, pad.branchPoints[2].y);
  assert.deepEqual(hitBranch, { type: 'branch', treeId: 'pad', branchId: 2 });
  // 树身命中（声部带空白处）
  const hitTree = renderer.hitTest(30, 700);
  assert.equal(hitTree?.type, 'tree');
  assert.equal(hitTree?.treeId, 'pad');
  // bass runner：吸附到 bass 后命中节点 5–9
  renderer.focusVoice('bass');
  renderer.render(snapshot);
  const bassLayouts = computeSceneLayout(CONFIG.trees, W, H, { viewportY: renderer.getViewportY() });
  const bass = bassLayouts.find((l) => l.id === 'bass');
  for (const point of bass.runnerPoints) {
    const hit = renderer.hitTest(point.x, point.y);
    assert.equal(hit?.type, 'branch');
    assert.equal(hit?.treeId, 'bass');
    assert.ok(hit.branchId >= 5 && hit.branchId <= 9, `runner branchId 应保持 5–9，实得 ${hit.branchId}`);
  }
});

test('hitTest 新增 ring 类型；年轮值读写 clamp 到混音参数值域', () => {
  const renderer = createRenderer(createStubCanvas(), CONFIG);
  renderer.render(stubSnapshot());
  const controls = renderer.getRingControls();
  assert.equal(controls.length, 4 * 5, '四声部 × 五控点');
  const eqLow = controls.find((c) => c.treeId === 'pad' && c.controlId === 'eqLowDb');
  assert.ok(eqLow.label && Number.isFinite(eqLow.value));
  assert.equal(eqLow.min, -12);
  assert.equal(eqLow.max, 12);
  const hit = renderer.hitTest(eqLow.x, eqLow.y);
  assert.deepEqual(hit, { type: 'ring', treeId: 'pad', ringId: 'eqLowDb' });
  // 值域 clamp：dB ±12 / reverbSend 0..1 / gain 0..2
  assert.equal(renderer.setRingValue('pad', 'eqLowDb', 99), 12);
  assert.equal(renderer.setRingValue('pad', 'reverbSend', -1), 0);
  assert.equal(renderer.setRingValue('pad', 'gain', 5), 2);
  assert.equal(renderer.getRingValue('pad', 'gain'), 2);
  assert.equal(renderer.setRingValue('pad', 'bogus', 1), null);
  assert.equal(renderer.setRingValue('bogus', 'gain', 1), null);
  // 渲染后再读，控件值已同步
  renderer.render(stubSnapshot());
  const updated = renderer.getRingControls().find((c) => c.treeId === 'pad' && c.controlId === 'gain');
  assert.equal(updated.value, 2);
});

test('EQ 同心环按最近中径命中：中环中心与低/中边界都归 eqMidDb', () => {
  const renderer = createRenderer(createStubCanvas(), CONFIG);
  renderer.render(stubSnapshot());
  const controls = renderer.getRingControls();
  const mid = controls.find((c) => c.treeId === 'pad' && c.controlId === 'eqMidDb');
  const low = controls.find((c) => c.treeId === 'pad' && c.controlId === 'eqLowDb');
  const high = controls.find((c) => c.treeId === 'pad' && c.controlId === 'eqHighDb');
  // 中环中径处
  const midR = (mid.rInner + mid.rOuter) / 2;
  assert.deepEqual(renderer.hitTest(mid.x + midR, mid.y), { type: 'ring', treeId: 'pad', ringId: 'eqMidDb' });
  // 低/中环重叠边界（±3px 容差内两环皆匹配）：中径更近者胜 → eqMidDb
  const boundary = low.rOuter; // === mid.rInner
  assert.deepEqual(renderer.hitTest(mid.x + boundary, mid.y), { type: 'ring', treeId: 'pad', ringId: 'eqMidDb' });
  // 中/高边界：中径几乎等距（0.14R vs 0.145R），按规则归 eqMidDb；高中径处才归 eqHighDb
  const boundaryHi = high.rInner; // === mid.rOuter
  assert.deepEqual(renderer.hitTest(mid.x + boundaryHi, mid.y), { type: 'ring', treeId: 'pad', ringId: 'eqMidDb' });
  const highR = (high.rInner + high.rOuter) / 2;
  assert.deepEqual(renderer.hitTest(high.x + highR, high.y), { type: 'ring', treeId: 'pad', ringId: 'eqHighDb' });
  // 内环中心仍归 eqLowDb
  assert.deepEqual(renderer.hitTest(low.x, low.y), { type: 'ring', treeId: 'pad', ringId: 'eqLowDb' });
});

test('hitTest 跳过不可见声部带：滚离后 pad 年轮/枝/树身均不可命中', () => {
  const renderer = createRenderer(createStubCanvas(), CONFIG);
  const snapshot = stubSnapshot();
  renderer.render(snapshot); // viewportY=0：pad 可见，texture 不可见
  const padEq = renderer.getRingControls().find((c) => c.treeId === 'pad' && c.controlId === 'eqLowDb');
  const textureEq = renderer.getRingControls().find((c) => c.treeId === 'texture' && c.controlId === 'eqLowDb');
  // 未滚动画布外（texture 不可见）即不可命中
  assert.equal(renderer.hitTest(textureEq.x, textureEq.y), null);
  // 滚到 texture 后 pad 离开视口：pad 年轮不再命中
  renderer.focusVoice('texture');
  renderer.render(snapshot);
  assert.equal(renderer.hitTest(padEq.x, padEq.y), null);
  // 可见的 texture 年轮正常命中
  const textureEqNow = renderer.getRingControls().find((c) => c.treeId === 'texture' && c.controlId === 'eqLowDb');
  assert.deepEqual(renderer.hitTest(textureEqNow.x, textureEqNow.y), {
    type: 'ring', treeId: 'texture', ringId: 'eqLowDb',
  });
});
