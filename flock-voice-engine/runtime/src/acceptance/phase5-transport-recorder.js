import { types } from 'node:util';

import {
  canonicalPhase5CaptureJson,
} from '../capture/capture-wire.js';

const PRIVATE_FIELDS = Object.freeze([
  'monotonicNow', 'unixNow', 'maxEvents', 'maxBytes',
]);
const CLAIM_FIELDS = Object.freeze([
  'runId', 'client', 'clientIdentitySha256', 'socketKind', 'generation',
]);
const HEX64 = /^[0-9a-f]{64}$/u;

function fail(code) {
  throw new Phase5TransportRecorderError(code);
}

function dataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
}

function exactObject(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length
    && fields.every((field) => keys.includes(field) && dataProperty(value, field));
}

function validClaim(claim, socketKind) {
  return exactObject(claim, CLAIM_FIELDS)
    && Number.isSafeInteger(claim.client)
    && claim.client >= 1 && claim.client <= 4
    && claim.socketKind === socketKind
    && Number.isSafeInteger(claim.generation) && claim.generation > 0
    && typeof claim.clientIdentitySha256 === 'string'
    && HEX64.test(claim.clientIdentitySha256);
}

function finiteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function owned(value) {
  try {
    return JSON.parse(canonicalPhase5CaptureJson(value));
  } catch {
    fail('PHASE5_TRANSPORT_OBSERVATION_INVALID');
  }
}

export class Phase5TransportRecorderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5TransportRecorderError';
    this.code = code;
  }
}

