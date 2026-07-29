import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson } from '../../tools/lib/phase5-fault-evidence.mjs';
import {
  MAX_PHASE5_SPECIES_RESPONSE_BYTES,
  MAX_PHASE5_SPECIES_SAMPLES_BYTES,
  Phase5SpeciesRawRecorderError,
  createPhase5SpeciesRawRecorder,
} from '../../tools/lib/phase5-species-raw-recorder.mjs';

const BINDING = Object.freeze({
  runId: '12345678-1234-4234-8234-123456789abc',
  challenge: 'a'.repeat(64),
  release: Object.freeze({
    releaseManifestSha256: 'b'.repeat(64),
    releaseRevision: 'c'.repeat(40),
    sourceManifestSha256: 'd'.repeat(64),
    audioArtifactSha256: 'e'.repeat(64),
  }),
  geometry: Object.freeze({
    sampleRate: 44_100,
    blockFrames: 4_096,
    poolSize: 5,
    rowVoices: Object.freeze(['bass', 'pad', 'lead', 'pluck', 'pad']),
  }),
  profile: Object.freeze({
    clients: 4,
    slowClient: 4,
    durationMinutes: 30,
    speciesEndpoint: 'http://127.0.0.1:8081/v1',
    speciesModel: 'bird_agent',
  }),
});
const WINDOW = Object.freeze({
  startedAtMonotonicMs: 1_000,
  endedAtMonotonicMs: 1_801_000,
  startedAtUnixMs: 1_700_000_000_000,
  endedAtUnixMs: 1_700_001_800_000,
});
const NORMAL_BATCH_COUNT = Math.floor(30 * 60 * 1_000 / 2_000 * 0.95);
const BURST_BATCH_COUNT = Math.floor(30 * 60 * 1_000 / 10_000 * 0.95);

function bodyBytes(slot = 1) {
  return Buffer.from(JSON.stringify({
    choices: [{
      message: { content: '{"ok":true}' },
      slot,
    }],
  }));
}

function asArrayBuffer(bytes) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mutableClock() {
  const state = {
    monotonicMs: 1_001,
    unixMs: 1_700_000_000_001,
  };
  return {
    state,
    monotonicNow: () => state.monotonicMs,
    unixNow: () => state.unixMs,
  };
}

function successResponse(bytes, { status = 200, json } = {}) {
  return {
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-length'
          ? String(bytes.byteLength)
          : null;
      },
    },
    arrayBuffer: async () => asArrayBuffer(bytes),
    json: json ?? (() => {
      throw new Error('response.json() must never be called');
    }),
  };
}

function createRecorder(options) {
  return createPhase5SpeciesRawRecorder({
    binding: BINDING,
    window: WINDOW,
    ...options,
  });
}

function finalize(recorder) {
  return recorder.finalizeAcceptedBytes();
}

function scheduledRecorder({
  mode,
  bytes = bodyBytes(),
  settleDeltas = () => ({ monotonicMs: 100, unixMs: 100 }),
} = {}) {
  const clock = mutableClock();
  let requestIndex = 0;
  const recorder = createRecorder({
    mode,
    monotonicNow: clock.monotonicNow,
    unixNow: clock.unixNow,
    timeoutSignalFactory: () => new AbortController().signal,
    fetchImpl: async () => {
      const ownRequestIndex = requestIndex;
      requestIndex += 1;
      const started = {
        monotonicMs: clock.state.monotonicMs,
        unixMs: clock.state.unixMs,
      };
      return {
        ...successResponse(bytes),
        arrayBuffer: async () => {
          const deltas = settleDeltas(ownRequestIndex);
          clock.state.monotonicMs =
            started.monotonicMs + deltas.monotonicMs;
          clock.state.unixMs = started.unixMs + deltas.unixMs;
          return asArrayBuffer(bytes);
        },
      };
    },
  });
  return { clock, recorder };
}

async function dispatchScheduledRun(
  recorder,
  clock,
  mode,
  { relativeAt } = {},
) {
  const batches = mode === 'normal'
    ? NORMAL_BATCH_COUNT
    : BURST_BATCH_COUNT;
  const finalStartedRelative = mode === 'normal'
    ? 1_790_000
    : 1_750_000;
  for (let index = 0; index < batches; index += 1) {
    const relative = relativeAt === undefined
      ? 1 + Math.floor(
        index * (finalStartedRelative - 1) / (batches - 1),
      )
      : relativeAt({ index, batches, finalStartedRelative });
    clock.state.monotonicMs = WINDOW.startedAtMonotonicMs + relative;
    clock.state.unixMs = WINDOW.startedAtUnixMs + relative;
    await recorder.dispatchBatch();
  }
}

