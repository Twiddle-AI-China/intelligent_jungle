// 单树 UI：右侧 overlay drawer — aria、Escape、localStorage、开关不改“世界”回调语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInfoDrawer, DRAWER_STORAGE_KEY } from '../src/ui/drawer.js';

function mockEl(id = '') {
  const listeners = new Map();
  const attrs = {};
  const classSet = new Set();
  const el = {
    id,
    textContent: '',
    title: '',
    classList: {
      add: (...xs) => xs.forEach((x) => classSet.add(x)),
      remove: (...xs) => xs.forEach((x) => classSet.delete(x)),
      toggle: (x, force) => {
        const on = force == null ? !classSet.has(x) : !!force;
        if (on) classSet.add(x); else classSet.delete(x);
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
      const list = listeners.get(type) ?? [];
      listeners.set(type, list.filter((f) => f !== fn));
    },
    click() {
      for (const fn of listeners.get('click') ?? []) fn({ preventDefault() {} });
    },
    _emitKey(key) {
      for (const fn of listeners.get('keydown') ?? []) {
        fn({ key, stopPropagation() { this._stopped = true; } });
      }
    },
    _attrs: attrs,
    _classSet: classSet,
    _listeners: listeners,
  };
  return el;
}

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

test('createInfoDrawer：aria-expanded / aria-controls 与开关类名', () => {
  const drawer = mockEl('info-drawer');
  const toggle = mockEl('drawer-toggle');
  const storage = memoryStorage({ [DRAWER_STORAGE_KEY]: '0' });
  const changes = [];
  const api = createInfoDrawer({
    drawer,
    toggle,
    storage,
    isMobile: () => false,
    onChange: (open) => changes.push(open),
    doc: { defaultView: null },
  });

  assert.equal(toggle.getAttribute('aria-controls'), 'info-drawer');
  assert.equal(api.isOpen(), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(drawer.classList.contains('is-closed'));
  assert.ok(drawer.classList.contains('is-overlay'));

  api.open();
  assert.equal(api.isOpen(), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(drawer.getAttribute('aria-hidden'), 'false');
  assert.ok(drawer.classList.contains('is-open'));
  assert.equal(storage.getItem(DRAWER_STORAGE_KEY), '1');
  assert.deepEqual(changes, [false, true]); // 初始 apply + open

  api.destroy();
});

test('createInfoDrawer：toggle 点击与 Escape 关闭，并写入记忆', () => {
  const drawer = mockEl('info-drawer');
  const toggle = mockEl('drawer-toggle');
  const storage = memoryStorage();
  const keyTarget = mockEl('window');
  const api = createInfoDrawer({
    drawer,
    toggle,
    storage,
    isMobile: () => false,
    doc: { defaultView: keyTarget },
  });

  assert.equal(api.isOpen(), false); // 首次默认关闭
  toggle.click();
  assert.equal(api.isOpen(), true);
  assert.equal(storage.getItem(DRAWER_STORAGE_KEY), '1');

  const esc = { key: 'Escape', stopped: false, stopPropagation() { this.stopped = true; } };
  for (const fn of keyTarget._listeners.get('keydown') ?? []) fn(esc);
  assert.equal(api.isOpen(), false);
  assert.equal(esc.stopped, true);
  api.destroy();
});

test('createInfoDrawer：移动端标记 is-sheet；onChange 不要求副作用', () => {
  const drawer = mockEl('info-drawer');
  const toggle = mockEl('drawer-toggle');
  let mobile = true;
  const api = createInfoDrawer({
    drawer,
    toggle,
    storage: memoryStorage({ [DRAWER_STORAGE_KEY]: '1' }),
    isMobile: () => mobile,
    doc: { defaultView: null },
  });
  assert.ok(drawer.classList.contains('is-sheet'));
  mobile = false;
  api.toggle(); // 触发 apply
  // 收起后再打开以刷新 mobile 标志
  api.open();
  assert.ok(drawer.classList.contains('is-overlay'));
  api.destroy();
});

test('createInfoDrawer：缺 DOM 时安全 no-op', () => {
  const api = createInfoDrawer({});
  assert.equal(api.isOpen(), false);
  api.open();
  api.close();
  api.toggle();
  api.destroy();
});
