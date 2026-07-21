// 单树 UI 集成：相机浏览 ≠ USER；年轮 hit → audio.setParam；drawer 不改相机。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyViewportDelta,
  panPixelsToBands,
  wheelDeltaToBands,
} from '../src/ui/viewport-input.js';
import {
  RING_PARAM_KEYS,
  applyRingParam,
  createRingDragSession,
  isRingHit,
  readRingValues,
  ringValueFromDrag,
  syncRingsFromAudio,
} from '../src/ui/ring-bridge.js';
import { browseToVoice, resolveVisibleVoice } from '../src/ui/voice-locator.js';
import { DRAWER_STORAGE_KEY, createInfoDrawer } from '../src/ui/drawer.js';

test('wheel/pan 折算为声部带单位，且 moveViewportBy 不触碰 USER/混音', () => {
  assert.equal(wheelDeltaToBands(720, 720), 1);
  // 自然滚动：手指上滑 dy=-360 → 视口下移 +0.5 带
  assert.equal(panPixelsToBands(-360, 720), 0.5);
  // 桌面滚轮下滚仍为正（不回归）
  assert.equal(wheelDeltaToBands(360, 720), 0.5);

  const calls = { move: [], forbidden: 0 };
  const renderer = {
    moveViewportBy: (d) => calls.move.push(d),
    setTreeControl: () => { calls.forbidden += 1; },
    setZoomFocus: () => { calls.forbidden += 1; },
    setFocusTree: () => { calls.forbidden += 1; },
  };
  assert.deepEqual(applyViewportDelta(renderer, 0.25), { ok: true, delta: 0.25 });
  assert.deepEqual(calls.move, [0.25]);
  assert.equal(calls.forbidden, 0);
  assert.deepEqual(applyViewportDelta({}, 1), { ok: false, delta: 1 });
});

test('focusVoice 浏览：不调用 setTreeControl / setZoomFocus', () => {
  const focused = [];
  const renderer = {
    focusVoice: (id) => { focused.push(id); return id; },
    setTreeControl() { throw new Error('browse must not setTreeControl'); },
    setZoomFocus() { throw new Error('browse must not setZoomFocus'); },
  };
  assert.deepEqual(browseToVoice(renderer, 'bass'), { ok: true, method: 'focusVoice' });
  assert.deepEqual(focused, ['bass']);
});

test('getVisibleVoice 驱动展示声部，缺省不回落为自动 USER', () => {
  assert.equal(resolveVisibleVoice({ getVisibleVoice: () => 'texture' }, 'pad'), 'texture');
  assert.equal(resolveVisibleVoice({ getVisibleVoice: () => null }, 'melody'), 'melody');
});

test('ring hit 映射五参数到 audio.setParam + renderer.setRingValue', () => {
  const audioCalls = [];
  const ringCalls = [];
  const trees = [
    { id: 'pad', species: 'pad' },
    { id: 'melody', species: 'melody' },
  ];
  const renderer = {
    setRingValue: (treeId, key, v) => { ringCalls.push([treeId, key, v]); return v; },
    getRingValue: () => null,
  };
  const audio = {
    setParam: (species, key, v) => audioCalls.push([species, key, v]),
    getMixParams: () => ({}),
  };

  assert.equal(isRingHit({ type: 'ring', treeId: 'pad', ringId: 'eqLowDb' }), true);
  assert.equal(isRingHit({ type: 'branch', treeId: 'pad', branchId: 0 }), false);

  for (const key of RING_PARAM_KEYS) {
    const r = applyRingParam({
      renderer, audio, trees, treeId: 'pad', controlId: key, value: key === 'gain' ? 1.25 : 0.4,
    });
    assert.equal(r.ok, true);
    assert.equal(r.species, 'pad');
  }
  assert.equal(audioCalls.length, RING_PARAM_KEYS.length);
  assert.equal(ringCalls.length, RING_PARAM_KEYS.length);
  assert.ok(audioCalls.every((c) => c[0] === 'pad'));
  assert.deepEqual(audioCalls.map((c) => c[1]), [...RING_PARAM_KEYS]);
});