test('captures actual response bytes through arrayBuffer and emits canonical v2 bytes', async () => {
  const clock = mutableClock();
  const bytes = Buffer.from(
    '{ "choices": [ { "message": { "content": "{\\"ok\\":true}" } } ] }',
  );
  let arrayBufferCalls = 0;
  let jsonCalls = 0;
  const recorder = createRecorder({
    mode: 'normal',
    monotonicNow: clock.monotonicNow,
    unixNow: clock.unixNow,
    fetchImpl: async () => {
      const started = { ...clock.state };
      return {
        status: 200,
        headers: { get: () => String(bytes.byteLength) },
        arrayBuffer: async () => {
          arrayBufferCalls += 1;
          clock.state.monotonicMs = started.monotonicMs + 100;
          clock.state.unixMs = started.unixMs + 100;
          return asArrayBuffer(bytes);
        },
        json: async () => {
          jsonCalls += 1;
          return {};
        },
      };
    },
  });

  await dispatchScheduledRun(recorder, clock, 'normal');

  assert.equal(arrayBufferCalls, NORMAL_BATCH_COUNT);
  assert.equal(jsonCalls, 0);
  const observations = recorder.getObservations();
  assert.equal(observations.length, NORMAL_BATCH_COUNT);
  assert.deepEqual(observations[0], {
    sequence: 1,
    batchSequence: 1,
    slot: 1,
    startedAtMonotonicMs: 1_001,
    startedAtUnixMs: 1_700_000_000_001,
    settledAtMonotonicMs: 1_101,
    settledAtUnixMs: 1_700_000_000_101,
    httpStatus: 200,
    responseBodyBase64: bytes.toString('base64'),
    outcome: 'success',
    failureCode: null,
  });

  const output = finalize(recorder);
  const document = JSON.parse(output.toString('utf8'));
  assert.equal(output.toString('utf8'), canonicalJson(document));
  const { samples, ...top } = document;
  assert.deepEqual(top, {
    schemaVersion: 2,
    kind: 'isolated-equivalent-spark-phase5-species-load-samples',
    ...BINDING,
    window: WINDOW,
    mode: 'normal',
  });
  assert.equal(samples.length, NORMAL_BATCH_COUNT);
  const {
    outcome: _outcome,
    failureCode: _failureCode,
    ...firstSample
  } = observations[0];
  assert.deepEqual(samples[0], firstSample);
});

test('freezes burst sequence, batch and slot at dispatch despite out-of-order completion', async () => {
  const clock = mutableClock();
  const responses = Array.from({ length: 4 }, deferred);
  let callIndex = 0;
  const recorder = createRecorder({
    mode: 'burst',
    monotonicNow: clock.monotonicNow,
    unixNow: clock.unixNow,
    fetchImpl: () => responses[callIndex++].promise,
  });

  const settled = recorder.dispatchBatch();
  assert.deepEqual(
    recorder.getObservations().map((item) => [
      item.sequence,
      item.batchSequence,
      item.slot,
      item.outcome,
    ]),
    [
      [1, 1, 1, 'pending'],
      [2, 1, 2, 'pending'],
      [3, 1, 3, 'pending'],
      [4, 1, 4, 'pending'],
    ],
  );

  for (const slot of [4, 2, 3, 1]) {
    clock.state.monotonicMs = 1_100 + slot;
    clock.state.unixMs = 1_700_000_000_100 + slot;
    responses[slot - 1].resolve(successResponse(bodyBytes(slot)));
    await Promise.resolve();
  }
  await settled;

  const observations = recorder.getObservations();
  assert.deepEqual(
    observations.map((item) => [
      item.sequence,
      item.batchSequence,
      item.slot,
      Buffer.from(item.responseBodyBase64, 'base64').toString('utf8'),
    ]),
    [1, 2, 3, 4].map((slot) => [
      slot,
      1,
      slot,
      bodyBytes(slot).toString('utf8'),
    ]),
  );
});

test('prevalidates every burst signal before recording or sending any request', async () => {
  let factoryCalls = 0;
  let fetchCalls = 0;
  let injectInvalidSignal = true;
  const recorder = createRecorder({
    mode: 'burst',
    ...mutableClock(),
    timeoutSignalFactory: () => {
      factoryCalls += 1;
      if (injectInvalidSignal && factoryCalls === 2) return {};
      return new AbortController().signal;
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return successResponse(bodyBytes());
    },
  });

  assert.throws(
    () => recorder.dispatchBatch(),
    /PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID/,
  );
  assert.equal(factoryCalls, 2);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(recorder.getObservations(), []);

  injectInvalidSignal = false;
  const records = await recorder.dispatchBatch();
  assert.deepEqual(
    records.map(({ sequence, batchSequence, slot }) => (
      [sequence, batchSequence, slot]
    )),
    [
      [1, 1, 1],
      [2, 1, 2],
      [3, 1, 3],
      [4, 1, 4],
    ],
  );
});

test('rejects an already-aborted signal atomically before dispatch', () => {
  const controller = new AbortController();
  controller.abort(new DOMException('timed out', 'TimeoutError'));
  let factoryCalls = 0;
  let fetchCalls = 0;
  const recorder = createRecorder({
    mode: 'burst',
    ...mutableClock(),
    timeoutSignalFactory: () => {
      factoryCalls += 1;
      return factoryCalls === 2
        ? controller.signal
        : new AbortController().signal;
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return successResponse(bodyBytes());
    },
  });

  assert.throws(
    () => recorder.dispatchBatch(),
    /PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID/,
  );
  assert.equal(factoryCalls, 2);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(recorder.getObservations(), []);
});

test('rechecks all collected signals before dispatch side effects', () => {
  const controllers = Array.from(
    { length: 4 },
    () => new AbortController(),
  );
  let factoryCalls = 0;
  let fetchCalls = 0;
  const recorder = createRecorder({
    mode: 'burst',
    ...mutableClock(),
    timeoutSignalFactory: () => {
      const index = factoryCalls;
      factoryCalls += 1;
      if (index === 1) controllers[0].abort();
      return controllers[index].signal;
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return successResponse(bodyBytes());
    },
  });

  assert.throws(
    () => recorder.dispatchBatch(),
    /PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID/,
  );
  assert.equal(factoryCalls, 4);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(recorder.getObservations(), []);
});

