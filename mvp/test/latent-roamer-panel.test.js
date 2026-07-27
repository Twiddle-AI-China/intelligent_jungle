// 音色林地面板：改成常驻侧栏后的三条回归。
//
// 1. open() 是异步的（decoder-status + 地图 JSON 两跳），而调用方 refreshMixControls
//    在黎明/切焦点/mute 时都会同步触发 —— 必须有 token 守卫，否则先发起的那次
//    await 返回后会把旧声部的 map 写进已属于新声部的面板。
// 2. 面板不再是模态遮罩，doc 级 Space/Escape 必须限定在 roamer 焦点域内，
//    否则会吃掉全站按钮的键盘激活，并和两层返回语义抢焦点。
// 3. 坐标读数是 aria-live 区域，不能每帧无条件写。
//
// 本仓库零依赖、无 jsdom，所以手搓最小 DOM 双。innerHTML 不做真解析：
// 面板模板是固定的，直接按 latent-roamer 会查询的选择器登记桩节点。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLatentRoamer } from '../src/ui/latent-roamer-legacy.js';

const PANEL_SELECTORS = [
  '.roamer-canvas', '[data-mode="knn"]', '[data-mode="pca"]', '.roamer-k-row',
  '.roamer-k', '.roamer-k-v', '.roamer-dims', '.roamer-dims-body',
  '.roamer-dims-zero', '.roamer-hold', '.roamer-close', '.roamer-live',
];
// 产品表面已删掉 kNN/PCA/k/高阶维控件，这些选择器在真实 DOM 里就是 null。
const PRESENT_SELECTORS = new Set(['.roamer-canvas', '.roamer-hold', '.roamer-close', '.roamer-live']);

function makeCtx2d() {
  const noop = () => {};
  return {
    canvas: null,
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, fill: noop,
    ellipse: noop, arc: noop, rect: noop, fillRect: noop, strokeRect: noop,
    fillText: noop, setLineDash: noop, clearRect: noop, closePath: noop,
    createPattern: () => null, putImageData: noop,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left',
  };
}

function makeElement(doc, tag) {
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    parentNode: null,
    children: [],
    dataset: {},
    disabled: false,
    hidden: false,
    title: '',
    tabIndex: 0,
    width: 300, height: 240,
    clientWidth: 300, clientHeight: 240,
    style: {},
    classList: {
      _set: new Set(),
      add(...xs) { xs.forEach((x) => this._set.add(x)); },
      remove(...xs) { xs.forEach((x) => this._set.delete(x)); },
      toggle(x, force) {
        const on = force == null ? !this._set.has(x) : !!force;
        if (on) this._set.add(x); else this._set.delete(x);
        return on;
      },
      contains(x) { return this._set.has(x); },
    },
    _stubs: new Map(),
    _textWrites: 0,
    _text: '',
    get textContent() { return this._text; },
    set textContent(value) { this._text = String(value); this._textWrites += 1; },
    set innerHTML(_html) {
      // 固定模板：按真实实现会查询的选择器登记桩节点。
      for (const selector of PANEL_SELECTORS) {
        if (!PRESENT_SELECTORS.has(selector)) { this._stubs.set(selector, null); continue; }
        const stub = makeElement(doc, selector === '.roamer-canvas' ? 'canvas' : 'span');
        stub.className = selector.replace(/^\./, '');
        stub.parentNode = this;
        this._stubs.set(selector, stub);
      }
    },
    get innerHTML() { return ''; },
    querySelector(selector) { return this._stubs.get(selector) ?? null; },
    querySelectorAll() { return []; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      child.parentNode = null;
      return child;
    },
    contains(other) {
      for (let cur = other; cur; cur = cur.parentNode) if (cur === this) return true;
      return false;
    },
    setAttribute() {}, getAttribute() { return null; },
    getContext() { const c = makeCtx2d(); c.canvas = node; return c; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 240 }; },
    setPointerCapture() {},
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    dispatch(type, event) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
    listenerCount(type) { return (listeners.get(type) ?? []).length; },
  };
  return node;
}

