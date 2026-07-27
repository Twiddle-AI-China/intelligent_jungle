import assert from 'node:assert/strict';
import test from 'node:test';

import { createLatentRoamer } from '../src/ui/latent-roamer.js';

function element(tag, context) {
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], parentNode: null, dataset: {},
    textContent: '', disabled: false, width: 480, height: 320, tabIndex: 0,
    setAttribute() {},
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((item) => item !== child); child.parentNode = null; },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 320 }),
    setPointerCapture() {},
  };
}

function fixture({ takeAccepted = true, delayedMap = null, commandOverride = null } = {}) {
  const rectangles = [];
  const context = {
    clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {},
    strokeRect(...args) { rectangles.push(args); },
  };
  const body = element('body', context);
  const document = { body, createElement: (tag) => element(tag, context) };
  const commands = [];
  let takeCount = 0;
  const runtimeClient = {
    async command(name, payload) {
      commands.push({ name, payload: structuredClone(payload) });
      const overridden = commandOverride?.(name, payload);
      if (overridden !== undefined) return overridden;
      if (name === 'control.take') {
        return takeAccepted
          ? { accepted: true, code: 'ok', leaseToken: `lease-${takeCount += 1}` }
          : { accepted: false, code: 'lease_conflict' };
      }
      return { accepted: true, code: 'ok' };
    },
  };
  let snapshot = {
    latent: {
      melody: {
        owner: 'AGENT', mode: 'xy', cursor: { x: 0, y: 0, pca: [] },
        neighbors: [], control: { held: false }, preview: { active: false },
      },
    },
  };
  const map = {
    voice: 'melody', points: [{ id: 'a', x: -0.5, y: 0 }, { id: 'b', x: 0.5, y: 0 }],
    range: { x: [-1, 1], y: [-1, 1] }, pcaDimensions: 2, pcaRanges: [],
    cursor: { mode: 'xy', x: 0, y: 0, pca: [] }, neighbors: [],
  };
  const roamer = createLatentRoamer({
    document, runtimeClient,
    fetchMap: delayedMap ?? (async (voice) => ({ ...map, voice })),
    getState: () => snapshot,
    voice: 'melody',
  });
  return {
    roamer, body, commands, rectangles,
    setSnapshot(value) { snapshot = value; },
  };
}

test('candidate roamer sends normalized intent and trusts authoritative state', async () => {
  const setup = fixture();
  await setup.roamer.open('melody');
  setup.setSnapshot({
    latent: {
      melody: {
        owner: 'USER', mode: 'xy', cursor: { x: 0.1, y: -0.2, pca: [] },
        neighbors: [1], control: { held: true }, preview: { active: false },
      },
    },
  });
  setup.roamer.render(setup.body && {
    latent: {
      melody: {
        owner: 'USER', mode: 'xy', cursor: { x: 0.1, y: -0.2, pca: [] },
        neighbors: [1], control: { held: true }, preview: { active: false },
      },
    },
  });
  const canvas = setup.body.children[0].children[0];
  const beforeIntent = setup.rectangles.at(-1);
  canvas.dispatch('pointerdown', { clientX: 300, clientY: 240, pointerId: 1 });
  await Promise.resolve();
  assert.deepEqual(setup.commands.at(-1), {
    name: 'latent.setCursor',
    payload: {
      voice: 'melody', leaseToken: 'lease-1', eventSeq: 1,
      cursor: { x: 0.25, y: -0.5, pca: [] },
    },
  });
  assert.deepEqual(setup.rectangles.at(-1), beforeIntent, 'intent must not move the visible cursor');
  setup.roamer.render({
    latent: {
      melody: {
        owner: 'USER', mode: 'xy', cursor: { x: -0.4, y: 0.3, pca: [] },
        neighbors: [0], control: { held: true }, preview: { active: false },
      },
    },
  });
  assert.notDeepEqual(setup.rectangles.at(-1), beforeIntent);
  await setup.roamer.close();
});