test('rechecks signals after atomic start-clock capture', () => {
  const controllers = Array.from(
    { length: 4 },
    () => new AbortController(),
  );
  let signalIndex = 0;
  let monotonicCalls = 0;
  let fetchCalls = 0;
  const recorder = createRecorder({
    mode: 'burst',
    timeoutSignalFactory: () => {
      const signal = controllers[signalIndex].signal;
      signalIndex += 1;
      return signal;
    },
    monotonicNow: () => {
      monotonicCalls += 1;
      if (monotonicCalls === 1) controllers[0].abort();
      return 1_001;
    },
    unixNow: () => 1_700_000_000_001,
    fetchImpl: async () => {
      fetchCalls += 1;
      return successResponse(bodyBytes());
    },
  });

  assert.throws(
    () => recorder.dispatchBatch(),
    /PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID/,
  );
  assert.equal(fetchCalls, 0);
  assert.deepEqual(recorder.getObservations(), []);
});

test('captures every burst start clock before dispatching any request', () => {
  let monotonicCalls = 0;
  let fetchCalls = 0;
  const recorder = createRecorder({
    mode: 'burst',
    monotonicNow: () => {
      monotonicCalls += 1;
      if (monotonicCalls === 2) throw new Error('clock unavailable');
      return 1_000 + monotonicCalls;
    },
    unixNow: () => 1_700_000_000_001,
    timeoutSignalFactory: () => new AbortController().signal,
    fetchImpl: async () => {
      fetchCalls += 1;
      return successResponse(bodyBytes());
    },
  });

  assert.throws(
    () => recorder.dispatchBatch(),
    /PHASE5_SPECIES_RAW_RECORDER_CLOCK_INVALID/,
  );
  assert.equal(fetchCalls, 0);
  assert.deepEqual(recorder.getObservations(), []);
});

test('settlement clock failure rejects the batch without leaving pending state', async () => {
  let monotonicCalls = 0;
  const recorder = createRecorder({
    mode: 'normal',
    monotonicNow: () => {
      monotonicCalls += 1;
      if (monotonicCalls === 2) throw new Error('clock unavailable');
      return 1_001;
    },
    unixNow: () => 1_700_000_000_001,
    timeoutSignalFactory: () => new AbortController().signal,
    fetchImpl: async () => successResponse(bodyBytes()),
  });

  await assert.rejects(
    recorder.dispatchBatch(),
    /PHASE5_SPECIES_RAW_RECORDER_CLOCK_INVALID/,
  );
  const [observation] = recorder.getObservations();
  assert.equal(observation.outcome, 'failure');
  assert.equal(
    observation.failureCode,
    'PHASE5_SPECIES_RAW_RECORDER_CLOCK_INVALID',
  );
  assert.equal(observation.settledAtMonotonicMs, null);
  assert.equal(observation.settledAtUnixMs, null);
});

test('enters busy state before a timeout signal factory can re-enter dispatch', async () => {
  let recorder;
  let attemptedReentry = false;
  let reentrantError = null;
  let reentrantPromise = null;
  const timeoutSignalFactory = () => {
    if (!attemptedReentry) {
      attemptedReentry = true;
      try {
        reentrantPromise = recorder.dispatchBatch();
      } catch (error) {
        reentrantError = error;
      }
    }
    return new AbortController().signal;
  };
  recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    timeoutSignalFactory,
    fetchImpl: async () => successResponse(bodyBytes()),
  });

  const outerPromise = recorder.dispatchBatch();
  await Promise.all([
    outerPromise,
    ...(reentrantPromise === null ? [] : [reentrantPromise]),
  ]);

  assert.equal(
    reentrantError?.code,
    'PHASE5_SPECIES_RAW_RECORDER_BUSY',
  );
  assert.equal(reentrantPromise, null);
  assert.deepEqual(
    recorder.getObservations().map((item) => (
      [item.sequence, item.batchSequence, item.slot]
    )),
    [[1, 1, 1]],
  );
});

test('keeps a burst busy until every slot settles and returns the first batch error', async () => {
  const settlementAttempted = deferred();
  const delayedResponses = [
    deferred(),
    deferred(),
    deferred(),
  ];
  let monotonicCalls = 0;
  let fetchCalls = 0;
  const recorder = createRecorder({
    mode: 'burst',
    monotonicNow: () => {
      monotonicCalls += 1;
      if (monotonicCalls === 5) {
        settlementAttempted.resolve();
        throw new Error('first settlement clock unavailable');
      }
      return 1_000 + monotonicCalls;
    },
    unixNow: () => 1_700_000_000_001 + monotonicCalls,
    timeoutSignalFactory: () => new AbortController().signal,
    fetchImpl: () => {
      fetchCalls += 1;
      if (fetchCalls === 1 || fetchCalls > 4) {
        return Promise.resolve(successResponse(bodyBytes()));
      }
      return delayedResponses[fetchCalls - 2].promise;
    },
  });

  let batchSettled = false;
  let batchError = null;
  const observedBatch = recorder.dispatchBatch().then(
    () => {
      batchSettled = true;
    },
    (error) => {
      batchSettled = true;
      batchError = error;
    },
  );
  await settlementAttempted.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(batchSettled, false);
  assert.throws(
    () => recorder.dispatchBatch(),
    /PHASE5_SPECIES_RAW_RECORDER_BUSY/,
  );
  assert.equal(
    recorder.getObservations().filter(({ outcome }) => (
      outcome === 'pending'
    )).length,
    3,
  );

  for (const response of delayedResponses) {
    response.resolve(successResponse(bodyBytes()));
  }
  await observedBatch;

  assert.equal(
    batchError?.code,
    'PHASE5_SPECIES_RAW_RECORDER_CLOCK_INVALID',
  );
  assert.equal(
    recorder.getObservations().some(({ outcome }) => outcome === 'pending'),
    false,
  );
  await recorder.dispatchBatch();
  assert.equal(fetchCalls, 8);
});