/** 把 latent-roamer 需要的全局都换成可控双，返回 restore()。 */
function installEnvironment() {
  const doc = {
    documentElement: {},
    body: null,
    _listeners: new Map(),
    createElement(tag) { return makeElement(doc, tag); },
    addEventListener(type, fn) {
      const list = doc._listeners.get(type) ?? [];
      list.push(fn);
      doc._listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      doc._listeners.set(type, (doc._listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    dispatch(type, event) {
      for (const fn of [...(doc._listeners.get(type) ?? [])]) fn(event);
    },
  };
  doc.body = makeElement(doc, 'body');

  const saved = {
    window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    fetch: globalThis.fetch,
  };

  const frames = new Map();
  let frameId = 0;
  globalThis.requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.window = {
    devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {},
  };

  const flushFrames = (count = 1) => {
    for (let i = 0; i < count; i += 1) {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, fn] of pending) fn();
    }
  };

  return {
    doc,
    flushFrames,
    setFetch(impl) { globalThis.fetch = impl; },
    restore() { Object.assign(globalThis, saved); },
  };
}

function makeAudio() {
  const calls = [];
  return {
    calls,
    roamTo(species, position, k) { calls.push({ species, position: [...position], k }); return true; },
    roamToPCA() { return true; },
    roamRow() { return 0; },
    previewHold() { return true; },
    previewRelease() {},
    isNeural() { return true; },
  };
}

const mapFor = (scale) => ({
  scale,
  points: Array.from({ length: 8 }, (_, i) => ({ x: (i - 4) * scale * 0.1, y: 0 })),
});

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test('并发 open：先发起的地图晚到也不得写进新声部的面板', async () => {
  const env = installEnvironment();
  try {
    const audio = makeAudio();
    const roamer = createLatentRoamer({ audio, doc: env.doc });

    let releasePad = null;
    env.setFetch(async (url) => {
      if (String(url).includes('pad')) {
        await new Promise((resolve) => { releasePad = resolve; });
        return jsonResponse(mapFor(10)); // pad 的坐标尺度是 melody 的 10 倍
      }
      return jsonResponse(mapFor(1));
    });

    const padOpen = roamer.open('pad', { assetUrl: '/pad.json', side: 'left' });
    const melodyOpen = roamer.open('melody', { assetUrl: '/melody.json', side: 'right' });
    await melodyOpen;
    releasePad();
    await padOpen;

    assert.equal(roamer.currentSpecies(), 'melody', '面板归属最后一次 open');

    const overlay = env.doc.body.children[env.doc.body.children.length - 1];
    const panel = overlay.children[0];
    const canvas = panel.querySelector('.roamer-canvas');
    canvas.dispatch('keydown', { key: 'ArrowRight', shiftKey: false, preventDefault() {} });

    const last = audio.calls[audio.calls.length - 1];
    assert.equal(last.species, 'melody');
    // melody 的 scale=1 → 0.025；若迟到的 pad map（scale=10）污染了状态则是 0.25。
    assert.ok(Math.abs(last.position[0] - 0.025) < 1e-9,
      `坐标必须来自 melody 的地图，实得 ${last.position[0]}`);
    roamer.close();
  } finally {
    env.restore();
  }
});

test('close 后迟到的 open 不复活面板，也不叠第二条 RAF 循环', async () => {
  const env = installEnvironment();
  try {
    const audio = makeAudio();
    const roamer = createLatentRoamer({ audio, doc: env.doc });
    let release = null;
    env.setFetch(async () => {
      await new Promise((resolve) => { release = resolve; });
      return jsonResponse(mapFor(1));
    });

    const pending = roamer.open('pad', { assetUrl: '/pad.json' });
    roamer.close();
    assert.equal(roamer.isOpen(), false);
    release();
    await pending;

    assert.equal(roamer.isOpen(), false, '迟到的地图不得让已关闭的面板复活');
    assert.equal(env.doc.body.children.length, 0, 'overlay 已从 DOM 摘除');
    env.flushFrames(3); // 若真叠了循环，这里会因 canvas/ctx 为 null 抛错
  } finally {
    env.restore();
  }
});

test('Space/Escape 只在 roamer 焦点域内生效，不劫持全站按钮', async () => {
  const env = installEnvironment();
  try {
    const roamer = createLatentRoamer({ audio: makeAudio(), doc: env.doc });
    env.setFetch(async () => jsonResponse(mapFor(1)));
    await roamer.open('pad', { assetUrl: '/pad.json' });
    assert.equal(roamer.isOpen(), true);

    // 页面上任意一个按钮拿着焦点时按空格：必须放行给按钮自己的激活语义。
    const outsideButton = env.doc.createElement('button');
    env.doc.body.appendChild(outsideButton);
    let prevented = 0;
    env.doc.dispatch('keydown', {
      code: 'Space', target: outsideButton, preventDefault() { prevented += 1; },
    });
    assert.equal(prevented, 0, 'Space 不得被 roamer 吞掉');
    assert.equal(roamer.isOpen(), true);

    env.doc.dispatch('keydown', {
      code: 'Escape', target: outsideButton, preventDefault() { prevented += 1; },
    });
    assert.equal(prevented, 0, 'Esc 留给「先释放 USER、再回 overview」的两层返回');
    assert.equal(roamer.isOpen(), true, '焦点在面板外时 Esc 不关闭音色林地');

    // 焦点确实在面板内时，两个键都照常工作。
    const overlay = env.doc.body.children[0];
    const canvas = overlay.children[0].querySelector('.roamer-canvas');
    env.doc.dispatch('keydown', {
      code: 'Escape', target: canvas, preventDefault() { prevented += 1; },
    });
    assert.equal(prevented, 1);
    assert.equal(roamer.isOpen(), false);
  } finally {
    env.restore();
  }
});

test('坐标读数是 aria-live 区域：只在变化时写，且不随每帧重绘刷屏', async () => {
  const env = installEnvironment();
  try {
    const roamer = createLatentRoamer({ audio: makeAudio(), doc: env.doc });
    env.setFetch(async () => jsonResponse(mapFor(1)));
    await roamer.open('pad', { assetUrl: '/pad.json' });

    const overlay = env.doc.body.children[0];
    const panel = overlay.children[0];
    const live = panel.querySelector('.roamer-live');
    const canvas = panel.querySelector('.roamer-canvas');

    const afterOpen = live._textWrites;
    assert.ok(afterOpen >= 1, 'open 后应有一次初始读数');

    env.flushFrames(60); // 一秒的重绘，光标没动
    assert.equal(live._textWrites, afterOpen, '内容不变就不碰 DOM');

    canvas.dispatch('keydown', { key: 'ArrowUp', shiftKey: false, preventDefault() {} });
    assert.equal(live._textWrites, afterOpen + 1, '键盘步进立即更新，不受节流影响');
    assert.match(live.textContent, /X -?\d+\.\d{3} · Y -?\d+\.\d{3}/);

    env.flushFrames(60);
    assert.equal(live._textWrites, afterOpen + 1, '之后仍然只在变化时写');
    roamer.close();
  } finally {
    env.restore();
  }
});
