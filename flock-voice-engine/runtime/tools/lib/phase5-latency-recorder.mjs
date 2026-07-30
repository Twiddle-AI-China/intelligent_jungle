import {
  canonicalBytes, exactObject, ownBindingAndWindow, rawFail, validClockPair,
} from './phase5-raw-common.mjs';

const CODE = 'PHASE5_LATENCY_RECORDER_INVALID';
const HEX64 = /^[0-9a-f]{64}$/u;

export function createPhase5LatencyRecorder({ binding, window } = {}) {
  const owned = ownBindingAndWindow(binding, window, CODE);
  const runtimeOpen = new Map();
  const runtimeSamples = new Map();
  const pendingProbes = new Map();
  const uiSamples = [];
  const probeSequences = [0, 0, 0, 0];
  const generations = [null, null, null, null];
  let terminal = false;
  let busy = false;

  function enter() {
    if (terminal || busy) {
      terminal = true;
      rawFail(CODE);
    }
    busy = true;
  }
  function leave() { busy = false; }

  function runtimeOpened(value) {
    enter();
    try {
      if (!exactObject(value, [
        'client', 'connectionGeneration',
        'openedAtMonotonicMs', 'openedAtUnixMs',
      ]) || !Number.isSafeInteger(value.client)
          || value.client < 1 || value.client > 4
          || value.connectionGeneration !== 1
          || !validClockPair(value.openedAtMonotonicMs,
            value.openedAtUnixMs, owned.window)
          || value.openedAtMonotonicMs
            <= owned.window.startedAtMonotonicMs
          || runtimeOpen.has(value.client)) rawFail(CODE);
      runtimeOpen.set(value.client, { ...value });
    } catch (error) {
      terminal = true;
      throw error;
    } finally { leave(); }
  }

  function runtimeReady(value) {
    enter();
    try {
      if (!exactObject(value, [
        'client', 'connectionGeneration',
        'readyAtMonotonicMs', 'readyAtUnixMs', 'readyFrameSha256',
      ])) rawFail(CODE);
      const opened = runtimeOpen.get(value.client);
      if (!opened || runtimeSamples.has(value.client)
          || value.connectionGeneration !== opened.connectionGeneration
          || !HEX64.test(value.readyFrameSha256)
          || !validClockPair(value.readyAtMonotonicMs,
            value.readyAtUnixMs, owned.window)
          || value.readyAtMonotonicMs < opened.openedAtMonotonicMs
          || value.readyAtUnixMs < opened.openedAtUnixMs
          || Math.abs(
            (value.readyAtMonotonicMs - opened.openedAtMonotonicMs)
            - (value.readyAtUnixMs - opened.openedAtUnixMs)
          ) > 1) rawFail(CODE);
      runtimeSamples.set(value.client, {
        sequence: value.client,
        ...opened,
        readyAtMonotonicMs: value.readyAtMonotonicMs,
        readyAtUnixMs: value.readyAtUnixMs,
        readyFrameSha256: value.readyFrameSha256,
      });
    } catch (error) {
      terminal = true;
      throw error;
    } finally { leave(); }
  }

  function uiProbeSent(value) {
    enter();
    try {
      if (!exactObject(value, [
        'client', 'connectionGeneration', 'probeSeq',
        'sentAtMonotonicMs', 'sentAtUnixMs',
      ]) || value.client !== (uiSamples.length % 4) + 1
          || !Number.isSafeInteger(value.connectionGeneration)
          || value.connectionGeneration < 1
          || !Number.isSafeInteger(value.probeSeq)
          || value.probeSeq < 1
          || pendingProbes.has(value.client)
          || !validClockPair(value.sentAtMonotonicMs,
            value.sentAtUnixMs, owned.window)) rawFail(CODE);
      const index = value.client - 1;
      if (generations[index] !== value.connectionGeneration) {
        if (generations[index] !== null
            && value.connectionGeneration !== generations[index] + 1) {
          rawFail(CODE);
        }
        generations[index] = value.connectionGeneration;
        probeSequences[index] = 0;
      }
      if (value.probeSeq !== probeSequences[index] + 1) rawFail(CODE);
      probeSequences[index] = value.probeSeq;
      pendingProbes.set(value.client, { ...value });
    } catch (error) {
      terminal = true;
      throw error;
    } finally { leave(); }
  }

  function uiSnapshotObserved(value) {
    enter();
    try {
      if (!exactObject(value, [
        'client', 'connectionGeneration', 'probeSeq',
        'observedAtMonotonicMs', 'observedAtUnixMs',
        'snapshotFrameSha256',
      ])) rawFail(CODE);
      const sent = pendingProbes.get(value.client);
      if (!sent
          || value.connectionGeneration !== sent.connectionGeneration
          || value.probeSeq !== sent.probeSeq
          || !HEX64.test(value.snapshotFrameSha256)
          || !validClockPair(value.observedAtMonotonicMs,
            value.observedAtUnixMs, owned.window)
          || value.observedAtMonotonicMs < sent.sentAtMonotonicMs
          || value.observedAtUnixMs < sent.sentAtUnixMs
          || Math.abs(
            (value.observedAtMonotonicMs - sent.sentAtMonotonicMs)
            - (value.observedAtUnixMs - sent.sentAtUnixMs)
          ) > 1) rawFail(CODE);
      pendingProbes.delete(value.client);
      uiSamples.push({
        sequence: uiSamples.length + 1,
        ...sent,
        observedAtMonotonicMs: value.observedAtMonotonicMs,
        observedAtUnixMs: value.observedAtUnixMs,
        snapshotFrameSha256: value.snapshotFrameSha256,
      });
    } catch (error) {
      terminal = true;
      throw error;
    } finally { leave(); }
  }

  function finalize(...args) {
    enter();
    try {
      const minimumUi = Math.floor(1_800_000 / 2_000 * 0.95);
      const clockStreams = [
        uiSamples.map((value) => value.sentAtMonotonicMs),
        uiSamples.map((value) => value.sentAtUnixMs),
        uiSamples.map((value) => value.observedAtMonotonicMs),
        uiSamples.map((value) => value.observedAtUnixMs),
      ];
      if (args.length !== 0 || runtimeSamples.size !== 4
          || pendingProbes.size !== 0
          || uiSamples.length < minimumUi || uiSamples.length > 901
          || uiSamples[0].sentAtMonotonicMs
            - owned.window.startedAtMonotonicMs > 4_000
          || uiSamples[0].sentAtUnixMs
            - owned.window.startedAtUnixMs > 4_000
          || owned.window.endedAtMonotonicMs
            - uiSamples.at(-1).observedAtMonotonicMs > 6_000
          || owned.window.endedAtUnixMs
            - uiSamples.at(-1).observedAtUnixMs > 6_000
          || clockStreams.some((stream) => stream.some(
            (value, index) => index > 0
              && (value <= stream[index - 1]
                || value - stream[index - 1] > 8_000),
          ))) {
        rawFail(CODE);
      }
      const base = {
        schemaVersion: 2,
        ...owned.binding,
        window: owned.window,
      };
      terminal = true;
      return Object.freeze({
        runtimeReadyBytes: canonicalBytes({
          ...base,
          kind: 'isolated-equivalent-spark-phase5-runtime-ready-samples',
          samples: [...runtimeSamples.values()].sort(
            (left, right) => left.client - right.client,
          ),
        }),
        uiStateLagBytes: canonicalBytes({
          ...base,
          kind: 'isolated-equivalent-spark-phase5-ui-state-lag-samples',
          samples: uiSamples,
        }),
      });
    } catch (error) {
      terminal = true;
      throw error;
    } finally { leave(); }
  }

  return Object.freeze({
    runtimeOpened, runtimeReady, uiProbeSent, uiSnapshotObserved, finalize,
  });
}