test('preserves the earliest rejection while waiting for later burst failures', async () => {
  const responses = Array.from({ length: 4 }, () => deferred());
  const firstFailureObserved = deferred();
  const firstError = new Phase5SpeciesRawRecorderError(
    'PHASE5_SPECIES_FIRST_SETTLEMENT_ERROR',
  );
  const laterError = new Phase5SpeciesRawRecorderError(
    'PHASE5_SPECIES_LATER_SETTLEMENT_ERROR',
  );
  let monotonicCalls = 0;
  let fetchCalls = 0;
  const recorder = createRecorder({
    mode: 'burst',
    monotonicNow: () => {
      monotonicCalls += 1;
      if (monotonicCalls === 5) {
        firstFailureObserved.resolve();
        throw firstError;
      }
      if (monotonicCalls === 6) throw laterError;
      return 1_000 + monotonicCalls;
    },
    unixNow: () => 1_700_000_000_001 + monotonicCalls,
    timeoutSignalFactory: () => new AbortController().signal,
    fetchImpl: () => {
      const response = responses[fetchCalls];
      fetchCalls += 1;
      return response.promise;
    },
  });

  let batchError = null;
  const observedBatch = recorder.dispatchBatch().catch((error) => {
    batchError = error;
  });
  responses[3].resolve(successResponse(bodyBytes()));
  await firstFailureObserved.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(
    () => recorder.dispatchBatch(),
    /PHASE5_SPECIES_RAW_RECORDER_BUSY/,
  );

  responses[0].resolve(successResponse(bodyBytes()));
  responses[1].resolve(successResponse(bodyBytes()));
  responses[2].resolve(successResponse(bodyBytes()));
  await observedBatch;

  assert.equal(batchError, firstError);
  assert.equal(
    recorder.getObservations().some(({ outcome }) => outcome === 'pending'),
    false,
  );
});

test('rejects concurrent and fetch-reentrant dispatch without interleaving batches', async () => {
  const response = deferred();
  let recorder;
  let reentrantError = null;
  let attemptedReentry = false;
  const fetchImpl = async () => {
    if (!attemptedReentry) {
      attemptedReentry = true;
      try {
        recorder.dispatchBatch();
      } catch (error) {
        reentrantError = error;
      }
    }
    return response.promise;
  };
  recorder = createRecorder({
    mode: 'burst',
    ...mutableClock(),
    timeoutSignalFactory: () => new AbortController().signal,
    fetchImpl,
  });

  const settled = recorder.dispatchBatch();
  assert.throws(
    () => recorder.dispatchBatch(),
    /PHASE5_SPECIES_RAW_RECORDER_BUSY/,
  );
  assert.equal(
    reentrantError?.code,
    'PHASE5_SPECIES_RAW_RECORDER_BUSY',
  );
  assert.deepEqual(
    recorder.getObservations().map((item) => (
      [item.sequence, item.batchSequence, item.slot]
    )),
    [
      [1, 1, 1],
      [2, 1, 2],
      [3, 1, 3],
      [4, 1, 4],
    ],
  );

  response.resolve(successResponse(bodyBytes()));
  await settled;
});

test('records non-200 status and body as failure and rejects accepted finalize', async () => {
  const bytes = Buffer.from('provider unavailable');
  const recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: async () => successResponse(bytes, { status: 503 }),
  });

  const returned = await recorder.dispatchBatch();

  const [observation] = recorder.getObservations();
  assert.deepEqual(returned, [observation]);
  assert.equal(observation.outcome, 'failure');
  assert.equal(observation.failureCode, 'PHASE5_SPECIES_HTTP_STATUS_INVALID');
  assert.equal(observation.httpStatus, 503);
  assert.equal(observation.responseBodyBase64, bytes.toString('base64'));
  assert.throws(
    () => finalize(recorder),
    (error) => (
      error instanceof Phase5SpeciesRawRecorderError
      && error.code === 'PHASE5_SPECIES_RAW_RECORDER_REJECTED'
      && error.observations[0].failureCode
        === 'PHASE5_SPECIES_HTTP_STATUS_INVALID'
    ),
  );
});

test('records an oversized actual body as failure and rejects accepted finalize', async () => {
  const bytes = Buffer.alloc(MAX_PHASE5_SPECIES_RESPONSE_BYTES + 1, 0x61);
  let arrayBufferCalls = 0;
  const recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: async () => ({
      ...successResponse(bytes),
      arrayBuffer: async () => {
        arrayBufferCalls += 1;
        return asArrayBuffer(bytes);
      },
    }),
  });

  await recorder.dispatchBatch();

  const [observation] = recorder.getObservations();
  assert.equal(arrayBufferCalls, 0);
  assert.equal(observation.outcome, 'failure');
  assert.equal(
    observation.failureCode,
    'PHASE5_SPECIES_RESPONSE_BODY_TOO_LARGE',
  );
  assert.equal(observation.responseBodyBase64, null);
  assert.throws(() => finalize(recorder), (error) => (
    error.code === 'PHASE5_SPECIES_RAW_RECORDER_REJECTED'
    && error.observations[0].responseBodyBase64 === null
    && error.observations[0].failureCode
      === 'PHASE5_SPECIES_RESPONSE_BODY_TOO_LARGE'
  ));
});

