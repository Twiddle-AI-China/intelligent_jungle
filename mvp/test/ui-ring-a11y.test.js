// P1-3 / P1-1 相关：年轮 a11y DOM + EQ 循环；visible voice 不跟 USER。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EQ_CYCLE_KEYS,
  formatA11yValue,
  nextEqCycleTarget,
  ringA11yHtml,
  ringControlSpecs,
} from '../src/ui/ring-a11y.js';
import { resolveVisibleVoice } from '../src/ui/voice-locator.js';

test('ringA11yHtml：可聚焦 range + aria-label，覆盖五参数', () => {
  const html = ringA11yHtml('pad', 'pad', {
    renderer: {
      getRingControls: () => ([
        { treeId: 'pad', controlId: 'gain', label: 'Volume', min: 0, max: 2, step: 0.01, value: 1 },
        { treeId: 'pad', controlId: 'eqLowDb', label: 'EQ 低', min: -12, max: 12, step: 0.5, value: 0 },
      ]),
      getRingValue: () => null,
    },
    audio: { getMixParams: () => ({ gain: 1, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, reverbSend: 0 }) },
  });
  assert.match(html, /role="group"/);
  assert.match(html, /type="range"/);
  assert.match(html, /aria-label="Volume"/);
  assert.match(html, /data-ring-key="eqLowDb"/);
  assert.match(html, /data-ring-key="eqMidDb"/);
  assert.match(html, /data-ring-key="eqHighDb"/);
  assert.match(html, /data-ring-key="reverbSend"/);
  assert.match(html, /data-ring-key="gain"/);
  assert.match(html, /Alt 循环 EQ/);
});

test('nextEqCycleTarget：Alt 方向在 EQ 三环间循环', () => {
  const controls = EQ_CYCLE_KEYS.map((controlId) => ({
    treeId: 'melody', controlId, value: 0, step: 0.5,
  }));
  const a = nextEqCycleTarget(controls, 0, 1);
  assert.equal(a.controlId, 'eqLowDb');
  assert.equal(a.nextIndex, 1);
  const b = nextEqCycleTarget(controls, a.nextIndex, 1);
  assert.equal(b.controlId, 'eqMidDb');
  assert.equal(b.nextIndex, 2);
  const c = nextEqCycleTarget(controls, b.nextIndex, 1);
  assert.equal(c.controlId, 'eqHighDb');
  assert.equal(c.nextIndex, 0);
  const back = nextEqCycleTarget(controls, 0, -1);
  assert.equal(back.nextIndex, 2);
});

test('ringControlSpecs 回落默认范围；formatA11yValue', () => {
  const specs = ringControlSpecs({}, 'bass');
  assert.equal(specs.length, 5);
  assert.deepEqual([specs[0].min, specs[0].max], [-12, 12]);
  assert.equal(formatA11yValue('eqLowDb', 1.5), '+1.5 dB');
  assert.equal(formatA11yValue('gain', 0.5), '0.50');
});

test('locator 用 resolveVisibleVoice：USER focus 不得覆盖视口声部', () => {
  const renderer = {
    getVisibleVoice: () => 'texture',
    getFocusTree: () => 'pad',
  };
  assert.equal(resolveVisibleVoice(renderer, 'pad'), 'texture');
});
