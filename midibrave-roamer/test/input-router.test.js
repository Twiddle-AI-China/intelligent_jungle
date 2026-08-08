import test from 'node:test';
import assert from 'node:assert/strict';

import { MonophonicInputRouter } from '../web/input-router.js';

test('MIDI temporarily owns pitch while wander remains available as modulation preview', () => {
  const router = new MonophonicInputRouter();
  router.press('wander:preview', { kind: 'wander-preview', midi: 60, velocity: 1 });
  router.press('midi:keyboard:0:67', {
    kind: 'midi', midi: 67, velocity: 0.7, deviceId: 'keyboard', channel: 0,
  });
  assert.equal(router.current().id, 'midi:keyboard:0:67');

  router.release('midi:keyboard:0:67');
  assert.equal(router.current().id, 'wander:preview');
});

test('manual hold outranks wander preview but not a live keyboard input', () => {
  const router = new MonophonicInputRouter();
  router.press('wander:preview', { kind: 'wander-preview', midi: 60 });
  router.press('manual:hold', { kind: 'manual', midi: 62 });
  assert.equal(router.current().id, 'manual:hold');

  router.press('key:KeyA', { kind: 'computer', midi: 64 });
  assert.equal(router.current().id, 'key:KeyA');
  router.release('key:KeyA');
  assert.equal(router.current().id, 'manual:hold');
});

test('same-priority MIDI and computer inputs use last-note priority', () => {
  const router = new MonophonicInputRouter();
  router.press('midi:a:0:60', { kind: 'midi', midi: 60 });
  router.press('key:KeyS', { kind: 'computer', midi: 62 });
  assert.equal(router.current().id, 'key:KeyS');
  router.release('key:KeyS');
  assert.equal(router.current().id, 'midi:a:0:60');
});

test('device cleanup removes only the disconnected MIDI source', () => {
  const router = new MonophonicInputRouter();
  router.press('midi:a:0:60', { kind: 'midi', midi: 60, deviceId: 'a', channel: 0 });
  router.press('midi:b:0:64', { kind: 'midi', midi: 64, deviceId: 'b', channel: 0 });
  router.press('manual:hold', { kind: 'manual', midi: 55 });
  router.clearWhere((entry) => entry.kind === 'midi' && entry.deviceId === 'b');
  assert.equal(router.current().id, 'midi:a:0:60');
  assert.equal(router.entries.has('manual:hold'), true);
});