test('prefers a bounded response body reader and preserves exact streamed bytes', async () => {
  const bytes = bodyBytes();
  let arrayBufferCalls = 0;
  const recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 7));
          controller.enqueue(bytes.subarray(7));
          controller.close();
        },
      }),
      arrayBuffer: async () => {
        arrayBufferCalls += 1;
        throw new Error('arrayBuffer fallback must not run');
      },
    }),
  });

  await recorder.dispatchBatch();

  assert.equal(arrayBufferCalls, 0);
  const [observation] = recorder.getObservations();
  assert.equal(observation.outcome, 'success');
  assert.equal(observation.responseBodyBase64, bytes.toString('base64'));
});

test('rejects subclassed streamed bytes before their spoofed length can be retained', async () => {
  const bytes = bodyBytes();
  class OversizedChunk extends Uint8Array {
    get byteLength() {
      return bytes.byteLength;
    }
  }
  const chunk = new OversizedChunk(
    MAX_PHASE5_SPECIES_RESPONSE_BYTES + 1,
  );
  chunk.fill(0x20);
  chunk.set(bytes);
  let delivered = false;
  const recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          async read() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return { done: false, value: chunk };
          },
          async cancel() {},
          releaseLock() {},
        }),
      },
    }),
  });

  await recorder.dispatchBatch();

  const [observation] = recorder.getObservations();
  assert.equal(observation.outcome, 'failure');
  assert.equal(
    observation.failureCode,
    'PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED',
  );
  assert.equal(observation.responseBodyBase64, null);
});

test('rejects SharedArrayBuffer-backed streamed bytes without retaining them', async () => {
  const bytes = bodyBytes();
  const chunk = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
  chunk.set(bytes);
  let delivered = false;
  const recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          async read() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return { done: false, value: chunk };
          },
          async cancel() {},
          releaseLock() {},
        }),
      },
    }),
  });

  await recorder.dispatchBatch();

  const [observation] = recorder.getObservations();
  assert.equal(observation.outcome, 'failure');
  assert.equal(
    observation.failureCode,
    'PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED',
  );
  assert.equal(observation.responseBodyBase64, null);
});

test('rejects proxied streamed bytes without consulting spoofable properties', async () => {
  const bytes = bodyBytes();
  let propertyReads = 0;
  const chunk = new Proxy(new Uint8Array(bytes), {
    get(target, property) {
      propertyReads += 1;
      return Reflect.get(target, property, target);
    },
  });
  let delivered = false;
  const recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          async read() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return { done: false, value: chunk };
          },
          async cancel() {},
          releaseLock() {},
        }),
      },
    }),
  });

  await recorder.dispatchBatch();

  const [observation] = recorder.getObservations();
  assert.equal(propertyReads, 0);
  assert.equal(observation.outcome, 'failure');
  assert.equal(
    observation.failureCode,
    'PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED',
  );
  assert.equal(observation.responseBodyBase64, null);
});

test('cancels the first zero-length streamed chunk instead of retaining no-progress objects', async () => {
  const bytes = bodyBytes();
  const zeroChunkCount = 50_000;
  let readCalls = 0;
  let cancelCalls = 0;
  const recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          async read() {
            readCalls += 1;
            if (readCalls <= zeroChunkCount) {
              return { done: false, value: new Uint8Array(0) };
            }
            if (readCalls === zeroChunkCount + 1) {
              return { done: false, value: bytes };
            }
            return { done: true, value: undefined };
          },
          async cancel() {
            cancelCalls += 1;
          },
          releaseLock() {},
        }),
      },
    }),
  });

  await recorder.dispatchBatch();

  const [observation] = recorder.getObservations();
  assert.equal(readCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(observation.outcome, 'failure');
  assert.equal(
    observation.failureCode,
    'PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED',
  );
  assert.equal(observation.responseBodyBase64, null);
});

test('cancels a streamed response at the byte cap without retaining a prefix', async () => {
  let readCalls = 0;
  let cancelCalls = 0;
  const chunks = [
    new Uint8Array(MAX_PHASE5_SPECIES_RESPONSE_BYTES),
    new Uint8Array([1]),
  ];
  const reader = {
    async read() {
      const value = chunks[readCalls];
      readCalls += 1;
      return value === undefined
        ? { done: true, value: undefined }
        : { done: false, value };
    },
    cancel() {
      cancelCalls += 1;
      return new Promise(() => {});
    },
    releaseLock() {},
  };
  const recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => reader },
    }),
  });

  const settled = recorder.dispatchBatch();
  const outcome = await Promise.race([
    settled.then(() => 'settled'),
    new Promise((resolve) => setImmediate(() => resolve('hung'))),
  ]);

  assert.equal(outcome, 'settled');
  const [observation] = recorder.getObservations();
  assert.equal(readCalls, 2);
  assert.equal(cancelCalls, 1);
  assert.equal(observation.outcome, 'failure');
  assert.equal(
    observation.failureCode,
    'PHASE5_SPECIES_RESPONSE_BODY_TOO_LARGE',
  );
  assert.equal(observation.responseBodyBase64, null);
});

test('uses arrayBuffer only with a canonical bounded content-length', async () => {
  const bytes = bodyBytes();
  let missingLengthCalls = 0;
  const missingLength = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => {
        missingLengthCalls += 1;
        return asArrayBuffer(bytes);
      },
    }),
  });
  await missingLength.dispatchBatch();
  assert.equal(missingLengthCalls, 0);
  assert.equal(
    missingLength.getObservations()[0].failureCode,
    'PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED',
  );

  let mismatchCalls = 0;
  const mismatchedLength = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => String(bytes.byteLength - 1) },
      arrayBuffer: async () => {
        mismatchCalls += 1;
        return asArrayBuffer(bytes);
      },
    }),
  });
  await mismatchedLength.dispatchBatch();
  assert.equal(mismatchCalls, 1);
  assert.equal(
    mismatchedLength.getObservations()[0].failureCode,
    'PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED',
  );
});