test('take rejection and async close/map failure never leave a live control surface', async () => {
  const rejected = fixture({ takeAccepted: false });
  assert.equal(await rejected.roamer.open('melody'), false);
  assert.equal(rejected.commands.some(({ name }) => name === 'latent.setCursor'), false);
  await rejected.roamer.close();

  let releaseMap;
  const delayed = fixture({
    delayedMap: () => new Promise((resolve) => { releaseMap = resolve; }),
  });
  const opening = delayed.roamer.open('melody');
  await delayed.roamer.close();
  releaseMap({ voice: 'melody', points: [], cursor: { x: 0, y: 0 }, neighbors: [] });
  assert.equal(await opening, false);
  assert.equal(delayed.body.children.length, 0);
  assert.equal(delayed.commands.length, 0);
});

test('preview pending/reject and keyboard handling stay scoped to the view', async () => {
  const setup = fixture();
  await setup.roamer.open('melody');
  setup.roamer.render({
    latent: {
      melody: {
        owner: 'USER', mode: 'xy', cursor: { x: 0, y: 0, pca: [] },
        neighbors: [], control: { held: true }, preview: { active: false },
      },
    },
  });
  const root = setup.body.children[0];
  const canvas = root.children[0];
  const preview = root.children[1];
  preview.dispatch('pointerdown');
  await Promise.resolve();
  assert.equal(setup.commands.at(-1).name, 'preview.start');
  let prevented = 0;
  canvas.dispatch('keydown', { key: 'ArrowRight', shiftKey: false, preventDefault() { prevented += 1; } });
  await Promise.resolve();
  assert.equal(prevented, 1);
  assert.equal(setup.commands.at(-1).name, 'latent.setCursor');
  await setup.roamer.close();
});

test('stale preview completion cannot touch a closed or reopened view', async () => {
  let resolvePreview;
  let delayed = true;
  const setup = fixture({
    commandOverride(name) {
      if (name === 'preview.start' && delayed) {
        delayed = false;
        return new Promise((resolve) => { resolvePreview = resolve; });
      }
      return undefined;
    },
  });
  await setup.roamer.open('melody');
  setup.roamer.render({
    latent: { melody: {
      owner: 'USER', mode: 'xy', cursor: { x: 0, y: 0, pca: [] }, neighbors: [],
      control: { held: true }, preview: { active: false },
    } },
  });
  setup.body.children[0].children[1].dispatch('pointerdown');
  await setup.roamer.close();
  await setup.roamer.open('melody');
  const replacementButton = setup.body.children[0].children[1];
  resolvePreview({ accepted: false, code: 'stale' });
  await Promise.resolve();
  assert.equal(replacementButton.disabled, false);
  assert.equal(setup.body.children[0].children[3].textContent, 'control acquired');
  await setup.roamer.close();
});

test('stale heartbeat resolve or reject cannot clear a replacement voice lease', async (context) => {
  for (const outcome of ['resolve', 'reject']) {
    await context.test(outcome, async () => {
      const savedSetInterval = globalThis.setInterval;
      const savedClearInterval = globalThis.clearInterval;
      let intervalCallback;
      globalThis.setInterval = (callback) => { intervalCallback = callback; return 1; };
      globalThis.clearInterval = () => {};
      let settleHeartbeat;
      const setup = fixture({
        commandOverride(name) {
          if (name === 'control.heartbeat' && !settleHeartbeat) {
            return new Promise((resolve, reject) => { settleHeartbeat = { resolve, reject }; });
          }
          return undefined;
        },
      });
      try {
        await setup.roamer.open('melody');
        intervalCallback();
        await setup.roamer.open('pad');
        settleHeartbeat[outcome](outcome === 'resolve'
          ? { accepted: false, code: 'stale' } : new Error('stale'));
        await Promise.resolve();
        setup.body.children[0].children[1].dispatch('pointerdown');
        await Promise.resolve();
        assert.deepEqual(setup.commands.at(-1), {
          name: 'preview.start', payload: { voice: 'pad', leaseToken: 'lease-2' },
        });
        await setup.roamer.close();
      } finally {
        globalThis.setInterval = savedSetInterval;
        globalThis.clearInterval = savedClearInterval;
      }
    });
  }
});
