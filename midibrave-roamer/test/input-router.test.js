import test from 'node:test';
import assert from 'node:assert/strict';

import { PolyphonicInputRouter } from '../web/input-router.js';

test('same-priority MIDI and computer inputs use last-note priority', () => {
  const router = new PolyphonicInputRouter();
  router.press('midi:a:0:60', { kind: 'midi', midi: 60 });
  router.press('key:KeyS', { kind: 'computer', midi: 62 });
  assert.equal(router.current().id, 'key:KeyS');
  router.release('key:KeyS');
  assert.equal(router.current().id, 'midi:a:0:60');
});

test('device cleanup removes only the disconnected MIDI source', () => {
  const router = new PolyphonicInputRouter();
  router.press('key:KeyA', { kind: 'computer', midi: 55 });
  router.press('midi:a:0:60', { kind: 'midi', midi: 60, deviceId: 'a', channel: 0 });
  router.press('midi:b:0:64', { kind: 'midi', midi: 64, deviceId: 'b', channel: 0 });
  router.clearWhere((entry) => entry.kind === 'midi' && entry.deviceId === 'b');
  assert.equal(router.current().id, 'midi:a:0:60');
  assert.equal(router.entries.has('key:KeyA'), true);
});

test('four-note chord stays active and a fifth note steals the oldest slot', () => {
  const router = new PolyphonicInputRouter();
  for (const note of [60, 64, 67, 71, 74]) {
    router.press(`midi:keys:0:${note}`, { kind: 'midi', midi: note });
  }
  assert.deepEqual(router.active().map((entry) => entry.midi), [64, 67, 71, 74]);
  router.release('midi:keys:0:74');
  assert.deepEqual(router.active().map((entry) => entry.midi), [60, 64, 67, 71]);
});
