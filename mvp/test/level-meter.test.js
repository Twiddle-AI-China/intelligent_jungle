import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amplitudeToMeterPercent, levelMeterState } from '../src/ui/level-meter.js';

test('电平映射使用 -60..0dB，静音与满幅落在两端', () => {
  assert.equal(amplitudeToMeterPercent(0), 0);
  assert.equal(amplitudeToMeterPercent(1), 100);
  assert.ok(Math.abs(amplitudeToMeterPercent(0.001)) < 1e-9);
  assert.ok(Math.abs(amplitudeToMeterPercent(0.1) - 66.6666667) < 1e-5);
});

test('四轨 meter 状态区分 RMS、peak 与削波', () => {
  const state = levelMeterState({ rms: 0.1, peak: 0.95 });
  assert.ok(state.peakPercent > state.rmsPercent);
  assert.equal(state.clipping, true);
  assert.equal(levelMeterState({ rms: 0.1, peak: 0.5 }).clipping, false);
});
