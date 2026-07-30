import { createHash } from 'node:crypto';

import {
  canonicalBytes, exactObject, ownBindingAndWindow, rawFail, validClockPair,
} from './phase5-raw-common.mjs';

const CODE = 'PHASE5_CLIENT_OBSERVATION_RECORDER_INVALID';
const CLAIM_FIELDS = [
  'client', 'clientIdentitySha256', 'socketKind', 'generation',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function validClaim(value, socketKind) {
  return exactObject(value, CLAIM_FIELDS)
    && Number.isSafeInteger(value.client) && value.client >= 1 && value.client <= 4
    && typeof value.clientIdentitySha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(value.clientIdentitySha256)
    && value.socketKind === socketKind
    && Number.isSafeInteger(value.generation) && value.generation > 0;
}

function parseJsonFrame(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) rawFail(CODE);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { rawFail(CODE); }
}

export function createPhase5ClientObservationRecorder({
  binding, window, clients,
} = {}) {
  const owned = ownBindingAndWindow(binding, window, CODE);
  if (!Array.isArray(clients) || clients.length !== 4) rawFail(CODE);
  const identities = clients.map((value, index) => {
    if (!exactObject(value, ['client', 'clientIdentitySha256'])
        || value.client !== index + 1
        || typeof value.clientIdentitySha256 !== 'string'
        || !/^[0-9a-f]{64}$/u.test(value.clientIdentitySha256)) rawFail(CODE);
    return Object.freeze({ ...value });
  });
  if (new Set(identities.map((value) => value.clientIdentitySha256)).size !== 4) {
    rawFail(CODE);
  }
  const runtime = Array.from({ length: 4 }, () => ({
    generation: 0, open: false, ready: false, probeSeq: 0,
  }));
  const audio = Array.from({ length: 4 }, () => ({
    generation: 0, open: false, ready: false, paused: false,
    audioEpoch: null, streamRevision: null, blockSeq: null, cursor: null,
  }));
  const events = [];
  const pendingReceipts = new Map();
  let terminal = false;
  let busy = false;
  let lastMonotonic = -1;
  let lastUnix = -1;

  function append(claim, socketKind, clock, type, payload) {
    if (terminal || busy || !validClaim(claim, socketKind)
        || identities[claim.client - 1].clientIdentitySha256
          !== claim.clientIdentitySha256
        || !exactObject(clock, ['atMonotonicMs', 'atUnixMs'])
        || !validClockPair(clock.atMonotonicMs, clock.atUnixMs, owned.window)
        || clock.atMonotonicMs < lastMonotonic
        || clock.atUnixMs < lastUnix
        || events.length >= 100_000) {
      terminal = true;
      rawFail(CODE);
    }
    busy = true;
    try {
      lastMonotonic = clock.atMonotonicMs;
      lastUnix = clock.atUnixMs;
      const event = {
        sequence: events.length + 1,
        client: claim.client,
        type,
        connectionGeneration: claim.generation,
        atMonotonicMs: clock.atMonotonicMs,
        atUnixMs: clock.atUnixMs,
        payload,
      };
      events.push(event);
      return event;
    } finally { busy = false; }
  }

  function runtimeOpen(claim, clock, mode) {
    const state = runtime[claim?.client - 1];
    if (!validClaim(claim, 'runtime') || !state || state.open
        || claim.generation !== state.generation + 1
        || mode !== (claim.generation === 1 ? 'bootstrap' : 'resume')) {
      terminal = true; rawFail(CODE);
    }
    append(claim, 'runtime', clock, 'runtime.open', { mode });
    Object.assign(state, { generation: claim.generation, open: true,
      ready: false, probeSeq: 0 });
  }

  function runtimeFrame(claim, clock, bytes, probeSeq = null) {
    const state = runtime[claim?.client - 1];
    if (!validClaim(claim, 'runtime') || !state?.open
        || claim.generation !== state.generation) {
      terminal = true; rawFail(CODE);
    }
    let frame;
    try { frame = parseJsonFrame(bytes); } catch (error) {
      append(claim, 'runtime', clock, 'runtime.invalid-frame', {
        frameSha256: sha256(Buffer.from(bytes ?? [])),
        byteLength: Buffer.from(bytes ?? []).byteLength,
        validationCode: 'RUNTIME_JSON_INVALID',
      });
      terminal = true;
      throw error;
    }
    if (frame?.type !== 'snapshot'
        || typeof frame.worldGeneration !== 'string'
        || !Number.isSafeInteger(frame.revision) || frame.revision < 0
        || !Number.isSafeInteger(frame.eventSeq) || frame.eventSeq < 0) {
      append(claim, 'runtime', clock, 'runtime.invalid-frame', {
        frameSha256: sha256(bytes), byteLength: bytes.byteLength,
        validationCode: 'RUNTIME_SNAPSHOT_INVALID',
      });
      terminal = true; rawFail(CODE);
    }
    const payload = {
      frameSha256: sha256(bytes), worldGeneration: frame.worldGeneration,
      revision: frame.revision, eventSeq: frame.eventSeq,
    };
    if (!state.ready) {
      if (probeSeq !== null) { terminal = true; rawFail(CODE); }
      append(claim, 'runtime', clock, 'runtime.ready', payload);
      state.ready = true;
      return;
    }
    if (!Number.isSafeInteger(probeSeq) || probeSeq !== state.probeSeq + 1) {
      terminal = true; rawFail(CODE);
    }
    state.probeSeq = probeSeq;
    append(claim, 'runtime', clock, 'runtime.snapshot', {
      ...payload, probeSeq,
    });
  }

  function runtimeClose(claim, clock, code, reason) {
    const state = runtime[claim?.client - 1];
    if (!validClaim(claim, 'runtime') || !state?.open
        || claim.generation !== state.generation
        || !Number.isSafeInteger(code) || code <= 0 || code > 65_535
        || typeof reason !== 'string' || reason.length === 0) {
      terminal = true; rawFail(CODE);
    }
    append(claim, 'runtime', clock, 'runtime.close', { code, reason });
    state.open = false; state.ready = false;
  }

  function audioOpen(claim, clock) {
    const state = audio[claim?.client - 1];
    if (!validClaim(claim, 'audio') || !state || state.open
        || claim.generation !== state.generation + 1) {
      terminal = true; rawFail(CODE);
    }
    append(claim, 'audio', clock, 'audio.open', {});
    Object.assign(state, { generation: claim.generation, open: true,
      ready: false, paused: false });
  }

  function audioJsonFrame(claim, clock, bytes) {
    const state = audio[claim?.client - 1];
    if (!validClaim(claim, 'audio') || !state?.open
        || claim.generation !== state.generation) {
      terminal = true; rawFail(CODE);
    }
    let frame;
    try { frame = parseJsonFrame(bytes); } catch (error) {
      append(claim, 'audio', clock, 'audio.invalid-frame', {
        frameSha256: sha256(Buffer.from(bytes ?? [])),
        byteLength: Buffer.from(bytes ?? []).byteLength,
        validationCode: 'AUDIO_JSON_INVALID',
      });
      terminal = true; throw error;
    }
    if (frame?.type === 'audio.ready' && !state.ready) {
      const payload = {
        frameSha256: sha256(bytes), audioEpoch: frame.audioEpoch,
        streamRevision: frame.streamRevision, blockSeq: frame.blockSeq,
        resumeStartFrame: frame.resumeStartFrame,
      };
      append(claim, 'audio', clock, 'audio.ready', payload);
      Object.assign(state, { ready: true, audioEpoch: frame.audioEpoch,
        streamRevision: frame.streamRevision, blockSeq: frame.blockSeq,
        cursor: Number(frame.resumeStartFrame) });
      return;
    }
    if (frame?.type === 'audio.discontinuity' && state.ready && !state.paused) {
      const payload = {
        frameSha256: sha256(bytes), scope: frame.scope,
        audioEpoch: frame.audioEpoch, streamRevision: frame.streamRevision,
        blockSeq: frame.blockSeq, resumeStartFrame: frame.resumeStartFrame,
      };
      append(claim, 'audio', clock, 'audio.discontinuity', payload);
      Object.assign(state, { audioEpoch: frame.audioEpoch,
        streamRevision: frame.streamRevision, blockSeq: frame.blockSeq,
        cursor: Number(frame.resumeStartFrame) });
      return;
    }
    append(claim, 'audio', clock, 'audio.invalid-frame', {
      frameSha256: sha256(bytes), byteLength: bytes.byteLength,
      validationCode: 'AUDIO_CONTROL_FRAME_INVALID',
    });
    terminal = true; rawFail(CODE);
  }

  function audioPcm(claim, clock, frameValue) {
    const state = audio[claim?.client - 1];
    const frame = Buffer.from(frameValue ?? []);
    let valid = validClaim(claim, 'audio') && state?.open && state.ready
      && !state.paused && claim.generation === state.generation
      && frame.byteLength === 32_800
      && frame.toString('ascii', 0, 4) === 'FLK1'
      && frame.readUInt8(4) === 1 && frame.readUInt8(5) === 0
      && frame.readUInt16LE(6) === 32
      && frame.readUInt32LE(8) === state.streamRevision
      && frame.readUInt32LE(12) === state.blockSeq
      && Number(frame.readBigUInt64LE(16)) === state.cursor
      && frame.readUInt32LE(24) === 4_096
      && frame.readUInt16LE(28) === 2 && frame.readUInt16LE(30) === 1;
    if (valid) {
      for (let offset = 32; offset < frame.byteLength; offset += 4) {
        if (!Number.isFinite(frame.readFloatLE(offset))) { valid = false; break; }
      }
    }
    if (!valid) {
      append(claim, 'audio', clock, 'audio.invalid-frame', {
        frameSha256: sha256(frame), byteLength: frame.byteLength,
        validationCode: 'AUDIO_PCM_INVALID',
      });
      terminal = true; rawFail(CODE);
    }
    append(claim, 'audio', clock, 'audio.pcm', {
      frameSha256: sha256(frame), byteLength: frame.byteLength,
      wireVersion: 1, flags: 0, headerBytes: 32,
      audioEpoch: state.audioEpoch,
      streamRevision: state.streamRevision, blockSeq: state.blockSeq,
      startFrame: String(state.cursor), frameCount: 4_096,
      channels: 2, format: 1, headerValid: true, lengthValid: true,
      finiteSamples: true, cursorValid: true,
    });
    state.blockSeq += 1; state.cursor += 4_096;
  }

  function audioTransition(claim, clock, type) {
    const state = audio[claim?.client - 1];
    if (!validClaim(claim, 'audio') || claim.client !== 4
        || !state?.open || !state.ready || claim.generation !== state.generation
        || state.paused !== (type === 'audio.resume')) {
      terminal = true; rawFail(CODE);
    }
    const event = append(claim, 'audio', clock, type, {
      transportSequence: null, transportEventSha256: null,
    });
    pendingReceipts.set(type, event);
    state.paused = type === 'audio.pause';
  }

  function audioPause(claim, clock) { audioTransition(claim, clock, 'audio.pause'); }
  function audioResume(claim, clock) { audioTransition(claim, clock, 'audio.resume'); }

  function audioClose(claim, clock, code, reason) {
    const state = audio[claim?.client - 1];
    if (!validClaim(claim, 'audio') || !state?.open
        || claim.generation !== state.generation
        || !Number.isSafeInteger(code) || code <= 0 || code > 65_535
        || typeof reason !== 'string' || reason.length === 0) {
      terminal = true; rawFail(CODE);
    }
    append(claim, 'audio', clock, 'audio.close', { code, reason });
    state.open = false; state.ready = false; state.paused = false;
  }

  function finalize(signedProjection) {
    if (terminal || busy || pendingReceipts.size !== 2
        || !exactObject(signedProjection, [
          'schemaVersion', 'kind', 'runId', 'challenge', 'release',
          'geometry', 'profile', 'window', 'runtimeOpens',
          'audioLifecycle', 'slowClient', 'discontinuities',
        ])) {
      terminal = true; rawFail(CODE);
    }
    for (const [type, name] of [
      ['audio.pause', 'pause'], ['audio.resume', 'resume'],
    ]) {
      const event = pendingReceipts.get(type);
      const receipt = signedProjection.slowClient?.[name];
      if (receipt?.connectionGeneration !== event.connectionGeneration
          || !validClockPair(receipt?.atMonotonicMs,
            receipt?.atUnixMs, owned.window)
          || !Number.isSafeInteger(receipt?.transportSequence)
          || receipt.transportSequence <= 0
          || typeof receipt?.transportEventSha256 !== 'string'
          || !/^[0-9a-f]{64}$/u.test(receipt.transportEventSha256)) {
        terminal = true; rawFail(CODE);
      }
      event.payload = {
        transportSequence: receipt.transportSequence,
        transportEventSha256: receipt.transportEventSha256,
      };
      event.atMonotonicMs = receipt.atMonotonicMs;
      event.atUnixMs = receipt.atUnixMs;
    }
    if (events.some((event, index) => index > 0 && (
      event.atMonotonicMs < events[index - 1].atMonotonicMs
      || event.atUnixMs < events[index - 1].atUnixMs
    ))) {
      terminal = true; rawFail(CODE);
    }
    terminal = true;
    return canonicalBytes({
      schemaVersion: 2,
      kind: 'isolated-equivalent-spark-phase5-client-observations',
      ...owned.binding,
      window: owned.window,
      clients: identities,
      events,
    });
  }

  return Object.freeze({
    runtimeOpen, runtimeFrame, runtimeClose,
    audioOpen, audioJsonFrame, audioPcm, audioPause, audioResume,
    audioClose, finalize,
  });
}
