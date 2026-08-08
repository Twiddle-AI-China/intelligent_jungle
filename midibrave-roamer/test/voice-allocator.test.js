import test from 'node:test';
import assert from 'node:assert/strict';

import { PolyphonicInputRouter } from '../web/input-router.js';
import { PolyphonicVoiceAllocator } from '../web/voice-allocator.js';

function chord(router, notes) {
  for (const note of notes) router.press(`note:${note}`, { kind: 'midi', midi: note });
}

test('allocator holds four notes on four distinct model rows', () => {
  const router = new PolyphonicInputRouter();
  const allocator = new PolyphonicVoiceAllocator();
  chord(router, [60, 64, 67, 71]);
  const actions = allocator.plan(router.active(), [1, 4, 8, 9]);
  assert.deepEqual(actions.map((action) => action.type), ['hold', 'hold', 'hold', 'hold']);
  assert.deepEqual(new Set(actions.map((action) => action.row)), new Set([1, 4, 8, 9]));
});

test('fifth note releases one row and reuses it without retriggering the other three', () => {
  const router = new PolyphonicInputRouter();
  const allocator = new PolyphonicVoiceAllocator();
  chord(router, [60, 64, 67, 71]);
  allocator.plan(router.active(), [1, 4, 8, 9]);
  chord(router, [74]);
  const actions = allocator.plan(router.active(), [1, 4, 8, 9]);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, 'release');
  assert.equal(actions[1].type, 'hold');
  assert.equal(actions[1].midi, 74);
  assert.equal(actions[1].row, actions[0].row);
});

test('model switch panics old rows and migrates the held chord', () => {
  const router = new PolyphonicInputRouter();
  const allocator = new PolyphonicVoiceAllocator();
  chord(router, [60, 64, 67]);
  allocator.plan(router.active(), [0, 5, 6, 7]);
  const actions = allocator.plan(router.active(), [2, 10, 11, 12]);
  assert.equal(actions.filter((action) => action.type === 'panic').length, 3);
  assert.equal(actions.filter((action) => action.type === 'hold').length, 3);
  assert.ok(actions.filter((action) => action.type === 'hold')
    .every((action) => [2, 10, 11, 12].includes(action.row)));
});
