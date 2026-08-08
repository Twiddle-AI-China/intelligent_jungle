import test from 'node:test';
import assert from 'node:assert/strict';

import { PolyphonicInputRouter } from '../web/input-router.js';
import { MidiInputController } from '../web/midi-input.js';

function setup() {
  const router = new PolyphonicInputRouter();
  const midi = new MidiInputController(router);
  return { router, midi };
}

test('CC64 defers note off until the sustain pedal is released', () => {
  const { router, midi } = setup();
  midi.handleMessage('keys', [0xb0, 64, 127]);
  assert.equal(midi.handleMessage('keys', [0x90, 67, 100]), true);
  assert.equal(midi.handleMessage('keys', [0x80, 67, 0]), false);
  assert.equal(router.current().midi, 67);
  assert.equal(midi.handleMessage('keys', [0xb0, 64, 0]), true);
  assert.equal(router.current(), null);
});

test('CC123 clears only its MIDI channel and preserves manual hold', () => {
  const { router, midi } = setup();
  router.press('manual:hold', { kind: 'manual', midi: 55 });
  midi.handleMessage('keys', [0x90, 60, 100]);
  midi.handleMessage('keys', [0x91, 64, 100]);
  assert.equal(midi.handleMessage('keys', [0xb0, 123, 0]), true);
  assert.equal(router.entries.has('midi:keys:0:60'), false);
  assert.equal(router.entries.has('midi:keys:1:64'), true);
  assert.equal(router.entries.has('manual:hold'), true);
});

test('device disconnect releases its held and sustained notes precisely', () => {
  const { router, midi } = setup();
  midi.handleMessage('gone', [0xb0, 64, 127]);
  midi.handleMessage('gone', [0x90, 60, 100]);
  midi.handleMessage('gone', [0x80, 60, 0]);
  midi.handleMessage('kept', [0x90, 64, 100]);
  assert.equal(midi.disconnectMissing(new Set(['kept'])), true);
  assert.equal(router.entries.has('midi:gone:0:60'), false);
  assert.equal(router.entries.has('midi:kept:0:64'), true);
  assert.equal(midi.sustainChannels.size, 0);
  assert.equal(midi.deferredNoteOffs.size, 0);
});
