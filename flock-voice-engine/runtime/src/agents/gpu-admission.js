export const DEFAULT_GPU_THRESHOLDS = Object.freeze({
  maxTelemetryAgeMs: 1000,
  minPcmHeadroomBlocks: 3,
  maxAudioQueueDepth: 1,
  maxRenderP95Ratio: 0.70,
  maxRenderP99Ratio: 0.90,
  maxRecentUnderruns: 0,
  minUnifiedMemoryFreeBytes: 12 * 1024 ** 3,
});

const NUMERIC_FIELDS = Object.freeze([
  'pcmHeadroomBlocks',
  'audioQueueDepth',
  'renderP95Ratio',
  'renderP99Ratio',
  'recentUnderruns',
  'unifiedMemoryFreeBytes',
  'sampledAtMs',
]);

function result(admitted, reason, sampledAtMs) {
  return Object.freeze({ admitted, reason, sampledAtMs });
}

function validThresholds(value) {
  return value && typeof value === 'object'
    && Object.keys(DEFAULT_GPU_THRESHOLDS).every((key) => (
      typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0
    ));
}

export function evaluateSpeciesAdmission(
  telemetry,
  thresholds = DEFAULT_GPU_THRESHOLDS,
  nowMs = Date.now(),
) {
  const sampledAtMs = typeof telemetry?.sampledAtMs === 'number'
    && Number.isFinite(telemetry.sampledAtMs) ? telemetry.sampledAtMs : null;
  if (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)
    || !validThresholds(thresholds)
    || typeof nowMs !== 'number' || !Number.isFinite(nowMs)
    || typeof telemetry.workerReady !== 'boolean'
    || typeof telemetry.recovering !== 'boolean'
    || NUMERIC_FIELDS.some((key) => (
      typeof telemetry[key] !== 'number'
      || !Number.isFinite(telemetry[key])
      || telemetry[key] < 0
    ))) return result(false, 'telemetry_unknown', sampledAtMs);

  const age = nowMs - telemetry.sampledAtMs;
  if (age < 0 || age > thresholds.maxTelemetryAgeMs) {
    return result(false, 'telemetry_unknown', telemetry.sampledAtMs);
  }
  if (!telemetry.workerReady) return result(false, 'worker_not_ready', telemetry.sampledAtMs);
  if (telemetry.recovering) return result(false, 'worker_recovering', telemetry.sampledAtMs);
  if (telemetry.pcmHeadroomBlocks < thresholds.minPcmHeadroomBlocks) {
    return result(false, 'pcm_headroom_low', telemetry.sampledAtMs);
  }
  if (telemetry.audioQueueDepth > thresholds.maxAudioQueueDepth) {
    return result(false, 'audio_queue_depth_high', telemetry.sampledAtMs);
  }
  if (telemetry.renderP95Ratio > thresholds.maxRenderP95Ratio) {
    return result(false, 'render_p95_high', telemetry.sampledAtMs);
  }
  if (telemetry.renderP99Ratio > thresholds.maxRenderP99Ratio) {
    return result(false, 'render_p99_high', telemetry.sampledAtMs);
  }
  if (telemetry.recentUnderruns > thresholds.maxRecentUnderruns) {
    return result(false, 'recent_underrun', telemetry.sampledAtMs);
  }
  if (telemetry.unifiedMemoryFreeBytes < thresholds.minUnifiedMemoryFreeBytes) {
    return result(false, 'unified_memory_low', telemetry.sampledAtMs);
  }
  return result(true, 'admitted', telemetry.sampledAtMs);
}
