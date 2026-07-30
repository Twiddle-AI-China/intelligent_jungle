import {
  canonicalBytes, exactObject, ownBindingAndWindow, rawFail, validClockPair,
} from './phase5-raw-common.mjs';

const CODE = 'PHASE5_RENDER_RECORDER_INVALID';

export function createPhase5RenderRecorder({ binding, window } = {}) {
  const owned = ownBindingAndWindow(binding, window, CODE);
  const blockDurationMs = owned.binding.geometry.blockFrames
    / owned.binding.geometry.sampleRate * 1_000;
  const samples = [];
  let terminal = false;
  let busy = false;
  let lastMonotonic = -1;
  let lastUnix = -1;

  function record(value) {
    if (terminal || busy) {
      terminal = true;
      rawFail(CODE);
    }
    busy = true;
    try {
      if (!exactObject(value, [
        'atMonotonicMs', 'atUnixMs', 'renderP95Ms', 'renderP99Ms',
        'blockDurationMs', 'recentUnderruns',
      ]) || !validClockPair(value.atMonotonicMs,
        value.atUnixMs, owned.window)
          || (samples.length > 0 && (
            value.atMonotonicMs <= lastMonotonic
            || value.atUnixMs <= lastUnix
            || value.atMonotonicMs - lastMonotonic > 1_000
            || value.atUnixMs - lastUnix > 1_000
          ))
          || ![value.renderP95Ms, value.renderP99Ms, value.blockDurationMs]
            .every((item) => typeof item === 'number'
              && Number.isFinite(item) && item >= 0)
          || value.renderP95Ms > value.renderP99Ms
          || value.blockDurationMs !== blockDurationMs
          || !Number.isSafeInteger(value.recentUnderruns)
          || value.recentUnderruns !== 0
          || samples.length >= 7_201) rawFail(CODE);
      lastMonotonic = value.atMonotonicMs;
      lastUnix = value.atUnixMs;
      samples.push({ sequence: samples.length + 1, ...value });
    } catch (error) {
      terminal = true;
      throw error;
    } finally { busy = false; }
  }

  function finalize(...args) {
    if (terminal || busy || args.length !== 0
        || samples.length < 6_480 || samples.length > 7_201
        || samples[0].atMonotonicMs
          - owned.window.startedAtMonotonicMs > 500
        || samples[0].atUnixMs - owned.window.startedAtUnixMs > 500
        || owned.window.endedAtMonotonicMs
          - samples.at(-1).atMonotonicMs > 750
        || owned.window.endedAtUnixMs - samples.at(-1).atUnixMs > 750) {
      terminal = true;
      rawFail(CODE);
    }
    terminal = true;
    return canonicalBytes({
      schemaVersion: 2,
      kind: 'isolated-equivalent-spark-phase5-render-samples',
      ...owned.binding,
      window: owned.window,
      samples,
    });
  }

  return Object.freeze({ record, finalize });
}
