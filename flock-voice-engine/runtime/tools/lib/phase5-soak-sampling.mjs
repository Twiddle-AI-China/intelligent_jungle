import { performance } from 'node:perf_hooks';

import { readCandidateOps } from './candidate-ops.mjs';

const fail = (code) => { throw new Error(code); };
const now = () => Math.round(performance.now());
const sleep = (milliseconds) => new Promise(
  (resolve) => setTimeout(resolve, Math.max(0, milliseconds)),
);

async function waitUntil(target) {
  while (now() < target) await sleep(Math.min(1_000, target - now()));
}

export async function runPhase5SoakSampling({
  admitted, clients, latencyRecorder, renderRecorder,
  normalSpeciesRecorder, burstSpeciesRecorder,
  readOps = readCandidateOps,
} = {}) {
  const window = admitted?.descriptor?.window;
  if (!window || typeof clients?.snapshotProbe !== 'function'
      || typeof latencyRecorder?.finalize !== 'function'
      || typeof renderRecorder?.record !== 'function'
      || typeof normalSpeciesRecorder?.dispatchBatch !== 'function'
      || typeof burstSpeciesRecorder?.dispatchBatch !== 'function'
      || typeof readOps !== 'function') {
    fail('PHASE5_SOAK_SAMPLING_INPUT_INVALID');
  }
  const start = window.startedAtMonotonicMs;
  const end = window.endedAtMonotonicMs;
  if (now() > start + 4_000) fail('PHASE5_SOAK_START_DEADLINE_MISSED');

  async function renderLoop() {
    let scheduled = Math.max(start, now());
    while (scheduled <= end) {
      await waitUntil(scheduled);
      const { statusCode, body } = await readOps('/readyz');
      const observedMonotonic = now();
      const observedUnix = Date.now();
      if (observedMonotonic > end) break;
      const telemetry = body?.workerTelemetry;
      if (statusCode !== 200 || body?.workerReady !== true
          || !telemetry) fail('PHASE5_SOAK_TELEMETRY_INVALID');
      renderRecorder.record({
        atMonotonicMs: observedMonotonic,
        atUnixMs: observedUnix,
        renderP95Ms: telemetry.renderP95Ms,
        renderP99Ms: telemetry.renderP99Ms,
        blockDurationMs: telemetry.blockDurationMs,
        recentUnderruns: telemetry.recentUnderruns,
      });
      scheduled += 250;
      while (scheduled < observedMonotonic) scheduled += 250;
    }
  }

  async function probeLoop() {
    let scheduled = Math.max(start, now());
    let client = 1;
    const generation = [0, 0, 0, 0];
    const probeSequence = [0, 0, 0, 0];
    while (scheduled < end) {
      await waitUntil(scheduled);
      if (now() >= end) break;
      const observedGeneration = clients.states[client - 1]
        .grant.runtimeGeneration;
      if (generation[client - 1] !== observedGeneration) {
        generation[client - 1] = observedGeneration;
        probeSequence[client - 1] = 0;
      }
      probeSequence[client - 1] += 1;
      await clients.snapshotProbe(client, probeSequence[client - 1]);
      client = client % 4 + 1;
      scheduled += 2_000;
      while (scheduled < now()) scheduled += 2_000;
    }
  }

  async function speciesLoop(recorder, cadence) {
    let scheduled = Math.max(start, now());
    while (scheduled < end) {
      await waitUntil(scheduled);
      if (now() >= end) break;
      await recorder.dispatchBatch();
      scheduled += cadence;
      while (scheduled < now()) scheduled += cadence;
    }
  }

  await Promise.all([
    renderLoop(), probeLoop(),
    speciesLoop(normalSpeciesRecorder, 2_000),
    speciesLoop(burstSpeciesRecorder, 10_000),
  ]);
  await waitUntil(end);
  const latency = latencyRecorder.finalize();
  return Object.freeze({
    runtimeReadyBytes: latency.runtimeReadyBytes,
    uiStateLagBytes: latency.uiStateLagBytes,
    renderBytes: renderRecorder.finalize(),
    speciesNormalBytes: normalSpeciesRecorder.finalizeAcceptedBytes(),
    speciesBurstBytes: burstSpeciesRecorder.finalizeAcceptedBytes(),
  });
}