test('rejects an ArrayBuffer subclass before its spoofed length can bypass the cap', async () => {
  const bytes = bodyBytes();
  class OversizedArrayBuffer extends ArrayBuffer {
    get byteLength() {
      return 0;
    }
  }
  const rawBody = new OversizedArrayBuffer(
    MAX_PHASE5_SPECIES_RESPONSE_BYTES + 1,
  );
  const view = new Uint8Array(rawBody);
  view.fill(0x20);
  view.set(bytes);
  const recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => '0' },
      arrayBuffer: async () => rawBody,
    }),
  });

  await recorder.dispatchBatch();

  const [observation] = recorder.getObservations();
  assert.equal(observation.outcome, 'failure');
  assert.equal(
    observation.failureCode,
    'PHASE5_SPECIES_RESPONSE_BODY_READ_FAILED',
  );
  assert.equal(observation.responseBodyBase64, null);
});

test('records timeout without invented status or body and rejects accepted finalize', async () => {
  const clock = mutableClock();
  const controllers = [];
  const recorder = createRecorder({
    mode: 'normal',
    monotonicNow: clock.monotonicNow,
    unixNow: clock.unixNow,
    timeoutSignalFactory: () => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    },
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    }),
  });

  const settled = recorder.dispatchBatch();
  clock.state.monotonicMs = 11_001;
  clock.state.unixMs = 1_700_000_010_001;
  controllers[0].abort(new DOMException('timed out', 'TimeoutError'));
  await settled;

  const [observation] = recorder.getObservations();
  assert.equal(observation.outcome, 'failure');
  assert.equal(observation.failureCode, 'PHASE5_SPECIES_REQUEST_TIMEOUT');
  assert.equal(observation.httpStatus, null);
  assert.equal(observation.responseBodyBase64, null);
  assert.throws(() => finalize(recorder), (error) => (
    error.code === 'PHASE5_SPECIES_RAW_RECORDER_REJECTED'
    && error.observations[0].failureCode
      === 'PHASE5_SPECIES_REQUEST_TIMEOUT'
    && error.observations[0].httpStatus === null
    && error.observations[0].responseBodyBase64 === null
  ));
});

test('settles timeout even when an injected fetch ignores the abort signal', async () => {
  const controller = new AbortController();
  const recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    timeoutSignalFactory: () => controller.signal,
    fetchImpl: async () => new Promise(() => {}),
  });

  const settled = recorder.dispatchBatch();
  controller.abort(new DOMException('timed out', 'TimeoutError'));
  const outcome = await Promise.race([
    settled.then(() => 'settled'),
    new Promise((resolve) => setImmediate(() => resolve('hung'))),
  ]);

  assert.equal(outcome, 'settled');
  const [observation] = recorder.getObservations();
  assert.equal(observation.outcome, 'failure');
  assert.equal(
    observation.failureCode,
    'PHASE5_SPECIES_REQUEST_TIMEOUT',
  );
});

test('rejects accepted finalize while a batch remains busy', async () => {
  const response = deferred();
  const recorder = createRecorder({
    mode: 'normal',
    ...mutableClock(),
    fetchImpl: () => response.promise,
  });
  const settled = recorder.dispatchBatch();

  assert.throws(
    () => finalize(recorder),
    (error) => (
      error instanceof Phase5SpeciesRawRecorderError
      && error.code === 'PHASE5_SPECIES_RAW_RECORDER_BUSY'
    ),
  );

  response.resolve(successResponse(bodyBytes()));
  await settled;
});

test('rejects finalize reentry while preparing the 856th normal sample', async () => {
  const bytes = bodyBytes();
  const clock = mutableClock();
  let recorder;
  let reenterFinalize = false;
  let reentrantBytes = null;
  let reentrantError = null;
  const timeoutSignalFactory = () => {
    if (reenterFinalize) {
      reenterFinalize = false;
      try {
        reentrantBytes = recorder.finalizeAcceptedBytes();
      } catch (error) {
        reentrantError = error;
      }
    }
    return new AbortController().signal;
  };
  recorder = createRecorder({
    mode: 'normal',
    monotonicNow: clock.monotonicNow,
    unixNow: clock.unixNow,
    timeoutSignalFactory,
    fetchImpl: async () => {
      const started = { ...clock.state };
      return {
        ...successResponse(bytes),
        arrayBuffer: async () => {
          clock.state.monotonicMs = started.monotonicMs + 100;
          clock.state.unixMs = started.unixMs + 100;
          return asArrayBuffer(bytes);
        },
      };
    },
  });
  await dispatchScheduledRun(recorder, clock, 'normal');
  assert.equal(recorder.getObservations().length, NORMAL_BATCH_COUNT);

  clock.state.monotonicMs = WINDOW.startedAtMonotonicMs + 1_792_000;
  clock.state.unixMs = WINDOW.startedAtUnixMs + 1_792_000;
  reenterFinalize = true;
  await recorder.dispatchBatch();

  assert.equal(
    reentrantError?.code,
    'PHASE5_SPECIES_RAW_RECORDER_BUSY',
  );
  assert.equal(reentrantBytes === null, true);
  assert.equal(recorder.getObservations().length, NORMAL_BATCH_COUNT + 1);
  const document = JSON.parse(finalize(recorder).toString('utf8'));
  assert.equal(document.samples.length, NORMAL_BATCH_COUNT + 1);
});

