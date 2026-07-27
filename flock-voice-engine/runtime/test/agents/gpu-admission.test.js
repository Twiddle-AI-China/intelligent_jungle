import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_GPU_THRESHOLDS,
  evaluateSpeciesAdmission,
} from '../../src/agents/gpu-admission.js';

const safeTelemetry = {
  workerReady: true,
  recovering: false,
  pcmHeadroomBlocks: 3,
  audioQueueDepth: 1,
  renderP95Ratio: 0.7,
  renderP99Ratio: 0.9,
  recentUnderruns: 0,
  unifiedMemoryFreeBytes: 12 * 1024 ** 3,
  sampledAtMs: 1_000,
};

test('missing, stale, or non-finite telemetry fails closed', () => {
  assert.deepEqual(evaluateSpeciesAdmission(null, DEFAULT_GPU_THRESHOLDS, 1_000), {
    admitted: false, reason: 'telemetry_unknown', sampledAtMs: null,
  });
  assert.deepEqual(evaluateSpeciesAdmission({ ...safeTelemetry, sampledAtMs: 0 }, DEFAULT_GPU_THRESHOLDS, 2_000), {
    admitted: false, reason: 'telemetry_unknown', sampledAtMs: 0,
  });
  for (const key of [
    'pcmHeadroomBlocks', 'audioQueueDepth', 'renderP95Ratio', 'renderP99Ratio',
    'recentUnderruns', 'unifiedMemoryFreeBytes', 'sampledAtMs',
  ]) {
    assert.equal(evaluateSpeciesAdmission({
      ...safeTelemetry, [key]: Number.NaN,
    }, DEFAULT_GPU_THRESHOLDS, 1_000).reason, 'telemetry_unknown', key);
  }
});

test('audio-first thresholds expose stable fail-closed reasons', () => {
  const cases = [
    [{ workerReady: false }, 'worker_not_ready'],
    [{ recovering: true }, 'worker_recovering'],
    [{ pcmHeadroomBlocks: 2.99 }, 'pcm_headroom_low'],
    [{ audioQueueDepth: 1.01 }, 'audio_queue_depth_high'],
    [{ renderP95Ratio: 0.701 }, 'render_p95_high'],
    [{ renderP99Ratio: 0.901 }, 'render_p99_high'],
    [{ recentUnderruns: 1 }, 'recent_underrun'],
    [{ unifiedMemoryFreeBytes: 12 * 1024 ** 3 - 1 }, 'unified_memory_low'],
  ];
  for (const [patch, reason] of cases) {
    assert.deepEqual(evaluateSpeciesAdmission({
      ...safeTelemetry, ...patch,
    }, DEFAULT_GPU_THRESHOLDS, 1_000), {
      admitted: false, reason, sampledAtMs: 1_000,
    });
  }
});

test('only complete fresh telemetry at every audio threshold is admitted', () => {
  assert.deepEqual(evaluateSpeciesAdmission(safeTelemetry, DEFAULT_GPU_THRESHOLDS, 1_000), {
    admitted: true, reason: 'admitted', sampledAtMs: 1_000,
  });
});