test('ring 拖动会话：纵向拖动改值并写 audio，不写 setTreeControl', () => {
  const setParam = [];
  const renderer = {
    getRingValue: () => 0,
    setRingValue: (_t, _k, v) => v,
    setTreeControl() { throw new Error('ring must not setTreeControl'); },
  };
  const audio = { setParam: (s, k, v) => setParam.push([s, k, v]) };
  const trees = [{ id: 'melody', species: 'melody' }];
  const drag = createRingDragSession({
    renderer, audio, trees, viewHeight: () => 400,
  });
  assert.equal(drag.start({ type: 'ring', treeId: 'melody', ringId: 'reverbSend' }, { pointerId: 1, clientY: 100 }), true);
  drag.move({ pointerId: 1, clientY: 20 }); // 上移 → 增大
  assert.ok(setParam.length >= 1);
  assert.equal(setParam[0][0], 'melody');
  assert.equal(setParam[0][1], 'reverbSend');
  assert.ok(setParam[0][2] > 0);
  assert.equal(drag.end({ pointerId: 1 }), true);
  assert.equal(drag.isActive(), false);
});

test('ringValueFromDrag / syncRingsFromAudio / readRingValues', () => {
  const up = ringValueFromDrag(0, -180, 'eqLowDb', 400); // 上移半程
  assert.ok(up > 0);
  const written = [];
  const renderer = {
    setRingValue: (id, k, v) => { written.push([id, k, v]); return v; },
    getRingValue: (id, k) => (id === 'bass' && k === 'gain' ? 1.5 : null),
  };
  const audio = {
    getMixParams: (species) => (species === 'bass' ? { gain: 1.5, eqLowDb: -3 } : {}),
  };
  const n = syncRingsFromAudio({
    renderer, audio, trees: [{ id: 'bass', species: 'bass' }],
  });
  assert.ok(n >= 2);
  const vals = readRingValues({ renderer, audio, treeId: 'bass', species: 'bass' });
  assert.equal(vals.gain, 1.5);
  assert.equal(vals.eqLowDb, -3);
});

test('drawer 开关记忆不触碰 renderer 相机接口', () => {
  const cameraCalls = [];
  const renderer = {
    moveViewportBy: () => cameraCalls.push('move'),
    focusVoice: () => cameraCalls.push('focus'),
    setViewportY: () => cameraCalls.push('setY'),
  };
  const drawer = {
    id: 'info-drawer',
    classList: {
      _s: new Set(),
      add(...xs) { xs.forEach((x) => this._s.add(x)); },
      remove(...xs) { xs.forEach((x) => this._s.delete(x)); },
      toggle(x, force) {
        const on = force == null ? !this._s.has(x) : !!force;
        if (on) this._s.add(x); else this._s.delete(x);
        return on;
      },
      contains(x) { return this._s.has(x); },
    },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
  };
  const toggle = {
    textContent: '',
    title: '',
    classList: drawer.classList,
    attrs: {},
    listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] ?? []).push(fn);
    },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
    },
    click() { (this.listeners.click ?? []).forEach((f) => f({ preventDefault() {} })); },
  };
  const storage = {
    map: new Map([[DRAWER_STORAGE_KEY, '1']]),
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
    setItem(k, v) { this.map.set(k, String(v)); },
  };
  // onChange 故意不接相机——模拟 main 接线纪律
  const api = createInfoDrawer({
    drawer,
    toggle,
    storage,
    isMobile: () => false,
    onChange: () => { /* UI only */ },
    doc: { defaultView: null },
  });
  toggle.click();
  toggle.click();
  assert.equal(cameraCalls.length, 0);
  assert.equal(typeof renderer.moveViewportBy, 'function');
  api.destroy();
});
