const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

export function amplitudeToMeterPercent(value, floorDb = -60) {
  const amplitude = Math.max(0, Number(value) || 0);
  if (amplitude <= 0) return 0;
  const db = 20 * Math.log10(amplitude);
  return clamp(((db - floorDb) / -floorDb) * 100, 0, 100);
}

export function levelMeterState(level = {}, clipThreshold = 0.9) {
  const rms = Math.max(0, Number(level.rms) || 0);
  const peak = Math.max(rms, Number(level.peak) || 0);
  return {
    rmsPercent: amplitudeToMeterPercent(rms),
    peakPercent: amplitudeToMeterPercent(peak),
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
    clipping: peak > clipThreshold,
  };
}
