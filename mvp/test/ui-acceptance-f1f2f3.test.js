// 验收 F1/F2/F3 + O1/O2/O3：真实尺寸约定、触控自然滚动、枝群接管、键盘吸附。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PAN_THRESHOLD_PX,
  adjacentVoiceId,
  attachViewportInput,
  panPixelsToBands,
  resolveCanvasTapAction,
  snapKeyboardBrowse,
  wheelDeltaToBands,
} from '../src/ui/viewport-input.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');

test('F1：#scene 用 calc 填满 HUD 以下，禁止 height:auto 固有 150px', () => {
  const block = indexHtml.match(/#scene\s*\{([^}]*)\}/s)?.[1] ?? '';
  const decls = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(decls, /height:\s*calc\(100%\s*-\s*var\(--hud-h\)\)/);
  assert.match(decls, /top:\s*var\(--hud-h\)/);
  assert.equal(/height:\s*auto\b/.test(decls), false);
});

test('F2：#scene 声明 touch-action:none', () => {
  assert.match(indexHtml, /#scene\s*\{[^}]*touch-action:\s*none/s);
});

test('F2/O3：触控自然滚动（上滑看下）与桌面 wheel 符号不冲突', () => {
  // 手指上滑
  assert.ok(panPixelsToBands(-100, 400) > 0);
  // 手指下滑
  assert.ok(panPixelsToBands(100, 400) < 0);
  // 滚轮下滚仍为正（桌面不回归）
  assert.ok(wheelDeltaToBands(100, 400) > 0);
  assert.equal(wheelDeltaToBands(400, 400), 1);
  assert.equal(panPixelsToBands(-400, 400), 1);
});

test('F3：AGENT 点 branch/bird → takeoverOnly；USER 才 place/shoo；tree 仍 toggle', () => {
  assert.deepEqual(
    resolveCanvasTapAction({ type: 'branch', treeId: 'melody', branchId: 2 }, false),
    { action: 'takeoverOnly', treeId: 'melody' },
  );
  assert.deepEqual(
    resolveCanvasTapAction({ type: 'bird', treeId: 'bass', birdId: 3, branchId: 5 }, false),
    { action: 'takeoverOnly', treeId: 'bass' },
  );
  assert.deepEqual(
    resolveCanvasTapAction({ type: 'branch', treeId: 'melody', branchId: 2 }, true),
    { action: 'place', treeId: 'melody', branchId: 2 },
  );
  assert.deepEqual(
    resolveCanvasTapAction({ type: 'bird', treeId: 'pad', birdId: 1 }, true),
    { action: 'shoo', treeId: 'pad', birdId: 1 },
  );
  assert.deepEqual(
    resolveCanvasTapAction({ type: 'tree', treeId: 'texture' }, false),
    { action: 'toggleFocus', treeId: 'texture' },
  );
});

test('O1：键盘吸附相邻声部（非相对步进），从任意可见声部一次到位', () => {
  const focused = [];
  const renderer = {
    getVisibleVoice: () => 'pad',
    focusVoice: (id) => { focused.push(id); return id; },
    moveViewportBy: () => { throw new Error('键盘路径不应用相对 moveViewportBy'); },
  };
  const r = snapKeyboardBrowse(renderer, 1);
  assert.equal(r.ok, true);
  assert.equal(r.voiceId, 'melody');
  assert.equal(r.method, 'focusVoice');
  assert.deepEqual(focused, ['melody']);
  assert.equal(adjacentVoiceId('bass', -1), 'melody');
  assert.equal(adjacentVoiceId('texture', 1), 'texture');
});

test('O2：定位器提示样式避免窄栏逐字换行（nowrap）', () => {
  assert.match(indexHtml, /\.voice-locator-hint\s*\{[^}]*white-space:\s*nowrap/s);
});

test('F2 事件级：pointercancel 结束 pan 且不触发 tap；touch-action 写入 canvas', () => {
  const listeners = new Map();
  const style = { touchAction: '' };
  const canvas = {
    style,
    clientHeight: 668,
    height: 668,
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  const moves = [];
  const taps = [];
  const renderer = {
    hitTest: () => null,
    moveViewportBy: (d) => moves.push(d),
  };
  const api = attachViewportInput({
    canvas,
    renderer,
    canvasPoint: () => ({ x: 10, y: 10 }),
    onTap: (hit) => taps.push(hit),
  });
  assert.equal(style.touchAction, 'none');

  const down = listeners.get('pointerdown')[0];
  const move = listeners.get('pointermove')[0];
  const cancel = listeners.get('pointercancel')[0];
  down({ pointerId: 7, button: 0, clientY: 200 });
  move({ pointerId: 7, clientY: 200 - (PAN_THRESHOLD_PX + 20) }); // 上滑
  assert.ok(moves.length >= 1, '应产生视口移动');
  assert.ok(moves[0] > 0, '上滑应为正 delta（自然滚动）');
  cancel({ pointerId: 7, type: 'pointercancel' });
  assert.equal(taps.length, 0, 'pointercancel 不得触发 tap');

  // 短点仍可 tap
  down({ pointerId: 8, button: 0, clientY: 100 });
  const up = listeners.get('pointerup')[0];
  up({ pointerId: 8, type: 'pointerup' });
  assert.equal(taps.length, 1);

  api.destroy();
});