test('rejects accepted finalize before the mode minimum coverage', async () => {
  const { recorder } = scheduledRecorder({ mode: 'normal' });
  await recorder.dispatchBatch();

  assert.throws(
    () => finalize(recorder),
    /PHASE5_SPECIES_RAW_RECORDER_REJECTED/,
  );
});

test('records malformed or duplicate JSON response tokens as failures', async () => {
  const attacks = [
    Buffer.from(
      '{"choices":[{"message":{"content":"{\\"ok\\":false}"}}]}',
    ),
    Buffer.from(
      '{"choices":[{"message":{"content":"{\\"ok\\":true}"}}],'
      + '"duplicate":1,"duplicate":2}',
    ),
    Buffer.from(
      '{"choices":[{"message":{"content":'
      + '"{\\"ok\\":true,\\"ok\\":true}"}}]}',
    ),
  ];

  for (const bytes of attacks) {
    const { recorder } = scheduledRecorder({
      mode: 'normal',
      bytes,
    });
    await recorder.dispatchBatch();
    const [observation] = recorder.getObservations();
    assert.equal(observation.outcome, 'failure');
    assert.equal(
      observation.failureCode,
      'PHASE5_SPECIES_RESPONSE_TOKEN_INVALID',
    );
    assert.throws(
      () => finalize(recorder),
      /PHASE5_SPECIES_RAW_RECORDER_REJECTED/,
    );
  }
});

test('rejects accepted finalize when dual clocks drift during a complete run', async () => {
  const { clock, recorder } = scheduledRecorder({
    mode: 'normal',
    settleDeltas: (requestIndex) => ({
      monotonicMs: 100,
      unixMs: requestIndex === 0 ? 102 : 100,
    }),
  });
  await dispatchScheduledRun(recorder, clock, 'normal');

  assert.throws(
    () => finalize(recorder),
    /PHASE5_SPECIES_RAW_RECORDER_REJECTED/,
  );
});

test('rejects complete runs outside Python v2 cadence and coverage limits', async () => {
  const interpolate = (index, batches, first, last) => (
    first + Math.floor(index * (last - first) / (batches - 1))
  );
  const attacks = [
    {
      mode: 'normal',
      relativeAt: ({ index, batches }) => (
        interpolate(index, batches, 4_001, 1_790_000)
      ),
    },
    {
      mode: 'normal',
      relativeAt: ({ index, batches }) => {
        if (index === 0) return 1;
        return interpolate(index - 1, batches - 1, 10_002, 1_790_000);
      },
    },
    {
      mode: 'normal',
      relativeAt: ({ index, batches }) => (
        interpolate(index, batches, 1, 1_789_899)
      ),
    },
    {
      mode: 'burst',
      relativeAt: ({ index, batches }) => (
        interpolate(index, batches, 20_001, 1_750_000)
      ),
    },
    {
      mode: 'burst',
      relativeAt: ({ index, batches }) => {
        if (index === 0) return 1;
        return interpolate(index - 1, batches - 1, 50_002, 1_750_000);
      },
    },
    {
      mode: 'burst',
      relativeAt: ({ index, batches }) => (
        interpolate(index, batches, 1, 1_749_899)
      ),
    },
  ];

  for (const { mode, relativeAt } of attacks) {
    const { clock, recorder } = scheduledRecorder({ mode });
    await dispatchScheduledRun(
      recorder,
      clock,
      mode,
      { relativeAt },
    );
    assert.throws(
      () => finalize(recorder),
      /PHASE5_SPECIES_RAW_RECORDER_REJECTED/,
    );
  }
});

test('owns endpoint, model, binding and window before dispatch so provenance cannot be swapped', async () => {
  const binding = structuredClone(BINDING);
  const window = structuredClone(WINDOW);
  const clock = mutableClock();
  let requestedUrl = null;
  let requestedModel = null;
  let fetchCalls = 0;
  const recorder = createPhase5SpeciesRawRecorder({
    mode: 'normal',
    binding,
    window,
    monotonicNow: clock.monotonicNow,
    unixNow: clock.unixNow,
    fetchImpl: async (url, options) => {
      fetchCalls += 1;
      requestedUrl = url;
      requestedModel = JSON.parse(options.body).model;
      return successResponse(bodyBytes());
    },
  });

  assert.throws(
    () => recorder.dispatchBatch({
      baseUrl: 'https://evil.example/v1',
      model: 'forged-model',
    }),
    /PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID/,
  );
  assert.equal(fetchCalls, 0);

  binding.profile.speciesEndpoint = 'https://evil.example/v1';
  binding.profile.speciesModel = 'forged-model';
  binding.release.releaseManifestSha256 = 'f'.repeat(64);
  binding.geometry.rowVoices[0] = 'forged';
  window.startedAtMonotonicMs = 999_999;
  await dispatchScheduledRun(recorder, clock, 'normal');

  assert.equal(
    requestedUrl,
    'http://127.0.0.1:8081/v1/chat/completions',
  );
  assert.equal(requestedModel, 'bird_agent');
  const document = JSON.parse(finalize(recorder).toString('utf8'));
  assert.deepEqual(document.profile, BINDING.profile);
  assert.deepEqual(document.release, BINDING.release);
  assert.deepEqual(document.geometry, BINDING.geometry);
  assert.deepEqual(document.window, WINDOW);
});

