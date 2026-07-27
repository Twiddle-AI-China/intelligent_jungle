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
  const modern = telemetry && Object.hasOwn(telemetry, 'queueDepth');
  const normalized = modern ? {
    ...telemetry,
    audioQueueDepth: telemetry.queueDepth,
    renderP95Ratio: telemetry.renderP95Ms / telemetry.blockDurationMs,
    renderP99Ratio: telemetry.renderP99Ms / telemetry.blockDurationMs,
    sampledAtMs: telemetry.receivedAtMs,
  } : telemetry;
  const sampledAtMs = typeof normalized?.sampledAtMs === 'number'
    && Number.isFinite(normalized.sampledAtMs) ? normalized.sampledAtMs : null;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)
    || !validThresholds(thresholds)
    || typeof nowMs !== 'number' || !Number.isFinite(nowMs)
    || typeof normalized.workerReady !== 'boolean'
    || typeof normalized.recovering !== 'boolean'
    || (modern && typeof normalized.degraded !== 'boolean')
    || NUMERIC_FIELDS.some((key) => (
      typeof normalized[key] !== 'number'
      || !Number.isFinite(normalized[key])
      || normalized[key] < 0
    ))) return result(false, 'telemetry_unknown', sampledAtMs);

  const age = nowMs - normalized.sampledAtMs;
  if (age < 0 || age > thresholds.maxTelemetryAgeMs) {
    return result(false, 'telemetry_unknown', normalized.sampledAtMs);
  }
  if (!normalized.workerReady) return result(false, 'worker_not_ready', normalized.sampledAtMs);
  if (normalized.recovering) return result(false, 'worker_recovering', normalized.sampledAtMs);
  if (modern && normalized.degraded) return result(false, 'audio_degraded', normalized.sampledAtMs);
  if (normalized.pcmHeadroomBlocks < thresholds.minPcmHeadroomBlocks) {
    return result(false, 'pcm_headroom_low', normalized.sampledAtMs);
  }
  if (normalized.audioQueueDepth > thresholds.maxAudioQueueDepth) {
    return result(false, 'audio_queue_depth_high', normalized.sampledAtMs);
  }
  if (normalized.renderP95Ratio > thresholds.maxRenderP95Ratio) {
    return result(false, 'render_p95_high', normalized.sampledAtMs);
  }
  if (normalized.renderP99Ratio > thresholds.maxRenderP99Ratio) {
    return result(false, 'render_p99_high', normalized.sampledAtMs);
  }
  if (normalized.recentUnderruns > thresholds.maxRecentUnderruns) {
    return result(false, 'recent_underrun', normalized.sampledAtMs);
  }
  if (normalized.unifiedMemoryFreeBytes < thresholds.minUnifiedMemoryFreeBytes) {
    return result(false, 'unified_memory_low', normalized.sampledAtMs);
  }
  return result(true, 'admitted', normalized.sampledAtMs);
}