export function _createPhase5TransportRecorder(options) {
  if (arguments.length !== 1 || !exactObject(options, PRIVATE_FIELDS)
      || typeof options.monotonicNow !== 'function'
      || typeof options.unixNow !== 'function'
      || !Number.isSafeInteger(options.maxEvents) || options.maxEvents <= 0
      || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    fail('PHASE5_TRANSPORT_RECORDER_INPUT_INVALID');
  }
  const queue = [];
  let queuedBytes = 0;
  let terminal = false;
  let busy = false;
  let lastMonotonic = -1;
  let lastUnix = -1;
  const snapshotProbeSeq = [0, 0, 0, 0];
  let pendingAgent = null;
  let world = null;
  const runtimeClients = new Array(4);
  const audioClients = new Array(4);
  const egress = new Array(4);
  let worker = null;
  let pendingWorkerRecovery = null;
  let providerLastResult = null;

  function safeFrame(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
      terminal = true;
      fail('PHASE5_TRANSPORT_OBSERVATION_INVALID');
    }
    const parsed = BigInt(value);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      terminal = true;
      fail('PHASE5_TRANSPORT_OBSERVATION_INVALID');
    }
    return Number(parsed);
  }

  function updateWorld(value) {
    world = {
      worldGeneration: value.worldGeneration,
      revision: value.revision,
      eventSeq: value.eventSeq,
    };
  }

  function push(client, type, payloadSource) {
    if (terminal || busy) fail('PHASE5_TRANSPORT_RECORDER_TERMINAL');
    busy = true;
    try {
      const atMonotonicMs = Reflect.apply(options.monotonicNow, undefined, []);
      const atUnixMs = Reflect.apply(options.unixNow, undefined, []);
      if (!finiteTime(atMonotonicMs) || !finiteTime(atUnixMs)
          || atMonotonicMs < lastMonotonic || atUnixMs < lastUnix) {
        terminal = true;
        fail('PHASE5_TRANSPORT_CLOCK_INVALID');
      }
      const payload = typeof payloadSource === 'function'
        ? Reflect.apply(payloadSource, undefined, [
          atMonotonicMs,
          atUnixMs,
        ])
        : payloadSource;
      const event = owned({
        atMonotonicMs,
        atUnixMs,
        client,
        type,
        payload,
      });
      const byteLength = Buffer.byteLength(canonicalPhase5CaptureJson(event));
      if (queue.length >= options.maxEvents
          || queuedBytes > options.maxBytes - byteLength) {
        terminal = true;
        fail('PHASE5_TRANSPORT_RECORDER_OVERFLOW');
      }
      lastMonotonic = atMonotonicMs;
      lastUnix = atUnixMs;
      queue.push(event);
      queuedBytes += byteLength;
      return event;
    } finally {
      busy = false;
    }
  }

  function record(claim, socketKind, type, fields, input, payload) {
    if (!validClaim(claim, socketKind) || !exactObject(input, fields)) {
      terminal = true;
      fail('PHASE5_TRANSPORT_OBSERVATION_INVALID');
    }
    push(claim.client, type, payload);
  }

  function runtimeOpen(claim, value) {
    record(claim, 'runtime', 'runtime.open', ['mode'], value, {
      generation: claim.generation,
      mode: value.mode,
      clientIdentitySha256: claim.clientIdentitySha256,
    });
    runtimeClients[claim.client - 1] = {
      clientId: claim.client,
      connected: true,
      generation: claim.generation,
      snapshotWorldGeneration: null,
    };
  }

  function runtimeReady(claim, value) {
    record(claim, 'runtime', 'runtime.ready', [
      'worldGeneration', 'revision', 'eventSeq',
    ], value, { generation: claim.generation, ...value });
    updateWorld(value);
  }

  function runtimeSnapshot(claim, value) {
    record(claim, 'runtime', 'runtime.snapshot', [
      'worldGeneration', 'revision', 'eventSeq',
    ], value, { generation: claim.generation, ...value,
      probeSeq: (snapshotProbeSeq[claim.client - 1] += 1) });
    updateWorld(value);
    const client = runtimeClients[claim.client - 1];
    if (client) client.snapshotWorldGeneration = value.worldGeneration;
  }

  function runtimeEgress(claim, value) {
    record(claim, 'runtime', 'runtime.egress', [
      'capacityEntries', 'queuedEntries', 'inFlight', 'closed',
      'closeCode', 'closeReason',
    ], value, { generation: claim.generation, ...value });
    egress[claim.client - 1] = {
      clientId: claim.client,
      generation: claim.generation,
      queuedEntries: value.queuedEntries,
      capacityEntries: value.capacityEntries,
      closed: value.closed,
      closeCode: value.closeCode,
      closeReason: value.closeReason,
    };
  }

  function runtimeClose(claim, value) {
    record(claim, 'runtime', 'runtime.close', ['code', 'reason'], value, {
      generation: claim.generation,
      ...value,
    });
    const client = runtimeClients[claim.client - 1];
    if (client) {
      client.connected = false;
      client.snapshotWorldGeneration = null;
    }
  }

  function audioOpen(claim) {
    record(claim, 'audio', 'audio.open', [], {}, {
      generation: claim.generation,
    });
    audioClients[claim.client - 1] = {
      clientId: claim.client,
      connected: true,
      generation: claim.generation,
      audioEpoch: null,
      pcmCursorFrames: 0,
      discontinuityCount: 0,
      paused: false,
    };
  }

  function audioReady(claim, value) {
    record(claim, 'audio', 'audio.ready', [
      'audioEpoch', 'streamRevision', 'blockSeq', 'resumeStartFrame',
    ], value, { generation: claim.generation, ...value });
    const client = audioClients[claim.client - 1];
    if (client) {
      client.audioEpoch = value.audioEpoch;
      client.pcmCursorFrames = safeFrame(value.resumeStartFrame);
    }
  }

  function audioPcm(claim, value) {
    record(claim, 'audio', 'audio.pcm', [
      'audioEpoch', 'streamRevision', 'blockSeq', 'startFrame', 'frameCount',
    ], value, { generation: claim.generation, ...value });
    const client = audioClients[claim.client - 1];
    if (client) {
      client.audioEpoch = value.audioEpoch;
      client.pcmCursorFrames = safeFrame(value.startFrame) + value.frameCount;
    }
  }

  function audioDiscontinuity(claim, value) {
    record(claim, 'audio', 'audio.discontinuity', [
      'audioEpoch', 'streamRevision', 'blockSeq', 'resumeStartFrame', 'scope',
    ], value, { generation: claim.generation, ...value });
    const client = audioClients[claim.client - 1];
    if (client) {
      client.audioEpoch = value.audioEpoch;
      client.pcmCursorFrames = safeFrame(value.resumeStartFrame);
      client.discontinuityCount += 1;
    }
  }

  function audioPause(claim) {
    record(claim, 'audio', 'audio.pause', [], {}, {
      generation: claim.generation,
    });
    const client = audioClients[claim.client - 1];
    if (client) client.paused = true;
  }

  function audioResume(claim) {
    record(claim, 'audio', 'audio.resume', [], {}, {
      generation: claim.generation,
    });
    const client = audioClients[claim.client - 1];
    if (client) client.paused = false;
  }

  function audioClose(claim, value) {
    record(claim, 'audio', 'audio.close', ['code', 'reason'], value, {
      generation: claim.generation,
      ...value,
    });
    const client = audioClients[claim.client - 1];
    if (client) client.connected = false;
  }

  function workerSample(value) {
    if (!exactObject(value, [
      'pid', 'ready', 'recovering', 'restartCount', 'audioEpoch',
      'supervisorGeneration', 'lastExitedPid', 'lastExitSignal',
    ])) {
      terminal = true;
      fail('PHASE5_TRANSPORT_OBSERVATION_INVALID');
    }
    if (worker !== null && worker.ready === false && value.ready === true
        && value.restartCount === worker.restartCount + 1
        && value.supervisorGeneration === worker.supervisorGeneration
        && value.lastExitedPid === worker.lastExitedPid
        && value.lastExitSignal === 'SIGKILL') {
      if (pendingWorkerRecovery !== null) {
        terminal = true;
        fail('PHASE5_TRANSPORT_OBSERVATION_INVALID');
      }
      pendingWorkerRecovery = owned(value);
      return;
    }
    push(0, 'worker.sample', value);
    worker = owned(value);
  }

  function peekPendingWorkerRecovery(...args) {
    if (args.length !== 0 || terminal) {
      terminal = true;
      fail('PHASE5_TRANSPORT_RECORDER_TERMINAL');
    }
    return pendingWorkerRecovery === null
      ? null : owned(pendingWorkerRecovery);
  }

  function releasePendingWorkerRecovery(...args) {
    if (args.length !== 0 || terminal || pendingWorkerRecovery === null) {
      terminal = true;
      fail('PHASE5_TRANSPORT_WORKER_RECOVERY_INVALID');
    }
    const value = pendingWorkerRecovery;
    pendingWorkerRecovery = null;
    push(0, 'worker.sample', value);
    worker = owned(value);
    return owned(value);
  }

  function agentStart(value) {
    if (pendingAgent !== null || !exactObject(value, [
      'requestId', 'source', 'model', 'attempts',
    ])) {
      terminal = true;
      fail('PHASE5_TRANSPORT_OBSERVATION_INVALID');
    }
    return push(0, 'agent.start', (atMonotonicMs) => {
      pendingAgent = {
        ...value,
        startedAtMonotonicMs: atMonotonicMs,
      };
      return pendingAgent;
    });
  }

  function agentSettle(value) {
    if (pendingAgent === null || !exactObject(value, [
      'requestId', 'source', 'model', 'status', 'reason', 'attempts',
      'httpStatus',
    ]) || value.requestId !== pendingAgent.requestId
      || value.source !== pendingAgent.source
      || value.model !== pendingAgent.model
      || value.attempts !== pendingAgent.attempts) {
      terminal = true;
      fail('PHASE5_TRANSPORT_OBSERVATION_INVALID');
    }
    const event = push(0, 'agent.settle', (atMonotonicMs) => ({
      ...value,
      startedAtMonotonicMs: pendingAgent.startedAtMonotonicMs,
      settledAtMonotonicMs: atMonotonicMs,
    }));
    pendingAgent = null;
    providerLastResult = owned(event.payload);
    return event;
  }

  function snapshotState(...args) {
    if (args.length !== 0 || terminal || busy) {
      terminal = true;
      fail('PHASE5_TRANSPORT_RECORDER_TERMINAL');
    }
    if (world === null || worker === null || pendingAgent !== null
        || runtimeClients.includes(undefined)
        || audioClients.includes(undefined)
        || egress.includes(undefined)) {
      fail('PHASE5_TRANSPORT_STATE_INCOMPLETE');
    }
    return owned({
      world,
      runtimeClients,
      audioClients,
      worker,
      egress,
      provider: { lastResult: providerLastResult },
    });
  }

  function flush(...args) {
    if (args.length !== 0 || terminal || busy) {
      terminal = true;
      fail('PHASE5_TRANSPORT_RECORDER_TERMINAL');
    }
    const result = queue.splice(0, queue.length).map((value) => owned(value));
    queuedBytes = 0;
    return result;
  }

  function failObserver(value) {
    if (!exactObject(value, ['component', 'code', 'message'])) {
      terminal = true;
      fail('PHASE5_TRANSPORT_OBSERVATION_INVALID');
    }
    push(0, 'observer.failure', value);
    terminal = true;
  }

  return Object.freeze({
    runtimeOpen, runtimeReady, runtimeSnapshot, runtimeEgress, runtimeClose,
    audioOpen, audioReady, audioPcm, audioDiscontinuity,
    audioPause, audioResume, audioClose,
    workerSample, agentStart, agentSettle,
    peekPendingWorkerRecovery, releasePendingWorkerRecovery,
    failObserver, flush, snapshotState,
  });
}

export function createPhase5TransportRecorder() {
  if (arguments.length !== 0) {
    fail('PHASE5_TRANSPORT_RECORDER_INPUT_INVALID');
  }
  return _createPhase5TransportRecorder({
    monotonicNow: () => performance.now(),
    unixNow: () => Date.now(),
    maxEvents: 1_000_000,
    maxBytes: 128 * 1024 * 1024,
  });
}