test('validates the owned snapshot against the full exact binding and window contract', () => {
  const attacks = [
    (binding) => { binding.runId = 'not-a-run-id'; },
    (binding) => { binding.challenge = 'A'.repeat(64); },
    (binding) => {
      binding.release.releaseManifestSha256 = ['b'.repeat(64)];
    },
    (binding) => { binding.release.releaseRevision = ['c'.repeat(40)]; },
    (binding) => { binding.release.releaseRevision = 'f'.repeat(39); },
    (binding) => { binding.release.hidden = true; },
    (binding) => { binding.geometry.blockFrames = 2_048; },
    (binding) => { binding.geometry.rowVoices[4] = 'lead'; },
    (binding) => { binding.profile.clients = 3; },
    (binding) => {
      binding.profile.speciesEndpoint = 'https://evil.example/v1';
    },
    (binding) => { binding.profile.speciesModel = 'forged-model'; },
  ];
  for (const attack of attacks) {
    const binding = structuredClone(BINDING);
    attack(binding);
    assert.throws(
      () => createPhase5SpeciesRawRecorder({
        mode: 'normal',
        binding,
        window: WINDOW,
      }),
      /PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID/,
    );
  }

  const invalidWindow = {
    ...WINDOW,
    endedAtMonotonicMs: WINDOW.endedAtMonotonicMs - 1,
  };
  assert.throws(
    () => createPhase5SpeciesRawRecorder({
      mode: 'normal',
      binding: BINDING,
      window: invalidWindow,
    }),
    /PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID/,
  );
});

test('validates exact keys after cloning a shape-shifting binding proxy', () => {
  const target = {
    ...structuredClone(BINDING),
    hidden: 'shape-shift',
  };
  let ownKeysCalls = 0;
  const binding = new Proxy(target, {
    ownKeys(value) {
      ownKeysCalls += 1;
      if (ownKeysCalls === 1) {
        return ['runId', 'challenge', 'release', 'geometry', 'profile'];
      }
      return Reflect.ownKeys(value);
    },
  });

  assert.throws(
    () => createPhase5SpeciesRawRecorder({
      mode: 'normal',
      binding,
      window: WINDOW,
    }),
    /PHASE5_SPECIES_RAW_RECORDER_INPUT_INVALID/,
  );
});

test('rejects dispatch atomically at the mode-specific maximum sample count', async () => {
  for (const [mode, maximumBatches, slots] of [
    ['normal', 901, 1],
    ['burst', 181, 4],
  ]) {
    let fetchCalls = 0;
    const recorder = createRecorder({
      mode,
      ...mutableClock(),
      fetchImpl: async () => {
        fetchCalls += 1;
        return successResponse(bodyBytes());
      },
    });
    for (let index = 0; index < maximumBatches; index += 1) {
      await recorder.dispatchBatch();
    }

    assert.throws(
      () => recorder.dispatchBatch(),
      /PHASE5_SPECIES_RAW_RECORDER_SAMPLE_LIMIT/,
    );
    assert.equal(fetchCalls, maximumBatches * slots);
    assert.equal(
      recorder.getObservations().length,
      maximumBatches * slots,
    );
  }
});

test('bounds retained response evidence by the 64 MiB raw artifact cap', async () => {
  const emptyEnvelope = JSON.stringify({
    choices: [{ message: { content: '{"ok":true}' } }],
    padding: '',
  });
  const bytes = Buffer.from(JSON.stringify({
    choices: [{ message: { content: '{"ok":true}' } }],
    padding: 'a'.repeat(
      MAX_PHASE5_SPECIES_RESPONSE_BYTES
        - Buffer.byteLength(emptyEnvelope),
    ),
  }));
  assert.equal(bytes.byteLength, MAX_PHASE5_SPECIES_RESPONSE_BYTES);
  const { recorder } = scheduledRecorder({
    mode: 'normal',
    bytes,
  });

  for (let index = 0; index < 60; index += 1) {
    await recorder.dispatchBatch();
  }

  const observations = recorder.getObservations();
  const limited = observations.find((item) => (
    item.failureCode === 'PHASE5_SPECIES_RAW_ARTIFACT_TOO_LARGE'
  ));
  assert.ok(limited);
  assert.equal(limited.responseBodyBase64, null);
  const retainedBase64Bytes = observations.reduce((
    total,
    item,
  ) => total + (item.responseBodyBase64?.length ?? 0), 0);
  assert.ok(retainedBase64Bytes <= MAX_PHASE5_SPECIES_SAMPLES_BYTES);
});

test('successful finalize freezes dispatch and remains byte-idempotent', async () => {
  const { clock, recorder } = scheduledRecorder({ mode: 'normal' });
  await dispatchScheduledRun(recorder, clock, 'normal');

  const first = finalize(recorder);
  const second = finalize(recorder);
  assert.deepEqual(second, first);
  assert.throws(
    () => recorder.dispatchBatch(),
    /PHASE5_SPECIES_RAW_RECORDER_FINALIZED/,
  );
  assert.equal(
    JSON.parse(first.toString('utf8')).samples.length,
    NORMAL_BATCH_COUNT,
  );
});

test('a complete burst run finalizes all four fixed slots per batch', async () => {
  const { clock, recorder } = scheduledRecorder({ mode: 'burst' });
  await dispatchScheduledRun(recorder, clock, 'burst');

  const document = JSON.parse(finalize(recorder).toString('utf8'));

  assert.equal(document.samples.length, BURST_BATCH_COUNT * 4);
  assert.deepEqual(
    document.samples.slice(-4).map((sample) => [
      sample.batchSequence,
      sample.slot,
    ]),
    [
      [BURST_BATCH_COUNT, 1],
      [BURST_BATCH_COUNT, 2],
      [BURST_BATCH_COUNT, 3],
      [BURST_BATCH_COUNT, 4],
    ],
  );
});
