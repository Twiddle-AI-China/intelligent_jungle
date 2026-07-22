// 单树 UI：左侧声部定位器 — 浏览不切 USER；相机接口存在性保护。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_ORDER,
  browseToVoice,
  browseVoiceByDelta,
  createVoiceLocator,
  resolveVisibleVoice,
} from '../src/ui/voice-locator.js';

test('browseToVoice：优先 focusVoice；缺失时 ok=false 且不抛', () => {
  const calls = [];
  const r = {
    focusVoice: (id) => calls.push(id),
    setTreeControl: () => { throw new Error('不得调用 setTreeControl'); },
    setZoomFocus: () => { throw new Error('不得调用 setZoomFocus'); },
    toggleFocusTree: () => { throw new Error('不得调用 toggleFocusTree'); },
  };
  assert.deepEqual(browseToVoice(r, 'bass'), { ok: true, method: 'focusVoice' });
  assert.deepEqual(calls, ['bass']);
  assert.deepEqual(browseToVoice({}, 'pad'), { ok: false, method: null });
  assert.deepEqual(browseToVoice(null, 'pad'), { ok: false, method: null });
});

test('browseVoiceByDelta：优先 moveViewportBy；否则 focusVoice 相邻声部', () => {
  const moved = [];
  const focused = [];
  const withMove = {
    moveViewportBy: (d) => moved.push(d),
    focusVoice: (id) => focused.push(id),
  };
  const a = browseVoiceByDelta(withMove, 'pad', 1, VOICE_ORDER);
  assert.equal(a.method, 'moveViewportBy');
  assert.equal(a.voiceId, 'melody');
  assert.deepEqual(moved, [1]);

  const onlyFocus = { focusVoice: (id) => focused.push(id) };
  const b = browseVoiceByDelta(onlyFocus, 'melody', -1, VOICE_ORDER);
  assert.equal(b.method, 'focusVoice');
  assert.equal(b.voiceId, 'pad');
  assert.ok(focused.includes('pad'));

  const none = browseVoiceByDelta({}, 'bass', 1, VOICE_ORDER);
  assert.equal(none.ok, false);
  assert.equal(none.voiceId, 'texture');
});

test('resolveVisibleVoice：仅 getVisibleVoice → fallback，不回落 getFocusTree', () => {
  assert.equal(resolveVisibleVoice({ getVisibleVoice: () => 'texture' }), 'texture');
  assert.equal(resolveVisibleVoice({
    getVisibleVoice: () => null,
    getFocusTree: () => 'bass',
  }, 'melody'), 'melody');
  assert.equal(resolveVisibleVoice({ getFocusTree: () => 'bass' }, 'pad'), 'pad');
});

test('resolveVisibleVoice：overview 不伪装成某个声部', () => {
  assert.equal(resolveVisibleVoice({
    getCameraMode: () => 'overview',
    getVisibleVoice: () => 'pad',
  }, 'pad'), null);
});

function mockDoc() {
  const createElement = (tag) => {
    const classSet = new Set();
    const attrs = {};
    const listeners = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      type: '',
      className: '',
      textContent: '',
      title: '',
      dataset: {},
      children,
      classList: {
        add: (...xs) => {
          xs.forEach((x) => classSet.add(x));
          el.className = [...classSet].join(' ');
        },
        remove: (...xs) => {
          xs.forEach((x) => classSet.delete(x));
          el.className = [...classSet].join(' ');
        },
        toggle: (x, force) => {
          const on = force == null ? !classSet.has(x) : !!force;
          if (on) classSet.add(x); else classSet.delete(x);
          el.className = [...classSet].join(' ');
          return on;
        },
        contains: (x) => classSet.has(x),
      },
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k] ?? null; },
      addEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      removeEventListener(type, fn) {
        listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
      },
      appendChild(child) { children.push(child); return child; },
      click() {
        for (const fn of listeners.get('click') ?? []) fn({ preventDefault() {} });
      },
      _listeners: listeners,
      _attrs: attrs,
    };
    return el;
  };
  return { createElement };
}

test('createVoiceLocator：点击浏览回调且不依赖接管接口', () => {
  const doc = mockDoc();
  const root = doc.createElement('nav');
  root.innerHTML = '';
  Object.defineProperty(root, 'innerHTML', {
    set() { root.children.length = 0; },
    get() { return ''; },
  });
  const browsed = [];
  const renderer = {
    focusVoice: (id) => browsed.push(['focus', id]),
    getVisibleVoice: () => 'pad',
    setTreeControl() { throw new Error('browse must not setTreeControl'); },
    setZoomFocus() { throw new Error('browse must not setZoomFocus'); },
  };
  const loc = createVoiceLocator({
    root,
    renderer,
    doc,
    onBrowse: (id, meta) => browsed.push(['cb', id, meta.method]),
  });
  assert.equal(loc.getActive(), 'pad');

  // 找到 bass 按钮并点击
  const list = root.children.find((c) => c.className === 'voice-locator-list')
    ?? root.children[1];
  const bassBtn = list.children.find((b) => b.dataset.voice === 'bass');
  assert.ok(bassBtn);
  bassBtn.click();
  assert.equal(loc.getActive(), 'bass');
  assert.ok(browsed.some((x) => x[0] === 'focus' && x[1] === 'bass'));
  assert.ok(browsed.some((x) => x[0] === 'cb' && x[1] === 'bass'));
  assert.equal(bassBtn.getAttribute('aria-pressed'), 'true');
  loc.destroy();
});

test('createVoiceLocator：无 document 时安全 no-op', () => {
  const loc = createVoiceLocator({ root: {}, doc: null });
  assert.equal(loc.getActive(), 'pad');
  loc.setActive('bass', { browse: true });
  loc.refresh();
  loc.destroy();
});
