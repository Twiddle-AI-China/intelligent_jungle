import { ecologicalRelations } from './relations.js';
import { findNeighbors, pcaIntent, projectRelationsToXY, xyIntent } from './projection.js';
import { LATENT_ECOLOGY_CONFIG } from './voice-config.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const INTERVAL_SECONDS = 0.1;
const SMOOTHING_SECONDS = 4;

function result(value) {
  return deepFreeze(value);
}

function voiceResource(voice) {
  return `latent:${voice}`;
}

function sameCursor(left, right) {
  return left.x === right.x && left.y === right.y
    && left.pca.length === right.pca.length
    && left.pca.every((value, index) => value === right.pca[index]);
}

function cloneCursor(cursor) {
  return { x: cursor.x, y: cursor.y, pca: [...cursor.pca] };
}

export function createLatentRuntime({
  voiceConfig,
  mapRepository,
  audioSink,
  clock,
  leaseManager,
} = {}) {
  if (!voiceConfig || typeof mapRepository?.getInternal !== 'function'
    || typeof audioSink?.accept !== 'function' || typeof clock?.now !== 'function'
    || typeof leaseManager?.take !== 'function') {
    throw new Error('LATENT_RUNTIME_CONFIG_INVALID');
  }
  const voices = Object.keys(voiceConfig);
  if (voices.length === 0) throw new Error('LATENT_RUNTIME_CONFIG_INVALID');
  let state = Object.fromEntries(voices.map((voice) => [voice, {
    owner: 'AGENT',
    mode: 'xy',
    cursor: { x: 0, y: 0, pca: [] },
    target: { x: 0, y: 0 },
    neighbors: [],
    initialized: false,
  }]));
  let ecologyElapsed = 0;
  let lastAgentAtMs = Number(clock.now()) || 0;
  const pending = new Map();
  const cursorSequences = new Map();
  const lastUserEmitAt = new Map();

  function hasVoice(voice) {
    return typeof voice === 'string' && Object.hasOwn(voiceConfig, voice);
  }

  function publicState() {
    return deepFreeze(Object.fromEntries(voices.map((voice) => {
      const current = state[voice];
      return [voice, {
        owner: current.owner,
        mode: current.mode,
        cursor: cloneCursor(current.cursor),
        target: { ...current.target },
        neighbors: [...current.neighbors],
        control: leaseManager.getPublicState(voiceResource(voice)),
        audible: false,
        phaseGate: 'shadow-no-audio',
      }];
    })));
  }

  function commandFor(voice, current) {
    const map = mapRepository.getInternal(voice);
    if (current.mode === 'pca') {
      const intent = pcaIntent(map, current.cursor);
      return { type: 'latent.pca', voice, coeffs: intent.coeffs };
    }
    const intent = xyIntent(map, current.cursor, voiceConfig[voice].k);
    current.neighbors = [...intent.neighbors];
    return { type: 'latent.xy', voice, xy: intent.xy, k: intent.k };
  }

  function acceptAndCommit(next, changedVoices) {
    const commands = changedVoices.map((voice) => commandFor(voice, next[voice]));
    if (commands.length > 0) {
      try { audioSink.accept(deepFreeze(commands)); } catch {
        const error = new Error('AUDIO_INTENT_REJECTED');
        error.code = 'AUDIO_INTENT_REJECTED';
        throw error;
      }
    }
    state = next;
    return result({ changed: changedVoices.length > 0, audioCommands: commands });
  }

  function updateEcology(snapshot, dt) {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('LATENT_DT_INVALID');
    ecologyElapsed += dt;
    if (ecologyElapsed + 1e-9 < INTERVAL_SECONDS) {
      return result({ changed: false, audioCommands: [] });
    }
    const step = ecologyElapsed;
    ecologyElapsed = 0;
    const alpha = 1 - Math.exp(-step / SMOOTHING_SECONDS);
    const next = structuredClone(state);
    const changedVoices = [];
    for (const tree of Array.isArray(snapshot?.trees) ? snapshot.trees : []) {
      const voice = tree?.species;
      if (!hasVoice(voice)) continue;
      const target = projectRelationsToXY(
        ecologicalRelations(tree, snapshot, LATENT_ECOLOGY_CONFIG),
        voiceConfig[voice].projection,
      );
      const current = next[voice];
      current.target = { x: target.x, y: target.y };
      if (current.owner !== 'AGENT') continue;
      const cursor = current.initialized
        ? {
          x: current.cursor.x + (target.x - current.cursor.x) * alpha,
          y: current.cursor.y + (target.y - current.cursor.y) * alpha,
          pca: [],
        }
        : { x: target.x, y: target.y, pca: [] };
      const cursorChanged = !sameCursor(current.cursor, cursor) || !current.initialized;
      current.cursor = cursor;
      current.mode = 'xy';
      current.initialized = true;
      if (cursorChanged) changedVoices.push(voice);
    }
    const outcome = acceptAndCommit(next, changedVoices);
    lastAgentAtMs = Number(clock.now()) || lastAgentAtMs;
    return outcome;
  }

  function takeControl(command = {}) {
    if (!hasVoice(command.voice)) return result({ ok: false, code: 'invalid_voice' });
    const priorLease = leaseManager.get(voiceResource(command.voice));
    const lease = leaseManager.take({
      resource: voiceResource(command.voice),
      clientId: command.clientId,
      connectionGeneration: command.connectionGeneration,
      ttlMs: command.ttlMs,
    });
    if (!lease.ok) {
      if (priorLease && priorLease.expiresAt <= clock.now()
        && leaseManager.get(voiceResource(command.voice)) === null) {
        const next = structuredClone(state);
        next[command.voice].owner = 'AGENT';
        state = next;
        pending.delete(command.voice);
        clearCursorSequence(priorLease);
        return result({ ...lease, changed: true });
      }
      return lease;
    }
    if (lease.code === 'already_held') return result({ ...lease, changed: false });
    if (priorLease) clearCursorSequence(priorLease);
    const next = structuredClone(state);
    next[command.voice].owner = 'USER';
    next[command.voice].initialized = true;
    state = next;
    pending.delete(command.voice);
    cursorSequences.set(`${command.clientId}:${command.voice}`, {
      connectionGeneration: command.connectionGeneration,
      eventSeq: -1,
    });
    return result({ ...lease, changed: true });
  }

  function heartbeat(command = {}) {
    if (!hasVoice(command.voice)) return result({ ok: false, code: 'invalid_voice' });
    const priorLease = leaseManager.get(voiceResource(command.voice));
    const renewed = leaseManager.heartbeat({
      resource: voiceResource(command.voice),
      clientId: command.clientId,
      connectionGeneration: command.connectionGeneration,
      leaseToken: command.leaseToken,
    });
    if (renewed.code === 'lease_expired' && state[command.voice].owner === 'USER') {
      const next = structuredClone(state);
      next[command.voice].owner = 'AGENT';
      state = next;
      pending.delete(command.voice);
      if (priorLease) clearCursorSequence(priorLease);
      return result({ ...renewed, changed: true });
    }
    return result({ ...renewed, changed: renewed.ok === true });
  }

  function releaseControl(command = {}) {
    if (!hasVoice(command.voice)) return result({ ok: false, code: 'invalid_voice' });
    const released = leaseManager.release({
      resource: voiceResource(command.voice),
      clientId: command.clientId,
      connectionGeneration: command.connectionGeneration,
      leaseToken: command.leaseToken,
    });
    if (!released.ok || !released.released) return released;
    const next = structuredClone(state);
    next[command.voice].owner = 'AGENT';
    state = next;
    pending.delete(command.voice);
    clearCursorSequence(released.lease);
    return result({ ok: true, code: released.code, released: true, changed: true });
  }

  function owns(command) {
    const lease = leaseManager.get(voiceResource(command.voice));
    return lease && lease.expiresAt > clock.now()
      && lease.clientId === command.clientId
      && lease.connectionGeneration === command.connectionGeneration
      && lease.leaseToken === command.leaseToken;
  }

  function validCursor(cursor, maxPcaDimensions) {
    return cursor && typeof cursor === 'object'
      && Number.isFinite(cursor.x) && cursor.x >= -1 && cursor.x <= 1
      && Number.isFinite(cursor.y) && cursor.y >= -1 && cursor.y <= 1
      && Array.isArray(cursor.pca) && cursor.pca.length <= maxPcaDimensions
      && cursor.pca.every((value) => Number.isFinite(value) && value >= -1 && value <= 1);
  }

  function setCursor(command = {}) {
    if (!hasVoice(command.voice)) return result({ ok: false, code: 'invalid_voice' });
    if (!owns(command)) return result({ ok: false, code: 'lease_required' });
    const dimensions = mapRepository.getInternal(command.voice).pca_basis.dims - 2;
    if (!Number.isSafeInteger(command.eventSeq) || command.eventSeq < 0
      || !validCursor(command.cursor, dimensions)) {
      return result({ ok: false, code: 'invalid_cursor' });
    }
    const key = `${command.clientId}:${command.voice}`;
    const prior = cursorSequences.get(key);
    if (prior?.connectionGeneration === command.connectionGeneration
      && command.eventSeq <= prior.eventSeq) {
      return result({ ok: false, code: 'stale_cursor' });
    }
    cursorSequences.set(key, {
      connectionGeneration: command.connectionGeneration,
      eventSeq: command.eventSeq,
    });
    pending.set(command.voice, {
      clientId: command.clientId,
      connectionGeneration: command.connectionGeneration,
      leaseToken: command.leaseToken,
      cursor: cloneCursor(command.cursor),
    });
    return result({ ok: true, code: 'queued', changed: false });
  }

  function setMode(command = {}) {
    if (!hasVoice(command.voice) || !['xy', 'pca'].includes(command.mode)) {
      return result({ ok: false, code: 'invalid_mode' });
    }
    if (!owns(command)) return result({ ok: false, code: 'lease_required' });
    const current = state[command.voice];
    if (current.mode === command.mode) return result({ ok: true, code: 'no_change', changed: false });
    const next = structuredClone(state);
    next[command.voice].mode = command.mode;
    next[command.voice].cursor.pca = command.mode === 'pca'
      ? new Array(mapRepository.getInternal(command.voice).pca_basis.dims - 2).fill(0)
      : [];
    const outcome = acceptAndCommit(next, [command.voice]);
    pending.delete(command.voice);
    return result({ ok: true, code: 'ok', ...outcome });
  }

  function clearCursorSequence(lease) {
    if (!lease?.resource?.startsWith('latent:')) return;
    const voice = lease.resource.slice('latent:'.length);
    const key = `${lease.clientId}:${voice}`;
    const sequence = cursorSequences.get(key);
    if (sequence?.connectionGeneration === lease.connectionGeneration) {
      cursorSequences.delete(key);
    }
  }

  function returnReleasedToAgent(released) {
    let changed = false;
    const next = structuredClone(state);
    for (const lease of released) {
      clearCursorSequence(lease);
      if (!lease.resource.startsWith('latent:')) continue;
      const voice = lease.resource.slice('latent:'.length);
      if (!hasVoice(voice) || next[voice].owner !== 'USER') continue;
      next[voice].owner = 'AGENT';
      pending.delete(voice);
      changed = true;
    }
    if (changed) state = next;
    return changed;
  }

  function tick(nowMs = clock.now()) {
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('LATENT_CLOCK_INVALID');
    const expiredChanged = returnReleasedToAgent(leaseManager.expire(nowMs));
    if (expiredChanged) {
      return result({ changed: true, audioCommands: [] });
    }
    const next = structuredClone(state);
    const changedVoices = [];
    for (const [voice, queued] of pending) {
      if (!owns({ voice, ...queued })) {
        pending.delete(voice);
        continue;
      }
      const last = lastUserEmitAt.get(voice) ?? -Infinity;
      if (nowMs - last < INTERVAL_SECONDS * 1_000) continue;
      next[voice].cursor = cloneCursor(queued.cursor);
      next[voice].initialized = true;
      changedVoices.push(voice);
    }
    const agentDt = Math.max(0, (nowMs - lastAgentAtMs) / 1_000);
    if (agentDt + 1e-9 >= INTERVAL_SECONDS) {
      const alpha = 1 - Math.exp(-agentDt / SMOOTHING_SECONDS);
      for (const voice of voices) {
        const current = next[voice];
        if (current.owner !== 'AGENT' || !current.initialized) continue;
        const cursor = {
          x: current.cursor.x + (current.target.x - current.cursor.x) * alpha,
          y: current.cursor.y + (current.target.y - current.cursor.y) * alpha,
          pca: [],
        };
        if (!sameCursor(current.cursor, cursor)) {
          current.cursor = cursor;
          current.mode = 'xy';
          if (!changedVoices.includes(voice)) changedVoices.push(voice);
        }
      }
    }
    const outcome = acceptAndCommit(next, changedVoices);
    for (const voice of changedVoices) {
      if (pending.has(voice)) {
        pending.delete(voice);
        lastUserEmitAt.set(voice, nowMs);
      }
    }
    if (agentDt + 1e-9 >= INTERVAL_SECONDS) lastAgentAtMs = nowMs;
    return outcome;
  }

  function disconnect(identity) {
    const changed = returnReleasedToAgent(leaseManager.disconnect(identity));
    return result({ changed, audioCommands: [] });
  }

  return Object.freeze({
    updateEcology,
    takeControl,
    heartbeat,
    releaseControl,
    setCursor,
    setMode,
    tick,
    disconnect,
    getPublicState: publicState,
  });
}
